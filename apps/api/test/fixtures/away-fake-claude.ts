/**
 * Fake `claude` for the away-mode e2e. It checks the `--settings` argument it received (the J2
 * PreToolUse guard with the sha256 of the approved input; the real hook script is not run here),
 * then replays a send: the approved arguments, or an altered message when FAKE_AWAY_MODE=altered.
 * Assertion failures are written to FAKE_AWAY_ERRORS and the run emits no send.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { sendInputSha256 } from "../../src/integrations/claude-code/send-guard-canonical";

const args = process.argv.slice(2);
const at = (flag: string) => args[args.indexOf(flag) + 1] as string;
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args.includes("--version")) {
  process.stdout.write("2.1.318 (Claude Code)\n");
} else {
  writeFileSync(process.env.FAKE_AWAY_ARGV as string, JSON.stringify(args));
  appendFileSync(process.env.FAKE_AWAY_SPAWNS as string, "x");
  const errors = process.env.FAKE_AWAY_ERRORS as string;
  const fail = (m: string) => appendFileSync(errors, `${m}\n`);

  // The approved arguments are the one JSON-object line of the prompt that names channel_id.
  const approved = at("-p")
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find((o) => o && typeof o.channel_id === "string") as Record<string, string> | undefined;
  if (!approved) fail("no approved arguments in the prompt");

  const settings = JSON.parse(at("--settings")) as {
    hooks?: { PreToolUse?: { matcher?: string; hooks?: { command?: string }[] }[] };
  };
  const hook = settings.hooks?.PreToolUse?.[0];
  if (hook?.matcher !== "mcp__claude_ai_Slack__slack_send_message") fail("wrong hook matcher");
  const sha = approved ? sendInputSha256(approved) : "";
  if (!sha || !hook?.hooks?.[0]?.command?.includes(sha)) fail("hook command lacks the sha256");

  if (approved) {
    const input =
      process.env.FAKE_AWAY_MODE === "altered"
        ? { ...approved, message: `${approved.message} (edited)` }
        : approved;
    out({
      type: "system",
      subtype: "init",
      tools: ["ToolSearch"],
      mcp_servers: [{ name: "claude.ai Slack", status: "connected" }],
    });
    out({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "ToolSearch",
            input: { query: "select:mcp__claude_ai_Slack__slack_send_message" },
          },
        ],
      },
    });
    out({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "loaded", is_error: false }],
      },
    });
    out({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "mcp__claude_ai_Slack__slack_send_message",
            input,
          },
        ],
      },
    });
    out({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "ok" }] },
        ],
      },
    });
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      duration_ms: 10,
      total_cost_usd: 0.001,
      usage: { input_tokens: 1, output_tokens: 1 },
      permission_denials: [],
      result: "DONE",
    });
  }
}
