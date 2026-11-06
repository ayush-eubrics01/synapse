import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Placed in every non-whitelisted field of synthetic session lines; must never surface. */
export const SENTINEL = "SENTINEL-SESSION-CONTENT-7f3a";

export function sessionLine(type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...fields });
}

/** Writes `<dir>/<sessionId>.jsonl` (dir created) and returns the file path. */
export function writeSession(dir: string, sessionId: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "");
  return path;
}
