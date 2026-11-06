import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GIT_DIFF_TEXT_MAX_BYTES, GitWorkflowError } from "@synapse/contracts";
import {
  GIT_NETWORK_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  type GitInvocation,
  gitInvocation,
  spawnGit,
} from "../../src/integrations/repository/git";
import {
  LocalGitWorkflow,
  remoteKey,
  sameOriginRemote,
} from "../../src/integrations/repository/git-workflow";
import { git, tempDir } from "../fixtures/git-repo";

const roots: string[] = [];
const scratch = () => {
  const d = tempDir("synapse-gwf-");
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const HARDENING = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.interactive=never",
];

interface Fixture {
  root: string;
  home: string;
  xdg: string;
  repo: string;
  origin: string;
  upstream: string;
  wf: LocalGitWorkflow;
  calls: GitInvocation[];
}

function configure(dir: string): void {
  git(dir, "config", "user.email", "dev@example.com");
  git(dir, "config", "user.name", "Demo Dev");
  git(dir, "config", "commit.gpgsign", "false");
}

/**
 * A working clone of `origin.git` (checked out on main) with `upstream` → `upstream.git`
 * (push URL DISABLED). Both bare repos hold main, stage and prod at the same commit, with
 * `a.txt` = "one\ntwo\nthree\n".
 */
function setup(): Fixture {
  const root = scratch();
  const home = join(root, "home");
  mkdirSync(home);
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  configure(seed);
  writeFileSync(join(seed, "a.txt"), "one\ntwo\nthree\n");
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
  const calls: GitInvocation[] = [];
  const xdg = join(root, "xdg");
  const wf = new LocalGitWorkflow({
    home,
    xdgConfigHome: xdg,
    systemConfig: join(root, "etc-gitconfig"),
    extraEnv: { GIT_CONFIG_NOSYSTEM: "1" },
    exec: (inv) => {
      calls.push(inv);
      return spawnGit(inv);
    },
  });
  return { root, home, xdg, repo, origin, upstream, wf, calls };
}

/** Commits `content` to `file` on `branch` of a bare repo through a throwaway clone. */
function pushCommit(
  f: Fixture,
  bare: string,
  branch: string,
  file: string,
  content: string,
): string {
  const dir = join(f.root, `clone-${Math.random().toString(36).slice(2)}`);
  git(f.root, "clone", "-q", "-b", branch, `file://${bare}`, dir);
  configure(dir);
  writeFileSync(join(dir, file), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `change ${file}`);
  git(dir, "push", "-q", "origin", branch);
  return git(dir, "rev-parse", "HEAD");
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GitWorkflowError) {
      expect(e.message).toBe(e.code);
      return e.code;
    }
    throw e;
  }
  return "no error";
}

const head = (dir: string, ref = "HEAD") => git(dir, "rev-parse", ref);
const mergeHead = (repo: string) => existsSync(join(repo, ".git", "MERGE_HEAD"));

describe("git runner (E17)", () => {
  test("every call carries the hardening flags, -C and a minimal env", () => {
    const inv = gitInvocation("/srv/repo", ["status"], { home: "/h" });
    expect(inv.argv).toEqual(["git", ...HARDENING, "-C", "/srv/repo", "status"]);
    expect(inv.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(inv.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(inv.env.HOME).toBe("/h");
    expect(inv.timeoutMs).toBe(GIT_TIMEOUT_MS);
    expect(GIT_TIMEOUT_MS).toBe(60_000);
  });

  test("push, fetch, pull and ls-remote get 120 s", () => {
    for (const sub of ["push", "fetch", "pull", "ls-remote"]) {
      expect(gitInvocation("/r", [sub, "origin"], { home: "/h" }).timeoutMs).toBe(
        GIT_NETWORK_TIMEOUT_MS,
      );
    }
    expect(GIT_NETWORK_TIMEOUT_MS).toBe(120_000);
    expect(gitInvocation("/r", ["push"], { home: "/h", timeoutMs: 5 }).timeoutMs).toBe(5);
  });

  test("keeps SSH_AUTH_SOCK for ssh-agent but drops other inherited variables", () => {
    const saved = { sock: process.env.SSH_AUTH_SOCK, secret: process.env.SYNAPSE_TEST_SECRET };
    process.env.SSH_AUTH_SOCK = "/run/agent.sock";
    process.env.SYNAPSE_TEST_SECRET = "s3cret";
    try {
      const inv = gitInvocation("/r", ["status"], { home: "/h" });
      expect(inv.env.SSH_AUTH_SOCK).toBe("/run/agent.sock");
      expect(Object.values(inv.env)).not.toContain("s3cret");
    } finally {
      if (saved.sock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = saved.sock;
      if (saved.secret === undefined) delete process.env.SYNAPSE_TEST_SECRET;
      else process.env.SYNAPSE_TEST_SECRET = saved.secret;
    }
  });

  test("extra env cannot override the hardening variables", () => {
    const inv = gitInvocation("/r", ["status"], {
      home: "/h",
      extraEnv: { GIT_TERMINAL_PROMPT: "1", GIT_OPTIONAL_LOCKS: "1", GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(inv.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(inv.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(inv.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });
});

describe("remoteKey", () => {
  test("normalises scheme, credentials, case and the .git suffix", () => {
    const k = remoteKey("https://user:tok@GitHub.com/ExampleOrg/demo-app.git/");
    expect(k).toBe(remoteKey("git@github.com:exampleorg/demo-app"));
    expect(k).toBe(remoteKey("ssh://git@github.com/ExampleOrg/demo-app.git"));
    expect(k).not.toBe(remoteKey("https://github.com/example-user/demo-app.git"));
    expect(remoteKey("file:///srv/x/up.git")).toBe(remoteKey("/srv/x/up"));
  });
});

describe("preflight (E7)", () => {
  test("passes on a clean repo whose parent is on both remotes", async () => {
    const f = setup();
    expect(await f.wf.preflight(f.repo, "stage")).toEqual({ ok: true });
  });

  test("not_a_repository for a subdirectory", async () => {
    const f = setup();
    mkdirSync(join(f.repo, "sub"));
    expect(await f.wf.preflight(join(f.repo, "sub"), "stage")).toEqual({
      ok: false,
      reason: "not_a_repository",
    });
  });

  test("merge_in_progress", async () => {
    const f = setup();
    git(f.repo, "switch", "-q", "-c", "x");
    writeFileSync(join(f.repo, "a.txt"), "x\n");
    git(f.repo, "commit", "-q", "-am", "x");
    git(f.repo, "switch", "-q", "main");
    writeFileSync(join(f.repo, "a.txt"), "y\n");
    git(f.repo, "commit", "-q", "-am", "y");
    Bun.spawnSync(["git", "-C", f.repo, "merge", "x"], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(mergeHead(f.repo)).toBe(true);
    expect(await f.wf.preflight(f.repo, "stage")).toEqual({
      ok: false,
      reason: "merge_in_progress",
    });
  });

  test("dirty_tree for an untracked file", async () => {
    const f = setup();
    writeFileSync(join(f.repo, "new.txt"), "n\n");
    expect(await f.wf.preflight(f.repo, "stage")).toEqual({ ok: false, reason: "dirty_tree" });
  });

  test("missing_remote without upstream", async () => {
    const f = setup();
    git(f.repo, "remote", "remove", "upstream");
    expect(await f.wf.preflight(f.repo, "stage")).toEqual({
      ok: false,
      reason: "missing_remote",
    });
  });

  test("upstream_push_enabled unless the user accepted it", async () => {
    const f = setup();
    git(f.repo, "remote", "set-url", "--push", "upstream", `file://${f.upstream}`);
    expect(await f.wf.preflight(f.repo, "stage")).toEqual({
      ok: false,
      reason: "upstream_push_enabled",
    });
    expect(await f.wf.preflight(f.repo, "stage", { allowUpstreamPush: true })).toEqual({
      ok: true,
    });
  });

  test("parent_missing_origin", async () => {
    const f = setup();
    pushCommit(f, f.upstream, "main", "up.txt", "u\n");
    const tmp = join(f.root, "up-branch");
    git(f.root, "clone", "-q", `file://${f.upstream}`, tmp);
    git(tmp, "push", "-q", "origin", "main:only-up");
    expect(await f.wf.preflight(f.repo, "only-up")).toEqual({
      ok: false,
      reason: "parent_missing_origin",
    });
  });

  test("parent_missing_upstream", async () => {
    const f = setup();
    git(f.repo, "push", "-q", "origin", "main:only-origin");
    expect(await f.wf.preflight(f.repo, "only-origin")).toEqual({
      ok: false,
      reason: "parent_missing_upstream",
    });
  });

  test("an unsafe branch name is refused before git runs", async () => {
    const f = setup();
    for (const bad of ["-x", "a..b", "a b", "../x", "HEAD", "x.lock", "a/.b", ""]) {
      expect(await codeOf(f.wf.preflight(f.repo, bad))).toBe("invalid_ref");
    }
    expect(f.calls).toHaveLength(0);
  });
});

describe("createTaskBranch (E8)", () => {
  test("fetches, fast-forwards the parent and branches from it", async () => {
    const f = setup();
    const tip = pushCommit(f, f.origin, "stage", "s.txt", "s\n");
    const { baseSha } = await f.wf.createTaskBranch(f.repo, "stage", "synapse/ab12-fix");
    expect(baseSha).toBe(tip);
    expect(head(f.repo, "refs/heads/stage")).toBe(tip);
    expect(await f.wf.currentBranch(f.repo)).toBe("synapse/ab12-fix");
    expect(head(f.repo, "refs/remotes/upstream/stage")).toBe(head(f.upstream, "stage"));
  });

  test("an existing local parent is fast-forwarded only when that is a fast-forward", async () => {
    const f = setup();
    git(f.repo, "switch", "-q", "-c", "stage", "origin/stage");
    writeFileSync(join(f.repo, "local.txt"), "l\n");
    git(f.repo, "add", "-A");
    git(f.repo, "commit", "-q", "-m", "local");
    const local = head(f.repo);
    pushCommit(f, f.origin, "stage", "s.txt", "s\n");
    const { baseSha } = await f.wf.createTaskBranch(f.repo, "stage", "synapse/t");
    expect(baseSha).toBe(local);
    expect(head(f.repo, "refs/heads/stage")).toBe(local);
  });

  test("refuses an existing task branch", async () => {
    const f = setup();
    git(f.repo, "branch", "synapse/t");
    expect(await codeOf(f.wf.createTaskBranch(f.repo, "stage", "synapse/t"))).toBe("branch_exists");
  });
});

describe("diffSummary", () => {
  test("counts additions and removals for tracked and new files", async () => {
    const f = setup();
    writeFileSync(join(f.repo, "a.txt"), "one\nTWO\nthree\nfour\n");
    writeFileSync(join(f.repo, "b.txt"), "b1\nb2\n");
    const d = await f.wf.diffSummary(f.repo);
    expect(d.files).toEqual([
      { path: "a.txt", added: 2, removed: 1 },
      { path: "b.txt", added: 2, removed: 0 },
    ]);
    expect(d.unsafe).toBe(false);
    expect(d.truncated).toBe(false);
    expect(d.diffText).toContain("+four");
    expect(d.diffText).toContain("+b2");
    expect(d.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await f.wf.diffSummary(f.repo)).hash).toBe(d.hash);
  });

  test("the hash changes with any edit and is the same after staging", async () => {
    const f = setup();
    writeFileSync(join(f.repo, "b.txt"), "b\n");
    const h1 = (await f.wf.diffSummary(f.repo)).hash;
    git(f.repo, "add", "-A");
    expect((await f.wf.diffSummary(f.repo)).hash).toBe(h1);
    writeFileSync(join(f.repo, "b.txt"), "b!\n");
    expect((await f.wf.diffSummary(f.repo)).hash).not.toBe(h1);
  });

  test("unsafe for a change in .git/config against the baseline", async () => {
    const f = setup();
    const base = await f.wf.gitDirFingerprint(f.repo);
    writeFileSync(join(f.repo, "a.txt"), "changed\n");
    expect((await f.wf.diffSummary(f.repo, { gitDirBaseline: base })).unsafe).toBe(false);
    expect(await f.wf.gitDirFingerprint(f.repo)).toBe(base);
    const cfg = join(f.repo, ".git", "config");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8")}[core]\n\tpager = evil\n`);
    expect((await f.wf.diffSummary(f.repo, { gitDirBaseline: base })).unsafe).toBe(true);
  });

  test("an index refresh, lock files and transient heads do not change the fingerprint", async () => {
    const f = setup();
    const base = await f.wf.gitDirFingerprint(f.repo);
    // A plain `git status` (no optional-locks env) refreshes the index stat cache.
    writeFileSync(join(f.repo, "a.txt"), readFileSync(join(f.repo, "a.txt"), "utf8"));
    git(f.repo, "status");
    git(f.repo, "update-index", "--refresh");
    writeFileSync(join(f.repo, ".git", "index.lock"), "");
    writeFileSync(join(f.repo, ".git", "FETCH_HEAD"), "x\n");
    writeFileSync(join(f.repo, ".git", "COMMIT_EDITMSG"), "x\n");
    expect(await f.wf.gitDirFingerprint(f.repo)).toBe(base);
    // HEAD and refs still count.
    writeFileSync(join(f.repo, ".git", "HEAD"), "ref: refs/heads/stage\n");
    expect(await f.wf.gitDirFingerprint(f.repo)).not.toBe(base);
  });

  test("unsafe for a new hook under .git/hooks", async () => {
    const f = setup();
    const base = await f.wf.gitDirFingerprint(f.repo);
    writeFileSync(join(f.repo, ".git", "hooks", "x"), "#!/bin/sh\n");
    expect((await f.wf.diffSummary(f.repo, { gitDirBaseline: base })).unsafe).toBe(true);
  });

  test("unsafe for a symlink to a file outside the repo; safe for one inside", async () => {
    const f = setup();
    writeFileSync(join(f.root, "outside.txt"), "secret\n");
    symlinkSync("a.txt", join(f.repo, "inside-link"));
    expect((await f.wf.diffSummary(f.repo)).unsafe).toBe(false);
    symlinkSync(join(f.root, "outside.txt"), join(f.repo, "out-link"));
    const d = await f.wf.diffSummary(f.repo);
    expect(d.unsafe).toBe(true);
    expect(d.diffText).not.toContain("secret");
  });

  test("unsafe for a relative symlink climbing out and for one into .git", async () => {
    const f = setup();
    symlinkSync("../outside.txt", join(f.repo, "up-link"));
    expect((await f.wf.diffSummary(f.repo)).unsafe).toBe(true);
    unlinkSync(join(f.repo, "up-link"));
    symlinkSync(".git/config", join(f.repo, "cfg-link"));
    expect((await f.wf.diffSummary(f.repo)).unsafe).toBe(true);
  });

  test("diff text is cut at 200 KB", async () => {
    const f = setup();
    writeFileSync(join(f.repo, "big.txt"), "x".repeat(100).concat("\n").repeat(3000));
    const d = await f.wf.diffSummary(f.repo);
    expect(d.truncated).toBe(true);
    expect(Buffer.byteLength(d.diffText)).toBeLessThanOrEqual(GIT_DIFF_TEXT_MAX_BYTES);
    expect(d.files).toEqual([{ path: "big.txt", added: 3000, removed: 0 }]);
  });
});

describe("commitAll (E10)", () => {
  test("refuses when the tree changed after the hash was taken", async () => {
    const f = setup();
    writeFileSync(join(f.repo, "a.txt"), "edit\n");
    const { hash } = await f.wf.diffSummary(f.repo);
    writeFileSync(join(f.repo, "b.txt"), "sneaky\n");
    const before = head(f.repo);
    expect(await codeOf(f.wf.commitAll(f.repo, "msg", hash))).toBe("diff_changed");
    expect(head(f.repo)).toBe(before);
    expect(git(f.repo, "diff", "--cached", "--name-only")).toBe("");
  });

  test("commits everything with the message and returns the sha", async () => {
    const f = setup();
    writeFileSync(join(f.repo, "a.txt"), "edit\n");
    writeFileSync(join(f.repo, "b.txt"), "new\n");
    const { hash } = await f.wf.diffSummary(f.repo);
    const message = "Fix the thing\n\nSummary line.\n\nTask: 42";
    const { sha } = await f.wf.commitAll(f.repo, message, hash);
    expect(sha).toBe(head(f.repo));
    expect(git(f.repo, "log", "-1", "--format=%B")).toBe(message);
    expect(git(f.repo, "status", "--porcelain")).toBe("");
    expect(git(f.repo, "log", "-1", "--format=%an <%ae>")).toBe("Demo Dev <dev@example.com>");
  });

  test("refuses an unsafe change and an empty diff", async () => {
    const f = setup();
    expect(await codeOf(f.wf.commitAll(f.repo, "m", "0".repeat(64)))).toBe("nothing_to_commit");
    symlinkSync("/etc/hostname", join(f.repo, "link"));
    const { hash } = await f.wf.diffSummary(f.repo);
    expect(await codeOf(f.wf.commitAll(f.repo, "m", hash))).toBe("unsafe_change");
  });
});

describe("updateParent (E11)", () => {
  test("fast-forwards from origin then upstream", async () => {
    const f = setup();
    await f.wf.createTaskBranch(f.repo, "stage", "synapse/t");
    const o = pushCommit(f, f.origin, "stage", "o.txt", "o\n");
    const tmp = join(f.root, "sync");
    git(f.root, "clone", "-q", "-b", "stage", `file://${f.origin}`, tmp);
    git(tmp, "push", "-q", `file://${f.upstream}`, "stage");
    const u = pushCommit(f, f.upstream, "stage", "u.txt", "u\n");
    expect(head(f.upstream, "stage")).toBe(u);
    expect(await f.wf.updateParent(f.repo, "stage")).toEqual({ ok: true });
    expect(await f.wf.currentBranch(f.repo)).toBe("stage");
    expect(head(f.repo)).toBe(u);
    expect(git(f.repo, "merge-base", "--is-ancestor", o, "HEAD")).toBe("");
  });

  test("merges when upstream diverged without conflict", async () => {
    const f = setup();
    await f.wf.createTaskBranch(f.repo, "stage", "synapse/t");
    pushCommit(f, f.origin, "stage", "o.txt", "o\n");
    pushCommit(f, f.upstream, "stage", "u.txt", "u\n");
    expect(await f.wf.updateParent(f.repo, "stage")).toEqual({ ok: true });
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(existsSync(join(f.repo, "o.txt")) && existsSync(join(f.repo, "u.txt"))).toBe(true);
  });

  test("a conflicting upstream commit is reported and the merge aborted", async () => {
    const f = setup();
    await f.wf.createTaskBranch(f.repo, "stage", "synapse/t");
    const o = pushCommit(f, f.origin, "stage", "a.txt", "origin\n");
    pushCommit(f, f.upstream, "stage", "a.txt", "upstream\n");
    expect(await f.wf.updateParent(f.repo, "stage")).toEqual({ ok: false, conflict: true });
    expect(mergeHead(f.repo)).toBe(false);
    expect(git(f.repo, "status", "--porcelain")).toBe("");
    expect(head(f.repo)).toBe(o);
  });
});

/** Task branch from stage with one commit changing `file`. */
async function taskWithCommit(f: Fixture, file = "t.txt", content = "t\n"): Promise<string> {
  await f.wf.createTaskBranch(f.repo, "stage", "synapse/t");
  writeFileSync(join(f.repo, file), content);
  const { hash } = await f.wf.diffSummary(f.repo);
  return (await f.wf.commitAll(f.repo, "task change", hash)).sha;
}

describe("mergeLocal (E12)", () => {
  test("merges with --no-ff even when a fast-forward is possible", async () => {
    const f = setup();
    const taskSha = await taskWithCommit(f);
    expect(await f.wf.updateParent(f.repo, "stage")).toEqual({ ok: true });
    const r = await f.wf.mergeLocal(f.repo, "stage", "synapse/t");
    if (!r.ok) throw new Error("expected a merge");
    expect(r.sha).toBe(head(f.repo));
    const parents = git(f.repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
    expect(parents).toHaveLength(3);
    expect(parents[2]).toBe(taskSha);
    expect(git(f.repo, "log", "-1", "--format=%s")).toBe("Merge branch 'synapse/t' into stage");
    expect(await f.wf.currentBranch(f.repo)).toBe("stage");
  });

  test("a conflict is aborted and reported", async () => {
    const f = setup();
    await taskWithCommit(f, "a.txt", "task\n");
    pushCommit(f, f.origin, "stage", "a.txt", "parent\n");
    expect(await f.wf.updateParent(f.repo, "stage")).toEqual({ ok: true });
    const before = head(f.repo);
    expect(await f.wf.mergeLocal(f.repo, "stage", "synapse/t")).toEqual({
      ok: false,
      conflict: true,
    });
    expect(mergeHead(f.repo)).toBe(false);
    expect(head(f.repo)).toBe(before);
    expect(git(f.repo, "status", "--porcelain")).toBe("");
  });
});

describe("pinned SHAs (review fixes)", () => {
  test("branchTip returns the local branch sha, or null when it does not exist", async () => {
    const f = setup();
    expect(await f.wf.branchTip(f.repo, "main")).toBe(head(f.repo, "main"));
    expect(await f.wf.branchTip(f.repo, "synapse/none")).toBeNull();
    expect(await codeOf(f.wf.branchTip(f.repo, "-x"))).toBe("invalid_ref");
  });

  test("mergeLocal with a pinned commit merges exactly it, and refuses a task branch that moved", async () => {
    const f = setup();
    const taskSha = await taskWithCommit(f);
    await f.wf.updateParent(f.repo, "stage");
    const r = await f.wf.mergeLocal(f.repo, "stage", "synapse/t", { commit: taskSha });
    if (!r.ok) throw new Error("expected a merge");
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")[2]).toBe(taskSha);

    const g = setup();
    const pinned = await taskWithCommit(g);
    git(g.repo, "switch", "-q", "synapse/t");
    writeFileSync(join(g.repo, "later.txt"), "later\n");
    git(g.repo, "add", "-A");
    git(g.repo, "commit", "-q", "-m", "later");
    await g.wf.updateParent(g.repo, "stage");
    const before = head(g.repo, "stage");
    expect(await codeOf(g.wf.mergeLocal(g.repo, "stage", "synapse/t", { commit: pinned }))).toBe(
      "branch_moved",
    );
    expect(head(g.repo, "stage")).toBe(before);
  });

  test("pushParent with a pinned sha pushes exactly it, and refuses a parent that moved", async () => {
    const f = setup();
    await taskWithCommit(f);
    await f.wf.updateParent(f.repo, "stage");
    const m = await f.wf.mergeLocal(f.repo, "stage", "synapse/t");
    if (!m.ok) throw new Error("expected a merge");
    const opts = { protectedBranches: [], upstreamUrl: `file://${f.upstream}` };
    writeFileSync(join(f.repo, "user.txt"), "user\n");
    git(f.repo, "add", "-A");
    git(f.repo, "commit", "-q", "-m", "user commit on the parent");
    const originBefore = head(f.origin, "stage");
    expect(await codeOf(f.wf.pushParent(f.repo, "stage", { ...opts, expectedSha: m.sha }))).toBe(
      "branch_moved",
    );
    expect(head(f.origin, "stage")).toBe(originBefore);
    git(f.repo, "reset", "-q", "--hard", m.sha);
    expect(await f.wf.pushParent(f.repo, "stage", { ...opts, expectedSha: m.sha })).toEqual({
      ok: true,
    });
    expect(head(f.origin, "stage")).toBe(m.sha);
    const push = f.calls.filter((c) => c.argv.includes("push")).at(-1);
    expect(push?.argv.at(-1)).toBe(`${m.sha}:refs/heads/stage`);
  });
});

describe("pushParent (E13) and commitsAhead", () => {
  const opts = (f: Fixture, protectedBranches: string[] = ["prod"]) => ({
    protectedBranches,
    upstreamUrl: `file://${f.upstream}`,
  });

  test("pushes the parent to the bare origin only", async () => {
    const f = setup();
    const taskSha = await taskWithCommit(f);
    await f.wf.updateParent(f.repo, "stage");
    await f.wf.mergeLocal(f.repo, "stage", "synapse/t");
    const ahead = await f.wf.commitsAhead(f.repo, "stage");
    expect(ahead.map((c) => c.sha)).toEqual([head(f.repo), taskSha]);
    expect(ahead[1]?.subject).toBe("task change");
    const upstreamBefore = head(f.upstream, "stage");
    expect(await f.wf.pushParent(f.repo, "stage", opts(f))).toEqual({ ok: true });
    expect(head(f.origin, "stage")).toBe(head(f.repo));
    expect(head(f.upstream, "stage")).toBe(upstreamBefore);
    expect(await f.wf.commitsAhead(f.repo, "stage")).toEqual([]);
    const push = f.calls.filter((c) => c.argv.includes("push"));
    expect(push).toHaveLength(1);
    expect(push[0]?.argv).not.toContain("--force");
    expect(push[0]?.argv.some((a) => a.startsWith("+"))).toBe(false);
    expect(push[0]?.argv).toContain("origin");
  });

  test("refuses a protected parent", async () => {
    const f = setup();
    const before = head(f.origin, "prod");
    expect(await codeOf(f.wf.pushParent(f.repo, "prod", opts(f)))).toBe("protected_branch");
    expect(head(f.origin, "prod")).toBe(before);
    expect(f.calls.filter((c) => c.argv.includes("push"))).toHaveLength(0);
  });

  test("refuses when the origin push URL is the upstream repository", async () => {
    const f = setup();
    git(f.repo, "switch", "-q", "-c", "stage", "origin/stage");
    writeFileSync(join(f.repo, "x.txt"), "x\n");
    git(f.repo, "add", "-A");
    git(f.repo, "commit", "-q", "-m", "x");
    const before = head(f.upstream, "stage");
    git(f.repo, "remote", "set-url", "--push", "origin", `${f.upstream}/`);
    expect(await codeOf(f.wf.pushParent(f.repo, "stage", opts(f)))).toBe("push_target_is_upstream");
    // Also when only the registered upstream URL (not the git remote) matches.
    git(f.repo, "remote", "set-url", "--push", "origin", `file://${f.origin}`);
    expect(
      await codeOf(
        f.wf.pushParent(f.repo, "stage", {
          protectedBranches: [],
          upstreamUrl: `file://${f.origin.replace(/\.git$/, "")}`,
        }),
      ),
    ).toBe("push_target_is_upstream");
    expect(head(f.upstream, "stage")).toBe(before);
    expect(f.calls.filter((c) => c.argv.includes("push"))).toHaveLength(0);
  });
});

describe("cleanup (E15)", () => {
  test("deletes a merged task branch and returns to the original branch", async () => {
    const f = setup();
    await taskWithCommit(f);
    await f.wf.updateParent(f.repo, "stage");
    await f.wf.mergeLocal(f.repo, "stage", "synapse/t");
    expect(await f.wf.cleanup(f.repo, "synapse/t", "main", { force: false })).toEqual({
      ok: true,
      deleted: true,
    });
    expect(await f.wf.currentBranch(f.repo)).toBe("main");
    expect(git(f.repo, "branch", "--list", "synapse/t")).toBe("");
  });

  test("keeps an unmerged task branch unless forced", async () => {
    const f = setup();
    await taskWithCommit(f);
    expect(await f.wf.cleanup(f.repo, "synapse/t", "main", { force: false })).toEqual({
      ok: true,
      deleted: false,
    });
    expect(git(f.repo, "branch", "--list", "synapse/t")).not.toBe("");
    expect(await f.wf.cleanup(f.repo, "synapse/t", "main", { force: true })).toEqual({
      ok: true,
      deleted: true,
    });
  });

  test("a dirty tree is reported and left exactly as it is", async () => {
    const f = setup();
    await f.wf.createTaskBranch(f.repo, "stage", "synapse/t");
    writeFileSync(join(f.repo, "wip.txt"), "wip\n");
    expect(await f.wf.cleanup(f.repo, "synapse/t", "main", { force: true })).toEqual({
      ok: false,
      dirty: true,
    });
    expect(await f.wf.currentBranch(f.repo)).toBe("synapse/t");
    expect(readFileSync(join(f.repo, "wip.txt"), "utf8")).toBe("wip\n");
  });
});

describe("discardChanges (E16) and branchExists", () => {
  test("discards exactly the approved changes: tracked edits, new files and staged additions; ignored files stay", async () => {
    const f = setup();
    writeFileSync(join(f.repo, ".gitignore"), "build/\n");
    git(f.repo, "add", ".gitignore");
    git(f.repo, "commit", "-q", "-m", "ignore");
    mkdirSync(join(f.repo, "build"));
    writeFileSync(join(f.repo, "build", "out.js"), "ignored\n");
    writeFileSync(join(f.repo, "a.txt"), "edit\n");
    mkdirSync(join(f.repo, "src"));
    writeFileSync(join(f.repo, "src", "[x]*.ts"), "glob-looking name\n");
    writeFileSync(join(f.repo, "staged.txt"), "staged\n");
    git(f.repo, "add", "staged.txt");
    const { hash } = await f.wf.diffSummary(f.repo);
    expect(await f.wf.discardChanges(f.repo, hash)).toEqual({ ok: true });
    expect(git(f.repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(existsSync(join(f.repo, "staged.txt"))).toBe(false);
    expect(readFileSync(join(f.repo, "build", "out.js"), "utf8")).toBe("ignored\n");
  });

  test("refuses a tree that changed since the hash (diff_changed) and leaves it as it is", async () => {
    const f = setup();
    writeFileSync(join(f.repo, "a.txt"), "edit\n");
    const { hash } = await f.wf.diffSummary(f.repo);
    writeFileSync(join(f.repo, "mine.txt"), "the user's own file\n");
    expect(await codeOf(f.wf.discardChanges(f.repo, hash))).toBe("diff_changed");
    expect(readFileSync(join(f.repo, "mine.txt"), "utf8")).toBe("the user's own file\n");
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("edit\n");
  });

  test("refuses an unsafe diff and a changed config; a clean tree is a no-op", async () => {
    const f = setup();
    expect(await f.wf.discardChanges(f.repo, "0".repeat(64))).toEqual({ ok: true });
    const fp = await f.wf.configFingerprint(f.repo);
    writeFileSync(join(f.repo, ".gitattributes"), "* filter=x\n");
    const { hash } = await f.wf.diffSummary(f.repo);
    expect(await codeOf(f.wf.discardChanges(f.repo, hash))).toBe("unsafe_change");
    rmSync(join(f.repo, ".gitattributes"));
    writeFileSync(join(f.repo, "a.txt"), "edit\n");
    const d = await f.wf.diffSummary(f.repo);
    git(f.repo, "config", "core.pager", "less");
    expect(
      await codeOf(f.wf.discardChanges(f.repo, d.hash, { expectedConfigFingerprint: fp })),
    ).toBe("config_changed");
    expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("edit\n");
  });

  test("branchExists checks a local branch and refuses an unsafe name", async () => {
    const f = setup();
    expect(await f.wf.branchExists(f.repo, "main")).toBe(true);
    expect(await f.wf.branchExists(f.repo, "synapse/none")).toBe(false);
    expect(await codeOf(f.wf.branchExists(f.repo, "-x"))).toBe("invalid_ref");
  });
});

describe("no configured auto-resolution or rewriting (review fixes)", () => {
  test("branch.<parent>.mergeOptions=-Xtheirs cannot resolve an updateParent conflict", async () => {
    const f = setup();
    await f.wf.createTaskBranch(f.repo, "stage", "synapse/t");
    git(f.repo, "config", "branch.stage.mergeOptions", "-Xtheirs");
    git(f.repo, "config", "rerere.enabled", "true");
    const o = pushCommit(f, f.origin, "stage", "a.txt", "origin\n");
    pushCommit(f, f.upstream, "stage", "a.txt", "upstream\n");
    expect(await f.wf.updateParent(f.repo, "stage")).toEqual({ ok: false, conflict: true });
    expect(mergeHead(f.repo)).toBe(false);
    expect(git(f.repo, "status", "--porcelain")).toBe("");
    expect(head(f.repo)).toBe(o);
    const merges = f.calls.filter((c) => c.argv.includes("merge"));
    for (const m of merges) {
      expect(m.argv).toContain("branch.stage.mergeOptions=");
      expect(m.argv).toContain("rerere.enabled=false");
      expect(m.argv).toContain("rerere.autoUpdate=false");
    }
  });

  test("branch.<parent>.mergeOptions=-Xtheirs cannot resolve a mergeLocal conflict", async () => {
    const f = setup();
    await taskWithCommit(f, "a.txt", "task\n");
    pushCommit(f, f.origin, "stage", "a.txt", "parent\n");
    expect(await f.wf.updateParent(f.repo, "stage")).toEqual({ ok: true });
    git(f.repo, "config", "branch.stage.mergeOptions", "-Xtheirs");
    const before = head(f.repo);
    expect(await f.wf.mergeLocal(f.repo, "stage", "synapse/t")).toEqual({
      ok: false,
      conflict: true,
    });
    expect(mergeHead(f.repo)).toBe(false);
    expect(head(f.repo)).toBe(before);
  });

  test("pull.rebase=true never turns updateParent into a rebase", async () => {
    const f = setup();
    await f.wf.createTaskBranch(f.repo, "stage", "synapse/t");
    git(f.repo, "config", "pull.rebase", "true");
    const o = pushCommit(f, f.origin, "stage", "o.txt", "o\n");
    const u = pushCommit(f, f.upstream, "stage", "u.txt", "u\n");
    expect(await f.wf.updateParent(f.repo, "stage")).toEqual({ ok: true });
    const parents = git(f.repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
    expect(parents.slice(1)).toEqual([o, u]);
  });

  test("merge.ff=only does not stop --no-ff or the merge fallback", async () => {
    const f = setup();
    git(f.repo, "config", "merge.ff", "only");
    await taskWithCommit(f);
    pushCommit(f, f.upstream, "stage", "u.txt", "u\n");
    expect(await f.wf.updateParent(f.repo, "stage")).toEqual({ ok: true });
    const r = await f.wf.mergeLocal(f.repo, "stage", "synapse/t");
    expect(r.ok).toBe(true);
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
  });

  test("url.*.pushInsteadOf rewriting origin to upstream is refused", async () => {
    const f = setup();
    git(f.repo, "switch", "-q", "-c", "stage", "origin/stage");
    git(f.repo, "config", `url.file://${f.upstream}.pushInsteadOf`, `file://${f.origin}`);
    const before = head(f.upstream, "stage");
    expect(
      await codeOf(f.wf.pushParent(f.repo, "stage", { protectedBranches: [], upstreamUrl: null })),
    ).toBe("push_target_is_upstream");
    expect(head(f.upstream, "stage")).toBe(before);
  });

  test("the same owner/repo on another host or scheme is refused", async () => {
    const f = setup();
    git(
      f.repo,
      "remote",
      "set-url",
      "--push",
      "origin",
      "ssh://git@gh-alias/ExampleOrg/demo-app.git",
    );
    expect(
      await codeOf(
        f.wf.pushParent(f.repo, "stage", {
          protectedBranches: [],
          upstreamUrl: "https://github.com/exampleorg/demo-app",
        }),
      ),
    ).toBe("push_target_is_upstream");
  });

  test("no registered upstream URL and no upstream remote is refused", async () => {
    const f = setup();
    git(f.repo, "remote", "remove", "upstream");
    expect(
      await codeOf(f.wf.pushParent(f.repo, "stage", { protectedBranches: [], upstreamUrl: null })),
    ).toBe("no_upstream_reference");
    expect(f.calls.filter((c) => c.argv.includes("push"))).toHaveLength(0);
  });
});

describe("fingerprints (review fixes)", () => {
  test("a filter in .git/config named by .gitattributes never runs: fingerprint first", async () => {
    const f = setup();
    const base = await f.wf.gitDirFingerprint(f.repo);
    const marker = join(f.root, "filter-ran");
    const cfg = join(f.repo, ".git", "config");
    writeFileSync(
      cfg,
      `${readFileSync(cfg, "utf8")}[filter "evil"]\n\tclean = touch ${marker}; cat\n\tsmudge = cat\n`,
    );
    writeFileSync(join(f.repo, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(f.repo, "a.txt"), "changed\n");
    f.calls.length = 0;
    const d = await f.wf.diffSummary(f.repo, { gitDirBaseline: base });
    expect(d.unsafe).toBe(true);
    expect(d.unsafeReasons).toEqual(["git_dir_changed"]);
    expect(d.files).toEqual([]);
    expect(f.calls).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("a change to the global git config is detected", async () => {
    const f = setup();
    const base = await f.wf.gitDirFingerprint(f.repo);
    const cfg = await f.wf.configFingerprint(f.repo);
    writeFileSync(join(f.home, ".gitconfig"), "[core]\n\tpager = evil\n");
    expect(await f.wf.configFingerprint(f.repo)).not.toBe(cfg);
    expect((await f.wf.diffSummary(f.repo, { gitDirBaseline: base })).unsafeReasons).toEqual([
      "git_dir_changed",
    ]);
    const cfg2 = await f.wf.configFingerprint(f.repo);
    mkdirSync(join(f.xdg, "git"), { recursive: true });
    writeFileSync(join(f.xdg, "git", "attributes"), "* merge=union\n");
    expect(await f.wf.configFingerprint(f.repo)).not.toBe(cfg2);
  });

  test("the config fingerprint ignores refs and commits", async () => {
    const f = setup();
    const cfg = await f.wf.configFingerprint(f.repo);
    await taskWithCommit(f);
    expect(await f.wf.configFingerprint(f.repo)).toBe(cfg);
    writeFileSync(join(f.repo, ".git", "hooks", "pre-push"), "#!/bin/sh\n");
    expect(await f.wf.configFingerprint(f.repo)).not.toBe(cfg);
  });

  test("a stale config fingerprint refuses push, merge, update and commit before git runs", async () => {
    const f = setup();
    const stale = await f.wf.configFingerprint(f.repo);
    git(f.repo, "config", "core.sshCommand", "evil");
    f.calls.length = 0;
    const guard = { expectedConfigFingerprint: stale };
    expect(
      await codeOf(
        f.wf.pushParent(f.repo, "stage", { protectedBranches: [], upstreamUrl: null, ...guard }),
      ),
    ).toBe("config_changed");
    expect(await codeOf(f.wf.updateParent(f.repo, "stage", guard))).toBe("config_changed");
    expect(await codeOf(f.wf.mergeLocal(f.repo, "stage", "synapse/t", guard))).toBe(
      "config_changed",
    );
    expect(await codeOf(f.wf.commitAll(f.repo, "m", "x", guard))).toBe("config_changed");
    expect(f.calls).toHaveLength(0);
    // (switch -c from a remote branch writes tracking config, so fingerprint after it)
    git(f.repo, "switch", "-q", "-c", "stage", "origin/stage");
    const fresh = await f.wf.configFingerprint(f.repo);
    expect(
      await f.wf.pushParent(f.repo, "stage", {
        protectedBranches: [],
        upstreamUrl: null,
        expectedConfigFingerprint: fresh,
      }),
    ).toEqual({ ok: true });
  });

  test("commitAll re-checks the git dir baseline", async () => {
    const f = setup();
    const base = await f.wf.gitDirFingerprint(f.repo);
    writeFileSync(join(f.repo, "a.txt"), "edit\n");
    const { hash } = await f.wf.diffSummary(f.repo, { gitDirBaseline: base });
    writeFileSync(join(f.repo, ".git", "hooks", "x"), "#!/bin/sh\n");
    expect(await codeOf(f.wf.commitAll(f.repo, "m", hash, { gitDirBaseline: base }))).toBe(
      "unsafe_change",
    );
  });
});

describe("sandbox placeholders (ADR-040, Task 4b)", () => {
  /** What the Claude Code sandbox (CLI 2.1.319) leaves behind, as observed on the real CLI. */
  const GIT_DIRS = [
    "branches",
    "remotes",
    "objects/info/commit-graphs",
    "info/.claude-sandbox-noreplace",
    "objects/info/.claude-sandbox-noreplace",
    "objects/info/commit-graphs/.claude-sandbox-noreplace",
  ];
  const GIT_FILES = ["config.worktree", "objects/info/alternates"];
  /** Leaves the exact observed placeholder set (zero-byte files, empty dirs). */
  function leavePlaceholders(repo: string, skip: string[] = []): void {
    for (const d of GIT_DIRS) {
      if (!skip.includes(d)) mkdirSync(join(repo, ".git", d), { recursive: true });
    }
    for (const fl of GIT_FILES) {
      if (!skip.includes(fl)) writeFileSync(join(repo, ".git", fl), "");
    }
    mkdirSync(join(repo, ".claude", ".cc-writes"), { recursive: true });
  }
  /** A fixture with none of the placeholders present (some git templates ship `branches/`). */
  function bare(): Fixture {
    const f = setup();
    rmSync(join(f.repo, ".git", "branches"), { recursive: true, force: true });
    return f;
  }

  test("the exact observed set is removed and the git dir fingerprint matches again", async () => {
    const f = bare();
    const base = await f.wf.gitDirFingerprint(f.repo);
    const before = await f.wf.sandboxPlaceholders(f.repo);
    expect(before).toEqual([]);
    leavePlaceholders(f.repo);
    expect(await f.wf.gitDirFingerprint(f.repo)).not.toBe(base);
    writeFileSync(join(f.repo, "a.txt"), "edit\n");
    f.calls.length = 0;
    // 8 under .git, plus .claude/.cc-writes and the new, now empty .claude.
    expect(await f.wf.removeSandboxPlaceholders(f.repo, before)).toBe(10);
    expect(f.calls).toHaveLength(0); // filesystem only, no git command
    expect(existsSync(join(f.repo, ".claude"))).toBe(false);
    for (const p of [...GIT_DIRS, ...GIT_FILES]) {
      expect(existsSync(join(f.repo, ".git", p))).toBe(false);
    }
    expect(existsSync(join(f.repo, ".git", "objects", "info"))).toBe(true);
    expect(await f.wf.gitDirFingerprint(f.repo)).toBe(base);
    const d = await f.wf.diffSummary(f.repo, { gitDirBaseline: base });
    expect(d.unsafe).toBe(false);
    expect(d.files.map((x) => x.path)).toEqual(["a.txt"]);
  });

  test("pre-existing paths are kept: an empty .git/branches and a .claude dir", async () => {
    const f = bare();
    mkdirSync(join(f.repo, ".git", "branches"));
    mkdirSync(join(f.repo, ".claude"));
    const base = await f.wf.gitDirFingerprint(f.repo);
    const before = await f.wf.sandboxPlaceholders(f.repo);
    expect(before).toEqual([".claude", ".git/branches"]);
    leavePlaceholders(f.repo);
    expect(await f.wf.removeSandboxPlaceholders(f.repo, before)).toBe(8);
    expect(existsSync(join(f.repo, ".git", "branches"))).toBe(true);
    expect(existsSync(join(f.repo, ".claude"))).toBe(true);
    expect(existsSync(join(f.repo, ".claude", ".cc-writes"))).toBe(false);
    expect(await f.wf.gitDirFingerprint(f.repo)).toBe(base);
  });

  test("a non-empty alternates file is kept, so the fingerprint flags the run unsafe", async () => {
    const f = bare();
    const base = await f.wf.gitDirFingerprint(f.repo);
    const before = await f.wf.sandboxPlaceholders(f.repo);
    leavePlaceholders(f.repo);
    writeFileSync(join(f.repo, ".git", "objects", "info", "alternates"), "/elsewhere/objects\n");
    expect(await f.wf.removeSandboxPlaceholders(f.repo, before)).toBe(9);
    expect(readFileSync(join(f.repo, ".git", "objects", "info", "alternates"), "utf8")).toBe(
      "/elsewhere/objects\n",
    );
    const d = await f.wf.diffSummary(f.repo, { gitDirBaseline: base });
    expect(d.unsafeReasons).toEqual(["git_dir_changed"]);
  });

  test("non-empty placeholder dirs are kept (a file anywhere inside)", async () => {
    const f = bare();
    const base = await f.wf.gitDirFingerprint(f.repo);
    const before = await f.wf.sandboxPlaceholders(f.repo);
    leavePlaceholders(f.repo);
    writeFileSync(join(f.repo, ".git", "remotes", "origin"), "URL: x\n");
    writeFileSync(join(f.repo, ".git", "objects", "info", "commit-graphs", "x.graph"), "");
    writeFileSync(join(f.repo, ".claude", ".cc-writes", "w"), "x");
    // Removed: branches, config.worktree, alternates, the three noreplace dirs.
    expect(await f.wf.removeSandboxPlaceholders(f.repo, before)).toBe(6);
    expect(readFileSync(join(f.repo, ".git", "remotes", "origin"), "utf8")).toBe("URL: x\n");
    expect(existsSync(join(f.repo, ".git", "objects", "info", "commit-graphs", "x.graph"))).toBe(
      true,
    );
    expect(existsSync(join(f.repo, ".claude", ".cc-writes", "w"))).toBe(true);
    expect((await f.wf.diffSummary(f.repo, { gitDirBaseline: base })).unsafeReasons).toEqual([
      "git_dir_changed",
    ]);
  });

  test("a symlinked placeholder is never followed or removed", async () => {
    const f = bare();
    const base = await f.wf.gitDirFingerprint(f.repo);
    const before = await f.wf.sandboxPlaceholders(f.repo);
    leavePlaceholders(f.repo, ["remotes"]);
    const outside = join(f.root, "outside");
    mkdirSync(join(outside, ".claude-sandbox-noreplace"), { recursive: true });
    mkdirSync(join(outside, "empty"));
    symlinkSync(join(outside, "empty"), join(f.repo, ".git", "remotes"));
    // A symlinked .claude: its .cc-writes is outside the repository.
    rmSync(join(f.repo, ".claude"), { recursive: true });
    mkdirSync(join(outside, "claude", ".cc-writes"), { recursive: true });
    symlinkSync(join(outside, "claude"), join(f.repo, ".claude"));
    // A symlinked dir inside .git whose target holds a noreplace dir: the walk does not enter it.
    symlinkSync(outside, join(f.repo, ".git", "info", "linked"));
    // 7 git placeholders (remotes is the symlink), none outside.
    expect(await f.wf.removeSandboxPlaceholders(f.repo, before)).toBe(7);
    expect(existsSync(join(outside, "empty"))).toBe(true);
    expect(existsSync(join(outside, ".claude-sandbox-noreplace"))).toBe(true);
    expect(existsSync(join(outside, "claude", ".cc-writes"))).toBe(true);
    expect(lstatSync(join(f.repo, ".git", "remotes")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(f.repo, ".claude")).isSymbolicLink()).toBe(true);
    expect((await f.wf.diffSummary(f.repo, { gitDirBaseline: base })).unsafeReasons).toEqual([
      "git_dir_changed",
    ]);
  });

  test("a new empty noreplace dir anywhere under .git goes; a pre-existing one stays", async () => {
    const f = bare();
    mkdirSync(join(f.repo, ".git", "logs", ".claude-sandbox-noreplace"), { recursive: true });
    const before = await f.wf.sandboxPlaceholders(f.repo);
    expect(before).toEqual([".git/logs/.claude-sandbox-noreplace"]);
    mkdirSync(join(f.repo, ".git", "refs", "heads", ".claude-sandbox-noreplace"));
    expect(await f.wf.removeSandboxPlaceholders(f.repo, before)).toBe(1);
    expect(existsSync(join(f.repo, ".git", "refs", "heads", ".claude-sandbox-noreplace"))).toBe(
      false,
    );
    expect(existsSync(join(f.repo, ".git", "logs", ".claude-sandbox-noreplace"))).toBe(true);
  });

  test("a zero-byte file named like a placeholder dir, or a dir named like a file, is kept", async () => {
    const f = bare();
    const before = await f.wf.sandboxPlaceholders(f.repo);
    writeFileSync(join(f.repo, ".git", "branches"), "");
    mkdirSync(join(f.repo, ".git", "config.worktree"));
    expect(await f.wf.removeSandboxPlaceholders(f.repo, before)).toBe(0);
    expect(lstatSync(join(f.repo, ".git", "branches")).isFile()).toBe(true);
    expect(lstatSync(join(f.repo, ".git", "config.worktree")).isDirectory()).toBe(true);
  });

  test("no .git directory (a worktree pointer file): only .claude is considered, nothing throws", async () => {
    const root = scratch();
    const repo = join(root, "wt");
    mkdirSync(repo);
    writeFileSync(join(repo, ".git"), "gitdir: /nowhere\n");
    const wf = new LocalGitWorkflow({ home: root });
    const before = await wf.sandboxPlaceholders(repo);
    expect(before).toEqual([]);
    mkdirSync(join(repo, ".claude", ".cc-writes"), { recursive: true });
    expect(await wf.removeSandboxPlaceholders(repo, before)).toBe(2);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
  });
});

describe("safer diff checks (review fixes)", () => {
  test(".gitattributes, .gitmodules and .lfsconfig changes at any depth are unsafe", async () => {
    for (const name of [".gitattributes", "sub/.gitmodules", "deep/er/.lfsconfig"]) {
      const f = setup();
      mkdirSync(join(f.repo, name, ".."), { recursive: true });
      writeFileSync(join(f.repo, name), "x\n");
      const d = await f.wf.diffSummary(f.repo);
      expect(d.unsafe).toBe(true);
      expect(d.unsafeReasons).toEqual(["git_metadata_changed"]);
    }
  });

  test("an unreadable file is unsafe and no fs error escapes", async () => {
    const f = setup();
    const p = join(f.repo, "locked.txt");
    writeFileSync(p, "secret\n");
    chmodSync(p, 0o000);
    try {
      const d = await f.wf.diffSummary(f.repo);
      expect(d.unsafeReasons).toEqual(["unreadable"]);
      expect(d.diffText).not.toContain("secret");
    } finally {
      chmodSync(p, 0o644);
    }
  });

  test("reasons are reported for symlinks and an empty list for a safe diff", async () => {
    const f = setup();
    writeFileSync(join(f.repo, "ok.txt"), "ok\n");
    expect((await f.wf.diffSummary(f.repo)).unsafeReasons).toEqual([]);
    symlinkSync("/etc/hostname", join(f.repo, "link"));
    expect((await f.wf.diffSummary(f.repo)).unsafeReasons).toEqual(["symlink_outside"]);
  });
});

describe("failure paths", () => {
  test("a git timeout surfaces as git_timeout with no detail", async () => {
    const wf = new LocalGitWorkflow({
      home: "/nonexistent",
      exec: async () => ({ code: -1, stdout: "", timedOut: true }),
    });
    expect(await codeOf(wf.currentBranch("/srv/repo"))).toBe("git_timeout");
    expect(await codeOf(wf.diffSummary("/srv/repo"))).toBe("git_timeout");
  });

  test("an unreachable origin fails the fetch with fetch_failed", async () => {
    const f = setup();
    rmSync(f.origin, { recursive: true, force: true });
    expect(await codeOf(f.wf.createTaskBranch(f.repo, "stage", "synapse/t"))).toBe("fetch_failed");
    expect(git(f.repo, "branch", "--list", "synapse/t")).toBe("");
  });

  test("a rejected push is push_failed and is never retried with force", async () => {
    const f = setup();
    git(f.repo, "switch", "-q", "-c", "stage", "origin/stage");
    writeFileSync(join(f.repo, "x.txt"), "x\n");
    git(f.repo, "add", "-A");
    git(f.repo, "commit", "-q", "-m", "x");
    const remoteTip = pushCommit(f, f.origin, "stage", "o.txt", "o\n");
    expect(
      await codeOf(f.wf.pushParent(f.repo, "stage", { protectedBranches: [], upstreamUrl: null })),
    ).toBe("push_failed");
    expect(head(f.origin, "stage")).toBe(remoteTip);
    expect(f.calls.filter((c) => c.argv.includes("push"))).toHaveLength(1);
  });
});

describe("hardening on every call (spy runner)", () => {
  test("a whole task flow runs git only as argv with the E17 flags", async () => {
    const f = setup();
    expect(await f.wf.preflight(f.repo, "stage")).toEqual({ ok: true });
    const cfg = await f.wf.configFingerprint(f.repo);
    await taskWithCommit(f);
    const base = await f.wf.gitDirFingerprint(f.repo);
    await f.wf.diffSummary(f.repo, { gitDirBaseline: base });
    await f.wf.updateParent(f.repo, "stage");
    await f.wf.mergeLocal(f.repo, "stage", "synapse/t");
    await f.wf.commitsAhead(f.repo, "stage");
    await f.wf.pushParent(f.repo, "stage", { protectedBranches: [], upstreamUrl: null });
    await f.wf.cleanup(f.repo, "synapse/t", "main", { force: false });
    // The whole flow leaves the config untouched (no tracking config, no rerere state).
    expect(await f.wf.configFingerprint(f.repo)).toBe(cfg);

    expect(f.calls.length).toBeGreaterThan(20);
    const allowedEnv = new Set([
      "PATH",
      "HOME",
      "LC_ALL",
      "GIT_TERMINAL_PROMPT",
      "GIT_OPTIONAL_LOCKS",
      "GIT_CONFIG_NOSYSTEM",
      "SSH_AUTH_SOCK",
      "XDG_RUNTIME_DIR",
      "XDG_CONFIG_HOME",
      "DBUS_SESSION_BUS_ADDRESS",
    ]);
    for (const c of f.calls) {
      expect(Array.isArray(c.argv)).toBe(true);
      expect(c.argv.every((a) => typeof a === "string")).toBe(true);
      expect(c.argv.slice(0, 7)).toEqual(["git", ...HARDENING]);
      expect(c.argv[7]).toBe("-C");
      expect(c.argv[8]).toBe(f.repo);
      expect(c.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(c.env.GIT_OPTIONAL_LOCKS).toBe("0");
      expect(c.env.HOME).toBe(f.home);
      for (const k of Object.keys(c.env)) expect(allowedEnv.has(k)).toBe(true);
      let at = 9;
      while (c.argv[at] === "-c") at += 2;
      const sub = c.argv[at] ?? "";
      const network = ["push", "fetch", "pull", "ls-remote"].includes(sub);
      expect(c.timeoutMs).toBe(network ? 120_000 : 60_000);
      expect(c.argv).not.toContain("--force");
      if (sub === "push") expect(c.argv).not.toContain("upstream");
    }
    expect(f.calls.some((c) => c.argv[9] === "push")).toBe(true);
    expect(f.calls.some((c) => c.argv[9] === "fetch")).toBe(true);
  });
});

describe("final review: local-only checks, cleanup fallbacks, origin check", () => {
  test("localState runs no remote command: it passes with origin unreachable, and reports the tree", async () => {
    const f = setup();
    rmSync(f.origin, { recursive: true, force: true });
    rmSync(f.upstream, { recursive: true, force: true });
    expect(await f.wf.localState(f.repo)).toEqual({ ok: true });
    expect(f.calls.some((c) => c.argv.some((a) => ["ls-remote", "fetch"].includes(a)))).toBe(false);
    writeFileSync(join(f.repo, "wip.txt"), "x\n");
    expect(await f.wf.localState(f.repo)).toEqual({ ok: false, reason: "dirty_tree" });
    expect(await f.wf.localState(join(f.repo, "missing"))).toEqual({
      ok: false,
      reason: "not_a_repository",
    });
    // Preflight still needs the remotes.
    rmSync(join(f.repo, "wip.txt"));
    expect(await codeOf(f.wf.preflight(f.repo, "main"))).toBe("fetch_failed");
  });

  test("cleanup with no return branch stays where it is and never deletes the checked-out task branch", async () => {
    const f = setup();
    await f.wf.createTaskBranch(f.repo, "stage", "synapse/t");
    expect(await f.wf.cleanup(f.repo, "synapse/t", null, { force: true })).toEqual({
      ok: true,
      deleted: false,
    });
    expect(await f.wf.currentBranch(f.repo)).toBe("synapse/t");
    expect(git(f.repo, "branch", "--list", "synapse/t")).not.toBe("");
    // From another branch, null still deletes (nothing is checked out on the task branch).
    git(f.repo, "switch", "-q", "main");
    expect(await f.wf.cleanup(f.repo, "synapse/t", null, { force: true })).toEqual({
      ok: true,
      deleted: true,
    });
    expect(await f.wf.currentBranch(f.repo)).toBe("main");
  });

  test("pushParent refuses when origin's effective push URL is not the registered origin (origin_changed)", async () => {
    const f = setup();
    git(f.repo, "switch", "-q", "-c", "stage", "origin/stage");
    writeFileSync(join(f.repo, "x.txt"), "x\n");
    git(f.repo, "add", "-A");
    git(f.repo, "commit", "-q", "-m", "x");
    const elsewhere = join(f.root, "elsewhere.git");
    git(f.root, "init", "-q", "--bare", elsewhere);
    const before = head(f.origin, "stage");
    const opts = (expectedOriginUrl: string | null) => ({
      protectedBranches: [],
      upstreamUrl: `file://${f.upstream}`,
      expectedOriginUrl,
    });
    // A pushInsteadOf rewrite counts: the effective URL is what git would push to.
    git(f.repo, "config", `url.file://${elsewhere}.pushInsteadOf`, `file://${f.origin}`);
    expect(await codeOf(f.wf.pushParent(f.repo, "stage", opts(`file://${f.origin}`)))).toBe(
      "origin_changed",
    );
    git(f.repo, "config", "--unset", `url.file://${elsewhere}.pushInsteadOf`);
    git(f.repo, "remote", "set-url", "--push", "origin", `file://${elsewhere}`);
    expect(await codeOf(f.wf.pushParent(f.repo, "stage", opts(`file://${f.origin}`)))).toBe(
      "origin_changed",
    );
    expect(f.calls.filter((c) => c.argv.includes("push"))).toHaveLength(0);
    expect(head(f.origin, "stage")).toBe(before);
    // The registered URL (normalised: scheme, .git and case) matches: pushed.
    git(f.repo, "remote", "set-url", "--push", "origin", `file://${f.origin}`);
    expect(
      await f.wf.pushParent(f.repo, "stage", opts(`FILE://${f.origin.replace(/\.git$/, "")}`)),
    ).toEqual({ ok: true });
  });
});

describe("origin host check (M10)", () => {
  test("same owner/repo on another host is refused; ssh vs https on github.com is the same host", () => {
    const expected = "https://github.com/acme/app.git";
    expect(sameOriginRemote("https://evil.example/acme/app.git", expected)).toBe(false);
    expect(sameOriginRemote("git@evil.example:acme/app.git", expected)).toBe(false);
    // An ssh host alias is not github.com: refused (documented).
    expect(sameOriginRemote("git@gh-work:acme/app.git", expected)).toBe(false);
    expect(sameOriginRemote("ssh://git@github.com/acme/app.git", expected)).toBe(true);
    expect(sameOriginRemote("git@github.com:acme/app.git", expected)).toBe(true);
    expect(sameOriginRemote("https://GitHub.com/Acme/App", expected)).toBe(true);
    expect(sameOriginRemote("https://github.com/acme/other", expected)).toBe(false);
  });

  test("pushParent refuses a push URL on another host with the same owner/repo", async () => {
    const f = setup();
    git(f.repo, "switch", "-q", "-c", "stage", "origin/stage");
    git(f.repo, "remote", "set-url", "--push", "origin", "https://evil.example/acme/app.git");
    const code = await codeOf(
      f.wf.pushParent(f.repo, "stage", {
        protectedBranches: [],
        upstreamUrl: `file://${f.upstream}`,
        expectedOriginUrl: "https://github.com/acme/app.git",
      }),
    );
    expect(code).toBe("origin_changed");
  });
});
