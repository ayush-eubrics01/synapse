import {
  type AIExecutionResult,
  type ClaudeJobRequest,
  type CollectRequest,
  type CollectResult,
  JobError,
  type MessagePage,
  type MessageSource,
  type RawToolResult,
  type SourceMessage,
  type ThreadFetchRequest,
} from "@synapse/contracts";
import type { Clock } from "@synapse/shared";
import { throwIfRateLimited } from "../rate-limit";
import { parseSearchResult, SlackParseError } from "./search-parser";
import { parseThreadResult } from "./thread-parser";

export const SEARCH = "mcp__claude_ai_Slack__slack_search_public_and_private";
export const THREAD = "mcp__claude_ai_Slack__slack_read_thread";

const THREAD_LIMIT = 100;
const SKEW_SECONDS = 300;
const DAY_SECONDS = 86400;
/** R19: one search query term: no whitespace or quotes (they would change the query's meaning). */
const QUERY_TERM_RE = /^[^\s"]+$/;

interface Deps {
  orchestrator: { run(req: ClaudeJobRequest, signal: AbortSignal): Promise<AIExecutionResult> };
  clock: Clock;
}

type Args = Record<string, string | number | boolean>;

function isoDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** Primitives compare as String(value), key order is ignored, extra or missing keys mismatch (R35). */
function sameInput(actual: unknown, expected: Args): boolean {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  const a = actual as Record<string, unknown>;
  const aKeys = Object.keys(a);
  const eKeys = Object.keys(expected);
  if (aKeys.length !== eKeys.length) return false;
  for (const k of eKeys) {
    if (!Object.hasOwn(a, k)) return false;
    const v = a[k];
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return false;
    if (String(v) !== String(expected[k])) return false;
  }
  return true;
}

function parseFailed(): JobError {
  return new JobError({ kind: "parse_failed", message: "slack output format not recognised" });
}

export class SlackConnectorSource implements MessageSource {
  constructor(private readonly deps: Deps) {}

  async collect(req: CollectRequest, signal: AbortSignal): Promise<CollectResult> {
    const afterSec = Math.floor(Number(req.afterTs));
    const beforeSec = req.beforeTs ? Math.floor(Number(req.beforeTs)) : undefined;
    const terms = req.queryTerms ?? [];
    // R19: each extra term is one token, so the query stays exactly what every page must repeat.
    if (terms.some((t) => !QUERY_TERM_RE.test(t))) {
      throw new JobError({ kind: "invalid_input", message: "invalid search query term" });
    }
    const base: Args = {
      query:
        // R44: day modifiers are padded by 2 days; the unix args and the R42 window filter exactly.
        `after:${isoDay(afterSec - 2 * DAY_SECONDS)}` +
        (beforeSec !== undefined ? ` before:${isoDay(beforeSec + 2 * DAY_SECONDS)}` : "") +
        terms.map((t) => ` ${t}`).join(""),
      after: String(afterSec),
      ...(beforeSec !== undefined ? { before: String(beforeSec) } : {}),
      sort: "timestamp",
      sort_dir: "asc",
      limit: 20,
      include_bots: false,
      include_context: false,
      response_format: "detailed",
    };
    const n = req.maxPages;
    const instructions = [
      `Call the tool ${SEARCH} with exactly these arguments:`,
      JSON.stringify(base),
      `If the result's pagination_info contains a cursor and you have made fewer than ${n} calls, call ${SEARCH} again with identical arguments plus that cursor as "cursor".`,
      "Stop when there is no cursor. Reply DONE.",
    ].join("\n");

    const result = await this.deps.orchestrator.run(
      {
        workerProfile: "collector",
        priorityClass: req.beforeTs ? "backfill" : "collection",
        instructions,
        allowedTools: [SEARCH],
        // R57: no expectedToolNames. The provider would discard error tool_results (rate limits),
        // so this source enforces ADR-026 itself below.
        maxTurns: n + 3,
        ...(req.jobId ? { jobId: req.jobId } : {}),
      },
      signal,
    );

    const searchResults = result.toolResults.filter((r) => r.toolName === SEARCH);
    try {
      return this.buildResult(req, base, searchResults);
    } catch (e) {
      // Q2: a failed run still spent searches; the worker counts them.
      if (e instanceof JobError) {
        throw new JobError({
          ...e.classified,
          details: { ...e.classified.details, searches: searchResults.length },
        });
      }
      throw e;
    }
  }

  private buildResult(
    req: CollectRequest,
    base: Args,
    searchResults: RawToolResult[],
  ): CollectResult {
    const afterSec = Math.floor(Number(req.afterTs));
    const beforeSec = req.beforeTs ? Math.floor(Number(req.beforeTs)) : undefined;
    const n = req.maxPages;
    this.throwIfRateLimited(searchResults);
    if (searchResults.length === 0) {
      throw new JobError({ kind: "incomplete_ai_output", message: "no search tool result" });
    }

    const upper = beforeSec !== undefined ? Number(req.beforeTs) : this.nowSec() + SKEW_SECONDS;
    const lower = afterSec;
    const pages: MessagePage[] = [];
    let cut = false;
    let sawFirstMismatch = false;
    for (const r of searchResults) {
      if (r.isError || cut) continue;
      if (pages.length >= n) {
        cut = true;
        continue;
      }
      const prev = pages[pages.length - 1];
      let expected: Args = base;
      if (prev) {
        if (prev.nextCursor === undefined) {
          cut = true;
          continue;
        }
        expected = { ...base, cursor: prev.nextCursor };
      }
      if (!sameInput(r.input, expected)) {
        cut = true;
        if (!prev) sawFirstMismatch = true;
        continue;
      }
      let page: MessagePage;
      try {
        page = parseSearchResult(r.content);
      } catch (e) {
        if (e instanceof SlackParseError) throw parseFailed();
        throw e;
      }
      const kept = page.messages.filter((m) => {
        const t = Number(m.ts);
        return t >= lower && t <= upper;
      });
      pages.push({
        messages: kept,
        rejected: page.rejected + (page.messages.length - kept.length),
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      });
    }

    if (pages.length === 0) {
      if (searchResults.every((r) => r.isError)) {
        // R57: only non-rate error results: a real tool failure, retried.
        throw new JobError({ kind: "provider_error", message: "slack search returned an error" });
      }
      throw new JobError({
        kind: "incomplete_ai_output",
        message: sawFirstMismatch
          ? "first search call did not match the requested arguments"
          : "no usable search result",
      });
    }
    const last = pages[pages.length - 1];
    return {
      pages,
      searches: searchResults.length,
      complete: !cut && last?.nextCursor === undefined,
    };
  }

  async fetchThreads(
    requests: ThreadFetchRequest[],
    signal: AbortSignal,
  ): Promise<
    { conversationId: string; parentTs: string; messages: SourceMessage[]; rejected: number }[]
  > {
    const wanted = new Map<string, ThreadFetchRequest>();
    for (const r of requests) wanted.set(`${r.conversationId}\u0000${r.parentTs}`, r);
    const unique = [...wanted.values()];
    if (unique.length === 0) return [];
    const jobId = requests.find((r) => r.jobId)?.jobId;

    const argsOf = (r: ThreadFetchRequest): Args => ({
      channel_id: r.conversationId,
      message_ts: r.parentTs,
      limit: THREAD_LIMIT,
    });
    const instructions = [
      `Call the tool ${THREAD} once for each of these argument sets, exactly as written:`,
      ...unique.map((r) => JSON.stringify(argsOf(r))),
      "Then reply DONE.",
    ].join("\n");

    const result = await this.deps.orchestrator.run(
      {
        workerProfile: "collector",
        priorityClass: "collection",
        instructions,
        allowedTools: [THREAD],
        // R57: no expectedToolNames (see collect); enforced below.
        maxTurns: unique.length + 3,
        ...(jobId ? { jobId } : {}),
      },
      signal,
    );

    const threadResults = result.toolResults.filter((r) => r.toolName === THREAD);
    this.throwIfRateLimited(threadResults);
    // R57: a pair is only ever "unavailable" after a real tool result; none at all is a failed run.
    if (threadResults.length === 0) {
      throw new JobError({ kind: "incomplete_ai_output", message: "no thread tool result" });
    }

    const keyOf = (r: ThreadFetchRequest) => `${r.conversationId}\u0000${r.parentTs}`;
    // R62: a pair may end up "unavailable" (error, parse drop, parent mismatch) only when some
    // THREAD result's input matches it; a pair nobody answered is a failed run, retried.
    const matched = new Set<string>();
    for (const r of threadResults) {
      const req = unique.find((u) => sameInput(r.input, argsOf(u)));
      if (req) matched.add(keyOf(req));
    }
    if (unique.some((u) => !matched.has(keyOf(u)))) {
      throw new JobError({
        kind: "incomplete_ai_output",
        message: "a requested thread has no matching tool result",
      });
    }

    const maxTs = this.nowSec() + SKEW_SECONDS;
    const answered = new Set<string>();
    const out: {
      conversationId: string;
      parentTs: string;
      messages: SourceMessage[];
      rejected: number;
    }[] = [];
    for (const r of threadResults) {
      if (r.isError) continue;
      const req = unique.find((u) => sameInput(r.input, argsOf(u)));
      if (!req) continue;
      const key = keyOf(req);
      if (answered.has(key)) continue;
      answered.add(key);
      let parsed: { messages: SourceMessage[]; rejected: number };
      try {
        parsed = parseThreadResult(r.content, req.conversationId);
      } catch (e) {
        if (e instanceof SlackParseError) continue; // R45: drop only this thread
        throw e;
      }
      const parent = parsed.messages[0];
      if (!parent || parent.ts !== req.parentTs) continue;
      const parentNum = Number(req.parentTs);
      const messages = parsed.messages.filter((m, i) => {
        if (i === 0) return true;
        const t = Number(m.ts);
        return t >= parentNum && t <= maxTs;
      });
      out.push({
        conversationId: req.conversationId,
        parentTs: req.parentTs,
        messages,
        rejected: parsed.rejected + (parsed.messages.length - messages.length),
      });
    }
    return out;
  }

  private nowSec(): number {
    return this.deps.clock.now().getTime() / 1000;
  }

  private throwIfRateLimited(results: RawToolResult[]): void {
    throwIfRateLimited(results, this.deps.clock.now(), "slack rate limited");
  }
}
