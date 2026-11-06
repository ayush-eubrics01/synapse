import type { DomainEvent, EventType } from "@synapse/contracts";
import { schema, type Tx } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { and, eq, gt, sql } from "drizzle-orm";
import type { SettingsService } from "../../core/config/settings";
import type { AutoReplyService } from "../auto-reply/service";
import type { PeopleService } from "../people/service";
import type { CodeAnswerService } from "./service";

const { codeAnswers, repositories, projects, projectRepositories } = schema;
const DAY_MS = 86_400_000;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive, literal, whole-word: not preceded or followed by a letter, digit or `_`. */
function names(text: string, name: string): boolean {
  const n = name.trim();
  if (n === "") return false;
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(n)}(?![A-Za-z0-9_])`, "i").test(text);
}

/**
 * C6: the one repository a message names, or null. A registered repository counts by its name; an
 * Engineering Brain project counts by its name only when it links exactly one repository. The
 * result is that id only when exactly one distinct repository matched (a repository named twice,
 * or once directly and once through its project, is one). Pure.
 */
export function matchRepository(
  text: string,
  repos: { id: string; name: string }[],
  projectList: { name: string; repositoryIds: string[] }[],
): string | null {
  const matched = new Set<string>();
  for (const r of repos) if (names(text, r.name)) matched.add(r.id);
  for (const p of projectList) {
    const linked = [...new Set(p.repositoryIds)];
    if (linked.length === 1 && names(text, p.name)) matched.add(linked[0] as string);
  }
  return matched.size === 1 ? ([...matched][0] as string) : null;
}

export interface AwayCodeAnswerTriggerDeps {
  clock: Clock;
  settings: Pick<SettingsService, "get">;
  autoReply: Pick<AutoReplyService, "codeAnswerPreCheck">;
  people: Pick<PeopleService, "getPriorityBySlackUser">;
  codeAnswers: Pick<CodeAnswerService, "create">;
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

/**
 * `code_answer.away` consumer of `message.received` (C6): while away, a priority person's question
 * that names exactly one repository queues one `away` code answer, at most
 * `codeAnswer.away.maxRunsPerDay` in a rolling 24 hours. Anything else writes nothing: the message
 * stays in the normal flow. Never throws; logs ids only (never message text).
 */
export class AwayCodeAnswerTrigger {
  constructor(private readonly deps: AwayCodeAnswerTriggerDeps) {}

  onMessageReceived(event: DomainEvent<EventType>, tx: Tx): void {
    const messageId = (event.payload as { messageId?: unknown }).messageId;
    if (typeof messageId !== "string") return;
    try {
      // Savepoint: a failure rolls back this consumer's writes only.
      tx.transaction((sp) => this.consider(messageId, sp));
    } catch (e) {
      console.error(`code answer away trigger failed message=${messageId} error=${errorName(e)}`);
    }
  }

  /** The C6 conditions, cheapest first; the first that fails stops (nothing written). */
  private consider(messageId: string, tx: Tx): void {
    const { settings, autoReply, people, codeAnswers: service, clock } = this.deps;
    if (!settings.get("autoReply.awayMode")) return;
    if (!settings.get("autoReply.allowedKinds").includes("code_answer")) return;
    if (!settings.get("codeAnswer.away.enabled")) return;
    const pre = autoReply.codeAnswerPreCheck(tx, messageId);
    if (!pre.ok) return;
    const { priority } = people.getPriorityBySlackUser(pre.sender);
    if (priority !== "high" && priority !== "critical") return;
    if (!pre.text.includes("?")) return;
    const repos = tx
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .all();
    const links = new Map<string, { name: string; repositoryIds: string[] }>();
    for (const l of tx
      .select({
        projectId: projects.id,
        name: projects.name,
        repositoryId: projectRepositories.repositoryId,
      })
      .from(projects)
      .innerJoin(projectRepositories, eq(projectRepositories.projectId, projects.id))
      .all()) {
      const p = links.get(l.projectId) ?? { name: l.name, repositoryIds: [] };
      p.repositoryIds.push(l.repositoryId);
      links.set(l.projectId, p);
    }
    const repositoryId = matchRepository(pre.text, repos, [...links.values()]);
    if (repositoryId === null) return;
    const since = new Date(clock.now().getTime() - DAY_MS).toISOString();
    const [{ n }] = tx
      .select({ n: sql<number>`count(*)` })
      .from(codeAnswers)
      .where(and(eq(codeAnswers.trigger, "away"), gt(codeAnswers.createdAt, since)))
      .all() as [{ n: number }];
    if (n >= settings.get("codeAnswer.away.maxRunsPerDay")) return;
    service.create(tx, { messageId, repositoryId, trigger: "away" });
  }
}
