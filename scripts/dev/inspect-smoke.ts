import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobError } from "@synapse/contracts";
import { createContainer } from "../../apps/api/src/container";
import { loadConfig } from "../../apps/api/src/core/config/config";
import { LocalGitProvider } from "../../apps/api/src/integrations/repository/local-git";
import {
  buildInspectRequest,
  parseInspection,
} from "../../apps/api/src/intelligence/brain/inspect-prompt";
import { hasInspectionToolResult } from "../../apps/api/src/modules/engineering-brain/evidence";
import type { InspectionSummary } from "../../apps/api/src/modules/engineering-brain/inspection";
import { RepositoryRegistry } from "../../apps/api/src/modules/engineering-brain/registry";

export const USAGE = `Usage: bun scripts/dev/inspect-smoke.ts [--help]

Creates a throwaway git repo (3 tiny invented files, one commit) in a temp dir, registers it
on a temporary database, and runs ONE real read-only inspection with haiku (Phase 9, C6).
Spends a little Claude quota; run deliberately. Prints counts and statuses only, never
fact text, paths or file content. Deletes everything afterwards.`;

/** Sorted `reason=count` pairs for non-zero counts, or `none`. */
export function formatDropped(dropped: Partial<Record<string, number>>): string {
  const parts = Object.entries(dropped)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}=${n}`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

export function summarizeInspect(status: string, s: InspectionSummary | null): string[] {
  const lines = [`status: ${status}`];
  if (s) {
    lines.push(
      `proposed: ${s.proposed}`,
      `inserted: ${s.inserted}`,
      `dropped: ${formatDropped(s.dropped)}`,
    );
  }
  return lines;
}

const FILES: Record<string, string> = {
  "README.md": "# Demo todo service\n\nA tiny demo service that stores todo items in memory.\n",
  "package.json":
    '{\n  "name": "demo-todo",\n  "version": "0.0.1",\n  "scripts": { "start": "bun src/server.ts" }\n}\n',
  "src/server.ts":
    "const todos: string[] = [];\nBun.serve({ port: 3000, fetch: () => Response.json(todos) });\n",
};

function git(cwd: string, home: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", ...args],
    { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }, stdio: "ignore" },
  );
}

async function main(): Promise<number> {
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
    console.log(USAGE);
    return 0;
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "synapse-inspect-")));
  const fakeHome = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(fakeHome);
  mkdirSync(join(repo, "src"), { recursive: true });
  for (const [name, text] of Object.entries(FILES)) writeFileSync(join(repo, name), text);
  git(repo, fakeHome, "init", "-b", "main");
  git(repo, fakeHome, "add", ".");
  git(repo, fakeHome, "commit", "-m", "init");

  const config = { ...loadConfig(process.env), dbPath: join(dir, "smoke.db") };
  const c = createContainer(config);
  const signal = new AbortController().signal;
  try {
    c.settings.set("brain.inspect.model", "haiku");
    // The path rules judge the repo against this HOME; Claude itself keeps the real one.
    const registry = new RepositoryRegistry({
      db: c.db,
      clock: c.clock,
      audit: c.audit,
      events: c.events,
      provider: new LocalGitProvider({ home: fakeHome }),
    });
    const view = await registry.register({
      path: repo,
      name: "demo-todo",
      trackedBranch: "main",
      environments: [],
      jiraProjectKeys: [],
    });
    const prepared = await c.inspections.prepare(view.id);
    if (!prepared.ok) {
      console.log(`status: not_prepared (${prepared.reason})`);
      return 1;
    }
    const { target } = prepared;
    // The smoke has no queued job; a claude_runs row must not reference a made-up job id.
    const { jobId: _noJob, ...request } = buildInspectRequest(
      { name: target.name, localPath: target.localPath },
      "inspect-smoke",
      {
        model: c.settings.get("brain.inspect.model"),
        maxTurns: c.settings.get("brain.inspect.maxTurns"),
        timeoutMinutes: c.settings.get("brain.inspect.timeoutMinutes"),
      },
    );
    let result: Awaited<ReturnType<typeof c.orchestrator.run>>;
    try {
      result = await c.orchestrator.run(request, signal);
    } catch (e) {
      console.log(`status: run_failed (${e instanceof JobError ? e.classified.kind : "error"})`);
      return 1;
    }
    console.log(`turns: ${result.numTurns}`);
    console.log(`permissionDenials: ${result.permissionDenials.length}`);
    if (!hasInspectionToolResult(result.toolResults)) {
      // ADR-026: a run that read nothing is not evidence of anything.
      console.log("status: run_failed (incomplete_ai_output)");
      return 1;
    }
    const parsed = parseInspection(result.finalText);
    if (!parsed.ok) {
      for (const l of summarizeInspect("parse_failed", null)) console.log(l);
      return 1;
    }
    const summary = c.inspections.record({
      target,
      output: parsed.value,
      claudeRunId: null,
      permissionDenials: result.permissionDenials,
      toolResults: result.toolResults,
    });
    if ("skipped" in summary) {
      console.log("status: skipped");
      return 1;
    }
    for (const l of summarizeInspect("succeeded", summary)) console.log(l);
    return 0;
  } finally {
    c.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
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
