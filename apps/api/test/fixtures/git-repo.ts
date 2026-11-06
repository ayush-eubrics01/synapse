import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Isolated from the developer's git config so commits and branches are deterministic. */
const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A fresh temp directory (realpath), at least two segments deep. */
export function tempDir(prefix = "synapse-git-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** `git init -b main` with one commit at `dir` (created if needed). */
export function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "dev@example.com");
  git(dir, "config", "user.name", "Demo Dev");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return realpathSync(dir);
}

/**
 * The placeholder demo repo: branches main, stage, prod and feature-x; `origin` at
 * https://example.com/demo/app.git; `upstream` with pushes disabled (`no_push`).
 */
export function makeDemoRepo(parent = tempDir(), name = "app"): string {
  const dir = initRepo(join(parent, name));
  for (const b of ["stage", "prod", "feature-x"]) git(dir, "branch", b);
  git(dir, "remote", "add", "origin", "https://example.com/demo/app.git");
  git(dir, "remote", "add", "upstream", "https://example.com/upstream/app.git");
  git(dir, "remote", "set-url", "--push", "upstream", "no_push");
  return dir;
}
