export interface SendMessageCommand {
  outgoingId: string;
  approvalId: string;
  conversationExternalId: string;
  threadTs?: string;
  text: string;
  /** The queue job driving the send; recorded as claude_runs.job_id and used to find the run id. */
  jobId?: string;
  /**
   * Who authorised the text: the user (default) or a deterministic policy (ADR-033 auto-replies).
   * Sets the send run's provenance to `user_approved` or `policy_approved` (J1).
   */
  authorisedBy?: "user" | "policy";
}

/** Per-send options, passed through to `orchestrator.run` (see `RunOptions`). */
export interface SendOptions {
  /** false cancels the send before Claude spawns: the sink rethrows `cancelled_before_spawn`. */
  beforeSpawn?: () => boolean;
}

export interface SendResult {
  status: "sent_unverified" | "failed" | "uncertain";
  /** Content-free reason: `no_send`, `argument_mismatch`, `tool_error` or `uncertain_outcome`. */
  failure?: string;
  /** The send tool was called with arguments other than the approved ones; raise a high flag. */
  mismatch?: boolean;
  /** The Claude run that performed the send, when one was recorded for `jobId`. */
  runId?: string;
}

/** The port a send executor uses to post an approved message. */
export interface MessageSink {
  send(cmd: SendMessageCommand, signal: AbortSignal, opts?: SendOptions): Promise<SendResult>;
  /**
   * true/false when the message was or was not found after `sinceTs`; null when it could not be
   * checked. R18: throws the `auth_paused`, `quota_exhausted` or `rate_limited` JobError so the
   * caller's job is deferred without counting a verification attempt.
   */
  findSent(cmd: SendMessageCommand, sinceTs: string): Promise<boolean | null>;
}
