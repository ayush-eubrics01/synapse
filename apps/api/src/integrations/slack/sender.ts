import {
  type AIExecutionResult,
  type ClaudeJobRequest,
  JobError,
  type MessageSink,
  type MessageSource,
  type RawToolResult,
  type SendMessageCommand,
  type SendResult,
} from "@synapse/contracts";
import type { Clock } from "@synapse/shared";

export const SEND = "mcp__claude_ai_Slack__slack_send_message";

/** Search pages read when confirming delivery (R2). */
const FIND_MAX_PAGES = 2;

/** Overrides the collector default ("never send"), which would contradict this run's one job. */
const SEND_SYSTEM_PROMPT =
  "You are a message sending worker. Call only the tool you are told to, exactly once, with the exact arguments given. Never change, add or remove anything.";

const SEND_INSTRUCTION = [
  `Call the tool ${SEND} exactly once with exactly the JSON arguments in the next block.`,
  "Change nothing: do not edit, add or remove any argument or any character of the message.",
  `Call no other tool, except ToolSearch to load ${SEND} if it is not loaded yet.`,
  "Then reply DONE.",
].join("\n");

interface Deps {
  orchestrator: { run(req: ClaudeJobRequest, signal: AbortSignal): Promise<AIExecutionResult> };
  clock: Clock;
  /** The verified Phase 3 search collector (`SlackConnectorSource`), reused by `findSent`. */
  searchSource: Pick<MessageSource, "collect">;
  /** `slack.selfUserId`; `findSent` cannot attribute a message without it. */
  selfUserId: () => string | null;
  /** Latest `claude_runs.id` for a job, or null (as `workers/intelligence-shared.ts` looks it up). */
  runIdForJob?: (jobId: string) => string | null;
}

/** The exact send arguments: only channel_id, message and thread_ts (when present). */
function sendArgs(cmd: SendMessageCommand): Record<string, string> {
  return {
    channel_id: cmd.conversationExternalId,
    message: cmd.text.trimEnd(),
    ...(cmd.threadTs !== undefined ? { thread_ts: cmd.threadTs } : {}),
  };
}

/**
 * The narrow send run (ADR-032, validator rules F and I): the send tool plus ToolSearch, a system
 * part and the approved arguments as the only `user_approved` part, no untrusted parts. No
 * expectedToolNames: the provider would turn a refused or failed send into an opaque failure, and
 * this adapter classifies the raw tool results itself. The model is the collector default.
 */
export function buildSendRequest(cmd: SendMessageCommand): ClaudeJobRequest {
  return {
    ...(cmd.jobId !== undefined ? { jobId: cmd.jobId } : {}),
    workerProfile: "collector",
    priorityClass: "send",
    systemPrompt: SEND_SYSTEM_PROMPT,
    instructions: "Perform the single approved Slack send described below.",
    parts: [
      { provenance: "system", content: SEND_INSTRUCTION },
      { provenance: "user_approved", content: JSON.stringify(sendArgs(cmd)) },
    ],
    allowedTools: [SEND, "ToolSearch"],
    maxTurns: 3,
  };
}

/**
 * True when the tool_use input carries exactly the approved arguments: channel_id and thread_ts
 * exact (both absent matches), message exact after trimEnd on both sides. The only extra key
 * tolerated is `unfurl_app_links: false`; anything else (reply_broadcast, draft_id, ...) mismatches.
 */
function matchesCommand(input: unknown, cmd: SendMessageCommand): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const a = input as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (k === "channel_id" || k === "message") continue;
    if (k === "thread_ts" && cmd.threadTs !== undefined) continue;
    if (k === "unfurl_app_links" && a[k] === false) continue;
    return false;
  }
  if (a.channel_id !== cmd.conversationExternalId) return false;
  if (cmd.threadTs !== undefined && a.thread_ts !== cmd.threadTs) return false;
  return typeof a.message === "string" && a.message.trimEnd() === cmd.text.trimEnd();
}

const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The only code path that posts to Slack. Success is never read from the tool's result text (its
 * format is unknown): a send is `sent_unverified` only when exactly one send tool_result exists,
 * it is not an error and its input equals the approved arguments. Results and errors carry fixed
 * failure codes and never message text.
 */
export class SlackSender implements MessageSink {
  constructor(private readonly deps: Deps) {}

  async send(cmd: SendMessageCommand, signal: AbortSignal): Promise<SendResult> {
    const jobId = cmd.jobId;
    const before = jobId !== undefined ? this.runIdOf(jobId) : null;
    const withRun = (r: SendResult): SendResult => {
      const runId = jobId !== undefined ? this.runIdOf(jobId) : null;
      return runId !== null && runId !== before ? { ...r, runId } : r;
    };

    let result: AIExecutionResult;
    try {
      result = await this.deps.orchestrator.run(buildSendRequest(cmd), signal);
    } catch (e) {
      // After spawn the tool may have run (timeout, crash): never rethrown, so never retried.
      if (e instanceof JobError && e.classified.details?.uncertain === true) {
        return withRun({ status: "uncertain", failure: "uncertain_outcome" });
      }
      throw e; // before spawn (quota, auth, validation): nothing was sent
    }
    return withRun(this.classify(result.toolResults, cmd));
  }

  private classify(toolResults: RawToolResult[], cmd: SendMessageCommand): SendResult {
    const sends = toolResults.filter((r) => r.toolName === SEND);
    const mismatch = sends.some((r) => !matchesCommand(r.input, cmd));
    if (sends.length === 0) return { status: "failed", failure: "no_send" };
    if (sends.length > 1) {
      return {
        status: "uncertain",
        failure: "uncertain_outcome",
        ...(mismatch ? { mismatch: true } : {}),
      };
    }
    if (mismatch) return { status: "failed", failure: "argument_mismatch", mismatch: true };
    if (sends[0]?.isError) return { status: "failed", failure: "tool_error" };
    return { status: "sent_unverified" };
  }

  /**
   * R2: one incremental search (afterTs floor(sinceTs) - 1, at most 2 pages) through the verified
   * collector; a match is a message in the conversation, from self, at or after sinceTs, whose
   * whitespace-normalised text equals the command's. Null when it cannot tell: no self id, a
   * failed search, or no match in an incomplete search. Never sends.
   */
  async findSent(cmd: SendMessageCommand, sinceTs: string): Promise<boolean | null> {
    const self = this.deps.selfUserId();
    if (self === null) return null;
    const since = Number(sinceTs);
    let found: Awaited<ReturnType<Deps["searchSource"]["collect"]>>;
    try {
      found = await this.deps.searchSource.collect(
        { afterTs: String(Math.floor(since) - 1), maxPages: FIND_MAX_PAGES },
        new AbortController().signal,
      );
    } catch {
      return null;
    }
    const want = normalise(cmd.text);
    const hit = found.pages.some((p) =>
      p.messages.some(
        (m) =>
          m.conversationId === cmd.conversationExternalId &&
          m.senderId === self &&
          Number(m.ts) >= since &&
          normalise(m.text) === want,
      ),
    );
    if (hit) return true;
    return found.complete ? false : null;
  }

  private runIdOf(jobId: string): string | null {
    return this.deps.runIdForJob?.(jobId) ?? null;
  }
}
