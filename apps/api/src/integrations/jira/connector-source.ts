import {
  type AIExecutionResult,
  type ClaudeJobRequest,
  JIRA_FIELDS,
  JIRA_TOOL_RESOURCES,
  JIRA_TOOL_SEARCH,
  JobError,
  type RawToolResult,
  type SourceIssue,
} from "@synapse/contracts";
import type { Clock } from "@synapse/shared";
import { throwIfRateLimited } from "../rate-limit";
import { JiraParseError, parseResources, parseSearchResult } from "./parse";

interface Deps {
  clock: Clock;
  orchestrator: { run(req: ClaudeJobRequest, signal: AbortSignal): Promise<AIExecutionResult> };
}

export interface SearchPageArgs {
  cloudId: string;
  jql: string;
  maxResults: number;
  nextPageToken?: string;
}

/** Extra keys the connector adds to a tool call, each with exactly this value (spec B3). */
type Tolerated = Readonly<Record<string, string>>;
const RESOLVE_TOLERATED: Tolerated = {
  responseContentFormat: "markdown",
  actionSource: "model_tool_call",
};
const SEARCH_TOLERATED: Tolerated = { ...RESOLVE_TOLERATED, searchResultMode: "issues" };

const incomplete = (message: string): JobError =>
  new JobError({ kind: "incomplete_ai_output", message });

function sameSet(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  if (!a.every((x) => typeof x === "string")) return false;
  const s = new Set<string>(a);
  return s.size === b.length && b.every((x) => s.has(x));
}

/** Exact match on the requested args; only the tolerated extras may be added (R35, spec B3). */
function inputMatches(
  actual: unknown,
  expected: Record<string, unknown>,
  tolerated: Tolerated,
): boolean {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  const a = actual as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (Object.hasOwn(expected, k)) continue;
    if (!Object.hasOwn(tolerated, k) || a[k] !== tolerated[k]) return false;
  }
  for (const [k, v] of Object.entries(expected)) {
    if (!Object.hasOwn(a, k)) return false;
    if (k === "fields") {
      if (!sameSet(a[k], v as readonly string[])) return false;
    } else if (a[k] !== v) return false;
  }
  return true;
}

export class JiraConnectorSource {
  constructor(private readonly deps: Deps) {}

  async resolveCloudId(signal: AbortSignal): Promise<{ id: string; url: string; name: string }[]> {
    const raw = await this.runOne(
      JIRA_TOOL_RESOURCES,
      {},
      RESOLVE_TOLERATED,
      [
        `Call the tool ${JIRA_TOOL_RESOURCES} exactly once, with no arguments.`,
        "Make no other tool call, except ToolSearch to load it if needed. Reply DONE.",
      ],
      signal,
    );
    try {
      return parseResources(raw.content);
    } catch (e) {
      if (e instanceof JiraParseError) throw parseFailed();
      throw e;
    }
  }

  async searchPage(
    args: SearchPageArgs,
    signal: AbortSignal,
  ): Promise<{ issues: SourceIssue[]; nextPageToken: string | null; total: number | null }> {
    const wanted: Record<string, unknown> = {
      cloudId: args.cloudId,
      jql: args.jql,
      fields: [...JIRA_FIELDS],
      maxResults: args.maxResults,
      ...(args.nextPageToken !== undefined ? { nextPageToken: args.nextPageToken } : {}),
    };
    const raw = await this.runOne(
      JIRA_TOOL_SEARCH,
      wanted,
      SEARCH_TOLERATED,
      [
        `Call the tool ${JIRA_TOOL_SEARCH} exactly once, with exactly these arguments:`,
        JSON.stringify(wanted),
        "Make no other tool call, except ToolSearch to load it if needed. Reply DONE.",
      ],
      signal,
    );
    try {
      return parseSearchResult(raw.content);
    } catch (e) {
      if (e instanceof JiraParseError) throw parseFailed();
      throw e;
    }
  }

  /** One collector run; returns the single trusted, argument-matching, non-error tool result. */
  private async runOne(
    tool: string,
    expected: Record<string, unknown>,
    tolerated: Tolerated,
    lines: string[],
    signal: AbortSignal,
  ): Promise<RawToolResult> {
    const result = await this.deps.orchestrator.run(
      {
        workerProfile: "collector",
        priorityClass: "collection",
        instructions: lines.join("\n"),
        allowedTools: [tool, "ToolSearch"],
        model: "haiku",
        maxTurns: 4,
      },
      signal,
    );
    const results = result.toolResults.filter((r) => r.toolName === tool);
    throwIfRateLimited(results, this.deps.clock.now(), "jira rate limited");
    const [only] = results;
    if (!only) throw incomplete("no jira tool result");
    if (results.length > 1) throw incomplete("unexpected number of jira tool results");
    if (!inputMatches(only.input, expected, tolerated)) {
      throw incomplete("jira tool call did not match the requested arguments");
    }
    // The CLI swaps a result it finds too large for a notice. Retrying the same page gets the same
    // notice, so this parks for a person (lower jira.pageSize) instead of looping.
    if (isOversizedNotice(only.content)) {
      throw new JobError({ kind: "output_too_large", message: "jira tool output too large" });
    }
    if (only.isError) throw incomplete("jira tool returned an error");
    return only;
  }
}

/** The text of a tool result: the raw string, or the joined MCP text blocks it encodes. */
function resultText(content: string): string {
  try {
    const v: unknown = JSON.parse(content);
    if (
      Array.isArray(v) &&
      v.every((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text")
    ) {
      return v.map((b) => String((b as { text?: unknown }).text ?? "")).join("");
    }
  } catch {
    // Not JSON: the raw string is the text.
  }
  return content;
}

/**
 * Claude Code's replacements for an oversized MCP result (measured 2026-11-06): an
 * `Error: result (N characters) exceeds maximum allowed tokens...` notice, or, past
 * `MAX_MCP_OUTPUT_TOKENS`, a `<persisted-output>` block.
 */
export function isOversizedNotice(content: string): boolean {
  const t = resultText(content).trimStart();
  return (
    (t.startsWith("Error: result (") && t.includes("exceeds maximum allowed tokens")) ||
    t.startsWith("<persisted-output>")
  );
}

function parseFailed(): JobError {
  return new JobError({ kind: "parse_failed", message: "jira output format not recognised" });
}
