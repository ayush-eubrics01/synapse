export interface SendMessageCommand {
  outgoingId: string;
  approvalId: string;
  conversationExternalId: string;
  threadTs?: string;
  text: string;
  /** The queue job driving the send; recorded as claude_runs.job_id and used to find the run id. */
  jobId?: string;
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
  send(cmd: SendMessageCommand, signal: AbortSignal): Promise<SendResult>;
  /**
   * true/false when the message was or was not found after `sinceTs`; null when it could not be
   * checked. R18: throws the `auth_paused`, `quota_exhausted` or `rate_limited` JobError so the
   * caller's job is deferred without counting a verification attempt.
   */
  findSent(cmd: SendMessageCommand, sinceTs: string): Promise<boolean | null>;
}
