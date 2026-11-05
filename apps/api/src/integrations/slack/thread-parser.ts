import { type SourceMessage, sourceMessageSchema } from "@synapse/contracts";
import { SlackParseError, tsToIso } from "./search-parser";

const FROM = /^From: (.*) <([^>]*)> \((U[A-Z0-9]+)\)\s*$/;
const PARENT = "=== THREAD PARENT MESSAGE ===";
const REPLIES = /^=== THREAD REPLIES \(\d+ total\) ===$/m;
const REPLY_SPLIT = /^--- Reply \d+ of \d+ ---$/m;

function parseMessage(
  section: string,
  conversationId: string,
  parentTs: string | undefined,
): SourceMessage | null {
  const lines = section.split("\n");
  while (lines.length > 0 && lines[0] === "") lines.shift();
  const from = FROM.exec(lines[0] ?? "");
  const ts = /^Message TS: (\S+)\s*$/.exec(lines[2] ?? "")?.[1];
  if (!from || !lines[1]?.startsWith("Time: ") || !ts) return null;
  const rest = lines.slice(3);
  while (rest.length > 0 && rest[rest.length - 1] === "") rest.pop();
  if (rest[rest.length - 1]?.startsWith("Files: ")) rest.pop();
  const candidate = {
    externalId: `${conversationId}:${ts}`,
    conversationId,
    conversationType: "im" as const, // placeholder; the store keeps the existing row's type
    ts,
    threadTs: parentTs,
    senderId: from[3],
    senderName: from[1],
    senderEmail: from[2],
    text: rest.join("\n"),
    sentAt: /^\d+\.\d+$/.test(ts) ? tsToIso(ts) : "",
  };
  const parsed = sourceMessageSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function parseThreadResult(content: string, conversationId: string): SourceMessage[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch {
    throw new SlackParseError("thread output is not JSON");
  }
  const body = (envelope as { messages?: unknown } | null)?.messages;
  if (typeof body !== "string") throw new SlackParseError("thread envelope lacks messages");

  const parentAt = body.indexOf(PARENT);
  if (parentAt < 0) throw new SlackParseError("thread output lacks a parent section");
  const afterParent = body.slice(parentAt + PARENT.length);
  const repliesMatch = REPLIES.exec(afterParent);
  const parentSection = repliesMatch ? afterParent.slice(0, repliesMatch.index) : afterParent;
  const replySection = repliesMatch
    ? afterParent.slice(repliesMatch.index + repliesMatch[0].length)
    : "";

  const parent = parseMessage(parentSection, conversationId, undefined);
  if (!parent) throw new SlackParseError("thread parent message is malformed");
  const out: SourceMessage[] = [parent];
  for (const chunk of replySection.split(REPLY_SPLIT).slice(1)) {
    const reply = parseMessage(chunk, conversationId, parent.ts);
    if (reply) out.push(reply);
  }
  return out;
}
