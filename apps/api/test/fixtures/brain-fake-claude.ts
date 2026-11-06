/**
 * Fake `claude` for the Phase 9 inspection e2e. It records its argv and working directory to
 * FAKE_BRAIN_OUT, then replies with a fenced JSON block of facts: two that cite real files of the
 * repository and one that cites a file that does not exist (which code must drop). It reads
 * README.md by relative path and globs src/ by absolute path, as the real CLI reports them.
 * FAKE_BRAIN_MODE=no_reads makes no tool call at all (ADR-026: the run must fail).
 */
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args.includes("--version")) {
  process.stdout.write("2.1.318 (Claude Code)\n");
} else {
  if (process.env.FAKE_BRAIN_OUT) {
    writeFileSync(process.env.FAKE_BRAIN_OUT, JSON.stringify({ args, cwd: process.cwd() }));
  }
  const reply = {
    facts: [
      {
        kind: "purpose",
        content: "A demo application.",
        evidence: [{ path: "README.md", line: 1 }],
      },
      { kind: "stack", content: "Written in TypeScript.", evidence: [{ path: "src/index.ts" }] },
      { kind: "risk", content: "Invented claim.", evidence: [{ path: "src/ghost.ts" }] },
    ],
    unknowns: ["Deployment target"],
  };
  out({ type: "system", subtype: "init", tools: ["Read", "Grep", "Glob"], mcp_servers: [] });
  if (process.env.FAKE_BRAIN_MODE !== "no_reads") {
    out({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } },
          { type: "tool_use", id: "t2", name: "Glob", input: { pattern: "src/**" } },
        ],
      },
    });
    out({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "# Demo", is_error: false },
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: `${process.cwd()}/src/index.ts`,
            is_error: false,
          },
        ],
      },
    });
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
