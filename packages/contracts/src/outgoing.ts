export interface SendMessageCommand {
  outgoingId: string;
  approvalId: string;
  conversationExternalId: string;
  threadTs?: string;
  text: string;
}

export interface SendResult {
  status: "sent_unverified" | "failed" | "uncertain";
  /** Content-free reason. */
  failure?: string;
}

/** The port a send executor uses to post an approved message. */
export interface MessageSink {
  send(cmd: SendMessageCommand, signal: AbortSignal): Promise<SendResult>;
  /** true/false when the message was or was not found after `sinceTs`; null when it could not be checked. */
  findSent(cmd: SendMessageCommand, sinceTs: string): Promise<boolean | null>;
}
