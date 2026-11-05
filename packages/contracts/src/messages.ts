import { z } from "zod";

export type ConversationType = "im" | "mpim" | "channel";

export const conversationTypeSchema = z.enum(["im", "mpim", "channel"]);

export const sourceMessageSchema = z
  .object({
    externalId: z.string(),
    conversationId: z.string().regex(/^[CDG][A-Z0-9]+$/),
    conversationType: conversationTypeSchema,
    conversationName: z.string().optional(),
    ts: z.string().regex(/^\d{10}\.\d{6}$/),
    threadTs: z.string().optional(),
    senderId: z.string().regex(/^U[A-Z0-9]+$/),
    senderName: z.string().optional(),
    senderEmail: z.string().optional(),
    text: z.string(),
    fullNotes: z.string().optional(),
    permalink: z.string().optional(),
    replyCount: z.number().int().nonnegative().optional(),
    sentAt: z.string(),
  })
  .refine((m) => m.externalId === `${m.conversationId}:${m.ts}`, {
    message: "externalId must equal conversationId:ts",
    path: ["externalId"],
  });

export type SourceMessage = z.infer<typeof sourceMessageSchema>;

export interface MessagePage {
  messages: SourceMessage[];
  rejected: number;
  nextCursor?: string;
}

export interface CollectRequest {
  afterTs: string;
  beforeTs?: string;
  maxPages: number;
}

export interface CollectResult {
  pages: MessagePage[];
  searches: number;
  /** No next cursor after the last accepted page. */
  complete: boolean;
}

export interface ThreadFetchRequest {
  conversationId: string;
  parentTs: string;
}

export interface MessageSource {
  collect(req: CollectRequest, signal: AbortSignal): Promise<CollectResult>;
  fetchThreads(
    requests: ThreadFetchRequest[],
    signal: AbortSignal,
  ): Promise<
    { conversationId: string; parentTs: string; messages: SourceMessage[]; rejected: number }[]
  >;
}
