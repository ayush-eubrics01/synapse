/** A stable hue (0–359) from the Slack id, so avatar colours need no storage (spec D5). */
export function hueFor(id: string): number {
  // FNV-1a, 32 bit
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

const ALNUM = /[\p{L}\p{N}]/u;

function firstAlnum(word: string): string {
  for (const ch of word) if (ALNUM.test(ch)) return ch;
  return "";
}

/**
 * Up to two uppercase letters: first and last word of the name. Without a usable name, the first
 * two letters or digits of the fallback (usually the Slack id); "?" when neither has any.
 */
export function initials(name: string | null, fallback: string): string {
  const words = (name ?? "")
    .split(/\s+/)
    .map(firstAlnum)
    .filter((c) => c !== "");
  if (words.length > 0) {
    const first = words[0] ?? "";
    const last = words.length > 1 ? (words[words.length - 1] ?? "") : "";
    return (first + last).toUpperCase();
  }
  const chars = [...fallback].filter((c) => ALNUM.test(c)).slice(0, 2);
  return chars.length > 0 ? chars.join("").toUpperCase() : "?";
}
