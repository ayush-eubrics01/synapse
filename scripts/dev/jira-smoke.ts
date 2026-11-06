import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobError, type SourceIssue } from "@synapse/contracts";
import { createContainer } from "../../apps/api/src/container";
import { loadConfig } from "../../apps/api/src/core/config/config";
import { NoopDesktopNotifier } from "../../apps/api/src/infrastructure/notifier";
import { JiraConnectorSource } from "../../apps/api/src/integrations/jira/connector-source";
import { withExclusions } from "../../apps/api/src/modules/jira-tracking/jql";

export const USAGE = `Usage: bun scripts/dev/jira-smoke.ts [--cloud-id ID] [--jql JQL]

Runs the real Jira read path through Claude on a temporary database: one cloudId lookup, then ONE
page (20 issues at most) of the configured scope, and prints counts only. Spends a little Claude
quota and reads real Jira; run deliberately. Never prints issue keys, summaries, site names,
cloud ids or JQL. The temporary database is deleted afterwards.

  --cloud-id ID   use this cloudId (required when the account has more than one Jira site)
  --jql JQL       search this JQL instead of the default scope`;

export class UsageError extends Error {}

export interface Args {
  cloudId?: string;
  jql?: string;
}

const CLOUD_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

export function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const name = a.startsWith("--cloud-id") ? "cloud-id" : a.startsWith("--jql") ? "jql" : null;
    if (name === null || (a !== `--${name}` && !a.startsWith(`--${name}=`))) {
      throw new UsageError(`unknown argument: ${a}`);
    }
    let value: string | undefined;
    if (a === `--${name}`) {
      value = argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
    } else value = a.slice(name.length + 3);
    if (value === "") throw new UsageError(`--${name} needs a value`);
    if (name === "cloud-id") {
      if (!CLOUD_ID_RE.test(value)) throw new UsageError("--cloud-id is not a valid cloud id");
      out.cloudId = value;
    } else out.jql = value;
  }
  return out;
}

/** Removes the temp dir; used by the finally block and by the signal handlers. */
export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Counts only. Keys, summaries, project keys and URLs never reach the output. */
export function summarize(
  issues: readonly SourceIssue[],
  meta: { sites: number; hasNextPage: boolean },
): string[] {
  const by = { new: 0, indeterminate: 0, done: 0 };
  for (const i of issues) by[i.statusCategory]++;
  return [
    `sites: ${meta.sites}`,
    `issues: ${issues.length}`,
    `hasNextPage: ${meta.hasNextPage}`,
    `statusCategory: new=${by.new} indeterminate=${by.indeterminate} done=${by.done}`,
    `projects: ${new Set(issues.map((i) => i.projectKey)).size}`,
  ];
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  const dir = mkdtempSync(join(tmpdir(), "synapse-jira-smoke-"));
  const onSignal = (code: number) => () => {
    cleanupDir(dir);
    process.exit(code);
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
  let sqlite: { close(): void } | undefined;
  try {
    const config = { ...loadConfig(process.env), dbPath: join(dir, "smoke.db") };
    const c = createContainer(config, { notifier: new NoopDesktopNotifier() });
    sqlite = c.sqlite;
    const source = new JiraConnectorSource({ orchestrator: c.orchestrator, clock: c.clock });
    const signal = new AbortController().signal;
    try {
      const sites = await source.resolveCloudId(signal);
      let cloudId = args.cloudId;
      if (cloudId === undefined) {
        const [only] = sites;
        if (sites.length !== 1 || !only) {
          console.log(`sites: ${sites.length}`);
          console.error("expected exactly one Jira site; pass --cloud-id");
          return 1;
        }
        cloudId = only.id;
      }
      const jql =
        args.jql ??
        `${withExclusions(c.settings.get("jira.scope.jql"), c.settings.get("jira.excludedProjects"))} ORDER BY updated ASC`;
      const page = await source.searchPage({ cloudId, jql, maxResults: 20 }, signal);
      for (const line of summarize(page.issues, {
        sites: sites.length,
        hasNextPage: page.nextPageToken !== null,
      })) {
        console.log(line);
      }
      return 0;
    } catch (e) {
      console.error(`run: error (${e instanceof JobError ? e.classified.kind : "unknown"})`);
      return 1;
    }
  } finally {
    sqlite?.close();
    cleanupDir(dir);
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`smoke failed: ${e instanceof Error ? e.constructor.name : "error"}`);
      process.exit(1);
    },
  );
}
