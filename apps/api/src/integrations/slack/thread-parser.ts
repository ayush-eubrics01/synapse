import { type SourceMessage, sourceMessageSchema } from "@synapse/contracts";
import { SlackParseError, tsToIso } from "./search-parser";

const FROM = /^From: (.*) <([^>]*)> \((U[A-Z0-9]+)\)\s*$/;
const PARENT = "=== THREAD PARENT MESSAGE ===";
const REPLIES = /^=== THREAD REPLIES \((\d+) total\) ===$/;
const REPLY = /^--- Reply (\d+) of (\d+) ---$/;

/** Throws on unparseable header lines (drift); returns null when Zod rejects the message. */
function parseMessage(
  lines: string[],
  conversationId: string,
  parentTs: string | undefined,
): SourceMessage | null {
  const from = FROM.exec(lines[0] ?? "");
  const ts = /^Message TS: (\S+)\s*$/.exec(lines[2] ?? "")?.[1];
  if (!from || !(lines[1] ?? "").startsWith("Time: ") || !ts) {
    throw new SlackParseError("thread message header is malformed");
  }
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

export function parseThreadResult(
  content: string,
  conversationId: string,
): { messages: SourceMessage[]; rejected: number } {
  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch {
    throw new SlackParseError("thread output is not JSON");
  }
  const body = (envelope as { messages?: unknown } | null)?.messages;
  if (typeof body !== "string") throw new SlackParseError("thread envelope lacks messages");

  const lines = body.split("\n");
  const parentIdxs = lines.flatMap((l, i) => (l === PARENT ? [i] : []));
  const repliesIdxs = lines.flatMap((l, i) => (REPLIES.test(l) ? [i] : []));
  const parentIdx = parentIdxs[0];
  const repliesIdx = repliesIdxs[0];
  if (
    parentIdxs.length !== 1 ||
    repliesIdxs.length !== 1 ||
    parentIdx === undefined ||
    repliesIdx === undefined ||
    parentIdx > repliesIdx
  ) {
    throw new SlackParseError("thread sections are missing, duplicated or misordered");
  }
  const total = Number(REPLIES.exec(lines[repliesIdx] ?? "")?.[1]);

  const markers: number[] = [];
  let m = 0;
  for (let i = repliesIdx + 1; i < lines.length; i++) {
    const r = REPLY.exec(lines[i] ?? "");
    if (!r) continue;
    markers.push(i);
    if (m === 0) m = Number(r[2]);
    if (Number(r[1]) !== markers.length || Number(r[2]) !== m) {
      throw new SlackParseError("reply markers are out of sequence");
    }
  }
  if (markers.length !== m || m > total || (total > 0 && markers.length === 0)) {
    throw new SlackParseError("reply marker count mismatch");
  }

  const parentLines = lines.slice(parentIdx + 1, repliesIdx);
  while (parentLines.length > 0 && parentLines[parentLines.length - 1] === "") parentLines.pop();
  const parent = parseMessage(parentLines, conversationId, undefined);
  if (!parent) throw new SlackParseError("thread parent message is invalid");

  const messages: SourceMessage[] = [parent];
  let rejected = 0;
  for (let k = 0; k < markers.length; k++) {
    const start = (markers[k] ?? 0) + 1;
    const end = markers[k + 1] ?? lines.length;
    const reply = parseMessage(lines.slice(start, end), conversationId, parent.ts);
    if (reply) messages.push(reply);
    else rejected++;
  }
  return { messages, rejected };
}
