import {
  type ConversationType,
  type MessagePage,
  type SourceMessage,
  sourceMessageSchema,
} from "@synapse/contracts";

/** Connector output no longer matches the known format (drift), not a bad single message. */
export class SlackParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackParseError";
  }
}

const BLOCK_START = /^### Result \d+ of \d+$/;
const FROM = /^From: (.*) <([^>]*)> \(ID: (U[A-Z0-9]+)\)\s*$/;
const CHANNEL = /^Channel: (.*) \(ID: ([A-Z0-9]+)\)\s*$/;

export function tsToIso(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString();
}

function parseChannelLabel(label: string): { type: ConversationType; name?: string } {
  if (label === "DM") return { type: "im" };
  if (label === "Group DM") return { type: "mpim" };
  if (label.startsWith("#") && label.length > 1) return { type: "channel", name: label.slice(1) };
  throw new SlackParseError("unknown channel label");
}

function threadTsFromPermalink(permalink: string | undefined): string | undefined {
  if (!permalink) return undefined;
  return /[?&]thread_ts=(\d+\.\d+)/.exec(permalink)?.[1];
}

/** Returns null when the block is malformed (counted as rejected by the caller). */
function parseBlock(lines: string[]): SourceMessage | null {
  const textIdx = lines.findIndex((l) => l === "Text: " || l === "Text:");
  if (textIdx < 0) return null;
  const fields = new Map<string, string>();
  let channelLine: string | undefined;
  let fromLine: string | undefined;
  for (const line of lines.slice(0, textIdx)) {
    if (line.startsWith("Channel: ")) channelLine ??= line;
    else if (line.startsWith("From: ")) fromLine ??= line;
    else {
      const m = /^([A-Za-z_ ]+): (.*)$/.exec(line);
      if (m?.[1] && !fields.has(m[1])) fields.set(m[1], m[2] ?? "");
    }
  }

  const channel = channelLine ? CHANNEL.exec(channelLine) : null;
  // The label is validated first: an unknown label is format drift and throws.
  const label = channel ? parseChannelLabel(channel[1] ?? "") : null;
  const from = fromLine ? FROM.exec(fromLine) : null;
  if (!channel || !label || !from) return null;

  // Trailer: the block's final "\n\n---\n" plus trailing blank lines.
  let body = lines.slice(textIdx + 1).join("\n");
  body = body.replace(/\n\n---\n*$/, "");
  const bodyLines = body.split("\n");
  let fullNotes: string | undefined;
  const last = bodyLines[bodyLines.length - 1];
  if (last?.startsWith("Full notes: ")) {
    fullNotes = last.slice("Full notes: ".length);
    bodyLines.pop();
  }
  const text = bodyLines.join("\n");

  const ts = fields.get("Message_ts");
  const conversationId = channel[2] ?? "";
  const permalinkMatch = /\((https?:[^)\s]+)\)/.exec(fields.get("Permalink") ?? "");
  const permalink = permalinkMatch?.[1];
  const threadTs = threadTsFromPermalink(permalink);
  const replyCount = fields.has("Reply count") ? Number(fields.get("Reply count")) : undefined;

  const candidate = {
    externalId: `${conversationId}:${ts}`,
    conversationId,
    conversationType: label.type,
    conversationName: label.name,
    ts,
    threadTs: threadTs && threadTs !== ts ? threadTs : undefined,
    senderId: from[3],
    senderName: from[1],
    senderEmail: from[2],
    text,
    fullNotes,
    permalink,
    replyCount,
    sentAt: ts && /^\d+\.\d+$/.test(ts) ? tsToIso(ts) : "",
  };
  const parsed = sourceMessageSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function parseSearchResult(content: string): MessagePage {
  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch {
    throw new SlackParseError("search output is not JSON");
  }
  if (typeof envelope !== "object" || envelope === null) {
    throw new SlackParseError("search envelope is not an object");
  }
  const { results, pagination_info: pagination } = envelope as Record<string, unknown>;
  if (typeof results !== "string") throw new SlackParseError("search envelope lacks results");
  if (pagination !== undefined && typeof pagination !== "string") {
    throw new SlackParseError("pagination_info has an unexpected type");
  }
  const lines = results.split("\n");
  if (!(lines[0] ?? "").startsWith("# Search Results for:")) {
    throw new SlackParseError("search body lacks its header");
  }
  const countIdx = lines.findIndex((l) => /^## Messages \(\d+ results?\)$/.test(l));
  const firstBlockIdx = lines.findIndex((l) => BLOCK_START.test(l));
  if (countIdx < 0 || (firstBlockIdx >= 0 && firstBlockIdx < countIdx)) {
    throw new SlackParseError("search body lacks its message count");
  }
  const expected = Number(/\((\d+) results?\)/.exec(lines[countIdx] ?? "")?.[1]);

  // Fail closed: the block headers must be exactly 1..N of N, wherever they appear.
  const blocks: string[][] = [];
  for (const line of lines) {
    const m = /^### Result (\d+) of (\d+)$/.exec(line);
    if (m) {
      if (Number(m[1]) !== blocks.length + 1 || Number(m[2]) !== expected) {
        throw new SlackParseError("result headers are out of sequence");
      }
      blocks.push([]);
    } else blocks[blocks.length - 1]?.push(line);
  }
  if (blocks.length !== expected) throw new SlackParseError("result count mismatch");

  const messages: SourceMessage[] = [];
  let rejected = 0;
  for (const block of blocks) {
    const msg = parseBlock(block);
    if (msg) messages.push(msg);
    else rejected++;
  }
  const nextCursor = /cursor `([^`]+)`/.exec(pagination ?? "")?.[1];
  return nextCursor ? { messages, rejected, nextCursor } : { messages, rejected };
}
