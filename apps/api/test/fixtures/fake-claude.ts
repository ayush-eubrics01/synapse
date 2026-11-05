import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? "success";

if (process.env.FAKE_CLAUDE_ARGV_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGV_FILE, JSON.stringify(args));
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
