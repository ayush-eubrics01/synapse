// J2: shared by send-guard.ts and the standalone send-guard-hook.ts, which Claude Code runs directly
// with bun. Keep it free of any import except node:crypto.
import { createHash } from "node:crypto";

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canon(x))).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Canonical JSON of a tool input: object keys sorted (string order) at every depth, keys whose value
 * is undefined dropped, arrays in order. Equal to `JSON.stringify` of the sorted object.
 */
export function canonicalSendInput(input: unknown): string {
  return canon(input);
}

/** Lowercase hex sha256 of `canonicalSendInput(input)`. */
export function sendInputSha256(input: unknown): string {
  return createHash("sha256").update(canonicalSendInput(input), "utf8").digest("hex");
}
