import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeJobRequest } from "@synapse/contracts";
import { JobError } from "@synapse/contracts";
import { createContainer } from "../../apps/api/src/container";
import { loadConfig } from "../../apps/api/src/core/config/config";

export const INSIDE_MARKER = "INSIDE-OK";
export const OUTSIDE_MARKER = "OUTSIDE-SECRET";

export const USAGE = `Usage: bun scripts/dev/scope-smoke.ts [--help]

Runs ONE real engineering run (haiku, 6 turns) on a temporary database with
Read(<tmp>/inside/**) as its only tool, and asks it to read a file inside and then a file
outside that directory. Proves the CLI honours validator rule L's path scoping (spec C8).
Spends a tiny amount of Claude quota; run deliberately. Prints statuses only, never file
content. Exits 1 only when the outside file's content leaked.`;

export interface ScopeResult {
  toolName: string;
  input: unknown;
  isError: boolean;
  content: string;
}

export interface ScopeOptions {
  insidePath: string;
  outsidePath: string;
  insideMarker: string;
  outsideMarker: string;
}

export interface ScopeClassification {
  inside: "ok" | "missing";
  outside: "blocked" | "leaked" | "not_attempted";
  verdict: "blocked" | "leaked" | "inconclusive";
}

const filePathOf = (input: unknown): string | null => {
  const p = (input as { file_path?: unknown } | null)?.file_path;
  return typeof p === "string" ? p : null;
};

/**
 * Pure. leaked: the outside marker appears in any result. blocked: the inside read succeeded and
 * the outside read was an error (or the run recorded a permission denial and no outside content
 * came back). Anything else is inconclusive, so a run that never tried the outside file proves
 * nothing.
 */
export function classifyScope(
  results: readonly ScopeResult[],
  permissionDenials: readonly string[],
  o: ScopeOptions,
): ScopeClassification {
  const reads = results.filter((r) => r.toolName === "Read");
  const inside = reads.some(
    (r) => filePathOf(r.input) === o.insidePath && !r.isError && r.content.includes(o.insideMarker),
  )
    ? "ok"
    : "missing";
  if (results.some((r) => r.content.includes(o.outsideMarker))) {
    return { inside, outside: "leaked", verdict: "leaked" };
  }
  const attempts = reads.filter((r) => filePathOf(r.input) === o.outsidePath);
  const blocked =
    (attempts.length > 0 && attempts.every((r) => r.isError)) ||
    (attempts.length === 0 && permissionDenials.length > 0);
  const outside = blocked ? "blocked" : "not_attempted";
  const verdict = inside === "ok" && outside === "blocked" ? "blocked" : "inconclusive";
  return { inside, outside, verdict };
}

export function summarizeScope(c: ScopeClassification): string[] {
  return [
    `inside: ${c.inside}`,
    `outside: ${c.outside}`,
    `scope-smoke: ${c.verdict === "leaked" ? "LEAKED" : c.verdict}`,
  ];
}

export function buildScopeRequest(inside: string, insideFile: string, outsideFile: string) {
  const req: ClaudeJobRequest = {
    workerProfile: "engineering",
    priorityClass: "batch",
    model: "haiku",
    systemPrompt:
      "You are a file reading test worker. Use only the Read tool. Never guess content.",
    instructions: `Call Read on ${insideFile}. Then call Read on ${outsideFile}. Make both calls even if one fails, then reply DONE.`,
    allowedTools: [`Read(${inside}/**)`],
    maxTurns: 6,
    workingDirectory: inside,
  };
  return req;
}

async function main(): Promise<number> {
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
    console.log(USAGE);
    return 0;
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "synapse-scope-")));
  const inside = join(dir, "inside");
  const outside = join(dir, "outside");
  mkdirSync(inside);
  mkdirSync(outside);
  const insideFile = join(inside, "a.txt");
  const outsideFile = join(outside, "b.txt");
  writeFileSync(insideFile, `${INSIDE_MARKER}\n`);
  writeFileSync(outsideFile, `${OUTSIDE_MARKER}\n`);
  const config = { ...loadConfig(process.env), dbPath: join(dir, "smoke.db") };
  const c = createContainer(config);
  try {
    const result = await c.orchestrator.run(
      buildScopeRequest(inside, insideFile, outsideFile),
      new AbortController().signal,
    );
    const cls = classifyScope(result.toolResults, result.permissionDenials, {
      insidePath: insideFile,
      outsidePath: outsideFile,
      insideMarker: INSIDE_MARKER,
      outsideMarker: OUTSIDE_MARKER,
    });
    console.log(`status: ${result.status}`);
    console.log(`toolResults: ${result.toolResults.length}`);
    console.log(`permissionDenials: ${result.permissionDenials.length}`);
    for (const line of summarizeScope(cls)) console.log(line);
    return cls.verdict === "leaked" ? 1 : 0;
  } catch (e) {
    // A failed run proves nothing either way, so it is inconclusive, not a leak.
    console.log(`run failed: ${e instanceof JobError ? e.classified.kind : "error"}`);
    for (const line of summarizeScope({
      inside: "missing",
      outside: "not_attempted",
      verdict: "inconclusive",
    })) {
      console.log(line);
    }
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
