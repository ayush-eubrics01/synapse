// J2 send guard: a Claude Code PreToolUse hook, run as `bun send-guard-hook.ts <sha256>`.
// Standalone: Claude Code spawns it directly, so it imports nothing from the workspace.
// stdin: the hook JSON ({ tool_name, tool_input, ... }). Exit 0 allows the call; exit 2 blocks it
// and Claude Code feeds stderr back as the reason. stderr never carries any tool input.
import { sendInputSha256 } from "./send-guard-canonical";

const MISMATCH = "send arguments differ from the approved message";
const MAX_STDIN_BYTES = 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > MAX_STDIN_BYTES) throw new Error("too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<{ code: 0 | 2; reason?: string }> {
  const expected = process.argv[2] ?? "";
  if (!/^[0-9a-f]{64}$/.test(expected)) return { code: 2, reason: "send guard misconfigured" };
  let input: unknown;
  try {
    const parsed: unknown = JSON.parse(await readStdin());
    input = (parsed as { tool_input?: unknown } | null)?.tool_input;
  } catch {
    return { code: 2, reason: "send guard could not read the tool call" };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { code: 2, reason: "send guard could not read the tool call" };
  }
  return sendInputSha256(input) === expected ? { code: 0 } : { code: 2, reason: MISMATCH };
}

const outcome = await main().catch(() => ({ code: 2 as const, reason: "send guard failed" }));
if (outcome.reason) process.stderr.write(`${outcome.reason}\n`);
process.exitCode = outcome.code;
