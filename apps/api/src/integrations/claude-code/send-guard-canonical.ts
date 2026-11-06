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

/**
 * Parity with the sender's after-the-fact `matchesCommand`: on a plain object, drop
 * `unfurl_app_links` when it is exactly `false` and `trimEnd` a string `message`. Everything else is
 * kept, so an unknown key or `unfurl_app_links: true` still changes the hash. Idempotent; applied to
 * both the expected arguments and the observed `tool_input`.
 */
export function normaliseSendInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input)
      .filter(([k, v]) => !(k === "unfurl_app_links" && v === false))
      .map(([k, v]) => [k, k === "message" && typeof v === "string" ? v.trimEnd() : v]),
  );
}

/** Lowercase hex sha256 of `canonicalSendInput(normaliseSendInput(input))`. */
export function sendInputSha256(input: unknown): string {
  return createHash("sha256")
    .update(canonicalSendInput(normaliseSendInput(input)), "utf8")
    .digest("hex");
}
