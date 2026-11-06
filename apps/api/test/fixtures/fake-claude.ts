import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? "success";

if (process.env.FAKE_CLAUDE_ARGV_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGV_FILE, JSON.stringify(args));
}
if (process.env.FAKE_CLAUDE_ENV_FILE) {
  // Only the hermetic switches and PATH/HOME presence: never the whole environment.
  const e = process.env;
  writeFileSync(
    process.env.FAKE_CLAUDE_ENV_FILE,
    JSON.stringify({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: e.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: e.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null,
      hasPath: typeof e.PATH === "string",
      hasHome: typeof e.HOME === "string",
      TMPDIR: e.TMPDIR ?? null,
    }),
  );
}
if (process.env.FAKE_CLAUDE_PID_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, String(process.pid));
}

function stream(file: string, onlyFirst = false): void {
  const lines = readFileSync(join(import.meta.dir, "streams", `${file}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  for (const line of onlyFirst ? lines.slice(0, 1) : lines) process.stdout.write(`${line}\n`);
}

if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.318"} (Claude Code)\n`);
} else if (mode === "crash") {
  stream("success", true);
  process.exitCode = 1;
} else if (mode === "hang") {
  stream("success", true);
  setTimeout(() => {}, 60_000);
} else if (mode === "sandbox_unavailable") {
  // failIfUnavailable: the CLI refuses to start; nothing on stdout.
  process.stderr.write("Error: sandbox required but not available\n");
  process.exitCode = 1;
} else if (mode === "sandbox_unavailable_cli_stderr") {
  // The stderr line the real CLI (2.1.319) prints when failIfUnavailable refuses to start.
  process.stderr.write(
    "\n  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n",
  );
  process.exitCode = 1;
} else if (mode === "sandbox_violation_stderr") {
  // A failed run whose stderr carries a sandbox violation notice: not a startup failure.
  stream("success");
  process.stderr.write(
    "<sandbox_violations>\nnetwork: connection to example.test denied by sandbox\n</sandbox_violations>\n",
  );
  process.exitCode = 1;
} else if (mode === "max_turns_sandbox_stderr") {
  stream("max_turns");
  process.stderr.write("Sandbox required but unavailable\n");
  process.exitCode = 1;
} else if (mode === "success_exit1") {
  stream("success");
  process.exitCode = 1;
} else if (mode === "hang_ignore_term") {
  process.on("SIGTERM", () => {});
  stream("success", true);
  setTimeout(() => {}, 60_000);
} else if (mode === "grandchild" || mode === "grandchild_setsid") {
  stream("success");
  const gc = spawn("sleep", ["5"], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: mode === "grandchild_setsid",
  });
  gc.unref();
} else {
  stream(mode === "rate_rejected" ? "rate_rejected" : mode);
}
