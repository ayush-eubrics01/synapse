import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git-repo";

export interface RemoteRepoFixture {
  /** $HOME for git in tests (empty, so the developer's config never leaks in). */
  home: string;
  /** A working clone of origin.git on main, with `upstream` → upstream.git (push DISABLED). */
  repo: string;
  origin: string;
  upstream: string;
}

function configure(dir: string): void {
  git(dir, "config", "user.email", "dev@example.com");
  git(dir, "config", "user.name", "Demo Dev");
  git(dir, "config", "commit.gpgsign", "false");
}

/**
 * Placeholder data only: bare `origin.git` and `upstream.git` under `root`, both holding main,
 * stage and prod at one commit (`README.md`, `src/index.ts`), and a working clone `work` of
 * origin with `upstream` added and its push URL set to `DISABLED`.
 */
export function remoteRepoFixture(root: string): RemoteRepoFixture {
  const home = join(root, "home");
  mkdirSync(home);
  const seed = join(root, "seed");
  mkdirSync(join(seed, "src"), { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  configure(seed);
  writeFileSync(join(seed, "README.md"), "# Demo\n");
  writeFileSync(join(seed, "src", "index.ts"), "export {};\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "branch", "stage");
  git(seed, "branch", "prod");
  const origin = join(root, "origin.git");
  const upstream = join(root, "upstream.git");
  for (const bare of [origin, upstream]) {
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(seed, "push", "-q", `file://${bare}`, "main", "stage", "prod");
  }
  git(root, "clone", "-q", `file://${origin}`, "work");
  const repo = join(root, "work");
  configure(repo);
  git(repo, "remote", "add", "upstream", `file://${upstream}`);
  git(repo, "remote", "set-url", "--push", "upstream", "DISABLED");
  git(repo, "fetch", "-q", "upstream");
  return { home, repo, origin, upstream };
}
