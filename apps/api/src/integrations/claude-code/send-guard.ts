import { fileURLToPath } from "node:url";
import type { SendGuard } from "@synapse/contracts";

export { canonicalSendInput, normaliseSendInput, sendInputSha256 } from "./send-guard-canonical";

/** Absolute path of the hook script Claude Code runs before the guarded tool (J2). */
export const SEND_GUARD_HOOK_PATH = fileURLToPath(new URL("./send-guard-hook.ts", import.meta.url));

const SHA_RE = /^[0-9a-f]{64}$/;
const TOOL_RE = /^[A-Za-z0-9_]+$/;
const HOOK_TIMEOUT_S = 10;

/** POSIX single-quoting: safe for any string, including spaces and single quotes. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The per-run `--settings` override for a guarded send (J2, A14): `base` (plugins disabled, R34)
 * with `hooks` replaced by one PreToolUse hook on `guard.toolName` running
 * `<hookCommand...> <sha256>`. Claude Code runs the command through a shell, so every element is
 * single-quoted. A hook exit other than 0 or 2 would be a non-blocking error that lets the call
 * through; `|| exit 2` turns any failure (missing binary, crash) into a block.
 */
export function buildGuardedOverride(
  base: string,
  guard: SendGuard,
  hookCommand: string[],
): string {
  if (!SHA_RE.test(guard.expectedInputSha256)) throw new Error("send guard: malformed sha256");
  if (!TOOL_RE.test(guard.toolName)) throw new Error("send guard: malformed tool name");
  if (hookCommand.length === 0) throw new Error("send guard: empty hook command");
  const parsed: unknown = JSON.parse(base);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("send guard: settings override is not an object");
  }
  const command = `${[...hookCommand, guard.expectedInputSha256].map(shellQuote).join(" ")} || exit 2`;
  return JSON.stringify({
    ...parsed,
    hooks: {
      PreToolUse: [
        {
          matcher: guard.toolName,
          hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }],
        },
      ],
    },
  });
}
