export const PROMPT_BYTES = 100 * 1024; // orchestrator cap (validator MAX_PROMPT_BYTES)
export const RESERVED_BYTES = 8 * 1024; // system part, instructions, markers
const MARK = " […truncated]";

/** UTF-8 byte budget for each of `partCount` untrusted parts. */
export const perPartBytes = (partCount: number): number =>
  Math.floor((PROMPT_BYTES - RESERVED_BYTES) / partCount);

/** Caps by UTF-8 bytes, cutting only at a code-point boundary. */
export function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  const budget = Math.max(0, max - Buffer.byteLength(MARK, "utf8"));
  let used = 0;
  let out = "";
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + MARK;
}
