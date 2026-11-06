/**
 * Fake `claude` for the Phase 10 engineering e2e (never the real claude). One binary serves both
 * runs and tells them apart by their scoped tools. It records its argv, cwd, the hermetic env
 * switches and `TMPDIR` to `$FAKE_ENG_DIR/<kind>.json`.
 *
 * - investigate (no Edit scope): a real Read tool_use/result, then the structured plan JSON.
 * - develop (Edit scope): edits one file and creates another inside its cwd (the fake has fs
 *   access, like the real worker), emits Edit and Bash(`bun test`) tool_use/results (the Bash
 *   result shows passing tests), then the DevelopOutput JSON.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args.includes("--version")) {
  process.stdout.write("2.1.318 (Claude Code)\n");
} else {
  const allowed = args[args.indexOf("--allowedTools") + 1] ?? "";
  const develop = allowed.split(",").some((t) => t.startsWith("Edit("));
  const kind = develop ? "develop" : "investigate";
  const cwd = process.cwd();
  if (process.env.FAKE_ENG_DIR) {
    writeFileSync(
      join(process.env.FAKE_ENG_DIR, `${kind}.json`),
      JSON.stringify({
        args,
        cwd,
        autoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
        tmpdir: process.env.TMPDIR ?? null,
      }),
    );
  }
  out({ type: "system", subtype: "init", tools: ["Read", "Edit", "Bash"], mcp_servers: [] });
  let reply: unknown;
  if (!develop) {
    out({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } }],
      },
    });
    out({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "# Demo", is_error: false }],
      },
    });
    reply = {
      summary: "Change the exported value.",
      plan: [{ step: "Edit src/index.ts" }, { step: "Add src/feature.ts" }],
      filesLikelyTouched: ["src/index.ts", "src/feature.ts"],
      testCommand: "bun test",
      risk: "low",
      size: "s",
      unclear: [],
    };
  } else {
    const file = join(cwd, "src", "index.ts");
    writeFileSync(file, 'export const redirect = "/home";\n');
    mkdirSync(dirname(join(cwd, "src", "feature.ts")), { recursive: true });
    writeFileSync(join(cwd, "src", "feature.ts"), "export const feature = 1;\n");
    out({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Edit", input: { file_path: file } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test" } },
        ],
      },
    });
    out({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "edited", is_error: false },
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: "3 pass\n0 fail\nRan 3 tests",
            is_error: false,
          },
        ],
      },
    });
    reply = {
      summary: "Changed the redirect.",
      testsPassed: true,
      testOutputTail: "ok",
      notes: "",
    };
  }
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    duration_ms: 1000,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 8,
      output_tokens: 6,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    permission_denials: [],
    result: `Done.\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``,
  });
}
