import { createHash, type Hash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  GIT_DIFF_TEXT_MAX_BYTES,
  type GitCommitOptions,
  type GitCommitSummary,
  type GitConfigGuard,
  type GitDiffFile,
  type GitDiffOptions,
  type GitDiffSummary,
  type GitLocalStateResult,
  type GitMergeOptions,
  type GitPreflightResult,
  type GitPushOptions,
  type GitUnsafeReason,
  type GitWorkflow,
  GitWorkflowError,
  type GitWorkflowErrorCode,
} from "@synapse/contracts";
import { type GitExec, type GitResult, lines, runGit } from "./git";
import { pushDisabled, stripCredentials } from "./local-git";

/**
 * The engineering git workflow (E7, E8, E10–E13, E15) over the hardened runner (E17). Every
 * command is argv with `-C <repo>`; refs are validated before they reach git and passed as full
 * `refs/heads/…` names where git accepts them. It pushes only to `origin`, with an explicit
 * non-forced refspec, and never resolves a conflict. Errors are `GitWorkflowError` with a fixed
 * code: no path, branch, URL or stderr ever reaches a message.
 */

export interface LocalGitWorkflowOptions {
  /** $HOME for git (the user's real home in production, so their credentials work). */
  home: string;
  /**
   * $XDG_CONFIG_HOME, defaulting to `<home>/.config`. Passed to git as well, so git and the config
   * fingerprint read the same `git/config` and `git/attributes`.
   */
  xdgConfigHome?: string;
  /** The system config file, fingerprinted when present; default `/etc/gitconfig`. */
  systemConfig?: string;
  binary?: string;
  /** See GitOptions.extraEnv (tests only). */
  extraEnv?: Record<string, string>;
  /** See GitOptions.exec (tests wrap spawnGit with a spy). */
  exec?: GitExec;
}

/**
 * A conservative branch-name check, stricter than `git check-ref-format --branch`: ASCII
 * letters, digits and `._/-`; no leading `-` (never an option), no `..`, no empty, dot-led or
 * `.lock` segment, no trailing `.` or `/`, and not `HEAD`.
 */
export function isSafeBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 200 || name === "HEAD") return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("-") || name.includes("..")) {
    return false;
  }
  if (name.endsWith(".")) return false;
  return name
    .split("/")
    .every((seg) => seg.length > 0 && !seg.startsWith(".") && !seg.endsWith(".lock"));
}

/**
 * A comparable key for a remote URL (E13): credentials, scheme, login, a trailing `/` and `.git`
 * dropped, scp-style and `ssh://` forms unified, lower-cased (conservative: GitHub paths are
 * case-insensitive). Local paths and `file://` URLs share a `file:` key. Null for a disabled URL.
 */
export function remoteKey(url: string): string | null {
  let u = stripCredentials(url.trim());
  const helper = /^[A-Za-z][A-Za-z0-9+.-]*::(.*)$/s.exec(u);
  if (helper) u = helper[1] ?? "";
  if (pushDisabled(u)) return null;
  const tidy = (p: string) =>
    p
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/s.exec(u);
  if (m) {
    const scheme = (m[1] ?? "").toLowerCase();
    if (scheme === "file") return `file:${tidy(m[3] ?? "")}`.toLowerCase();
    // Login and port dropped: a different port on the same host still counts as the same repo.
    const host = (m[2] ?? "").slice((m[2] ?? "").lastIndexOf("@") + 1).replace(/:\d*$/, "");
    return `${host}/${tidy(m[3] ?? "").replace(/^\/+/, "")}`.toLowerCase();
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/s.exec(u);
  if (scp && !u.startsWith("/")) {
    return `${scp[1]}/${tidy(scp[2] ?? "").replace(/^\/+/, "")}`.toLowerCase();
  }
  return `file:${tidy(u)}`.toLowerCase();
}

/** The last two path segments of a remote key (`owner/repo` on GitHub-style hosts), or null. */
export function ownerRepo(key: string): string | null {
  const parts = key
    .replace(/^file:/, "")
    .split("/")
    .filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : null;
}

/** The host of a non-`file:` remote key, or null for local paths. */
function remoteHost(key: string): string | null {
  if (key.startsWith("file:")) return null;
  return key.split("/")[0] ?? null;
}

/**
 * M10: does push URL `url` point at the registered origin? Same `owner/repo`, and for non-`file:`
 * URLs the same host too. remoteKey already lower-cases the host and unifies `ssh://git@h/...`,
 * `git@h:...` and `https://h/...`. An ssh host alias (`~/.ssh/config` Host) is not the real host,
 * so it counts as a mismatch (origin_changed); users with host aliases will see this.
 */
export function sameOriginRemote(url: string, expectedUrl: string | null): boolean {
  const k = remoteKey(url);
  const expected = expectedUrl === null ? null : remoteKey(expectedUrl);
  if (!k || !expected) return false;
  if (k === expected) return true;
  const or = ownerRepo(k);
  if (or === null || or !== ownerRepo(expected)) return false;
  // A `file:` push URL has no host to compare (test fixtures map a registered GitHub URL to a
  // local bare repository); only network URLs must match the registered host.
  const host = remoteHost(k);
  return host === null || host === remoteHost(expected);
}

/**
 * Per-call config for every merge: no `branch.<parent>.mergeOptions` (it could add `-Xtheirs`
 * and silently resolve a conflict), no rerere replaying a recorded resolution, no submodule
 * recursion (`git merge` has no `--no-recurse-submodules` flag).
 */
function mergeGuard(parent: string): string[] {
  return [
    "-c",
    `branch.${parent}.mergeOptions=`,
    "-c",
    "rerere.enabled=false",
    "-c",
    "rerere.autoUpdate=false",
    "-c",
    "submodule.recurse=false",
  ];
}

/** Files that can name filters, merge drivers, submodules or LFS endpoints (any depth). */
const GIT_METADATA_FILES = new Set([".gitattributes", ".gitmodules", ".lfsconfig"]);

const MERGE_STATE = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

/** Directories never hashed into the git-dir fingerprint (at any depth): object stores, reflogs. */
const FINGERPRINT_SKIP_DIRS = new Set(["objects", "logs"]);
/**
 * Top-level `.git` files that git and tools rewrite routinely and that never run code: the index
 * (Claude Code and test runners refresh its stat cache), transient heads, lock files and the
 * editor scratch file. Config, hooks, info/, HEAD and refs stay fingerprinted.
 */
const FINGERPRINT_SKIP_TOP_FILES = new Set([
  "index",
  "FETCH_HEAD",
  "ORIG_HEAD",
  "COMMIT_EDITMSG",
  "AUTO_MERGE",
  "gc.log",
]);

interface StatusEntry {
  xy: string;
  path: string;
}

type EntryKind = "file" | "link" | "missing" | "other" | "unreadable";

interface CollectedEntry extends StatusEntry {
  kind: EntryKind;
}

interface Collected {
  head: string;
  entries: CollectedEntry[];
  files: GitDiffFile[];
  hash: string;
  reasons: Set<GitUnsafeReason>;
}

/** sha256 of a file's content (following symlinks), or a fixed marker; never throws. */
function fileMarker(path: string): string {
  try {
    return sha256(readFileSync(path));
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable";
  }
}

function within(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

function hasDotGitSegment(rel: string): boolean {
  return rel.split("/").some((s) => s.toLowerCase() === ".git");
}

/** Lines in a text file (a final line without `\n` counts); 0 for binary content. */
function countLines(buf: Buffer): number {
  if (buf.includes(0)) return 0;
  if (buf.length === 0) return 0;
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export class LocalGitWorkflow implements GitWorkflow {
  constructor(private readonly opts: LocalGitWorkflowOptions) {}

  // ---- E7 ------------------------------------------------------------------------------------

  async preflight(
    repo: string,
    parent: string,
    opts: { allowUpstreamPush?: boolean } = {},
  ): Promise<GitPreflightResult> {
    this.ref(parent);
    const local = await this.localState(repo);
    if (!local.ok) return local;
    const remotes = new Set(lines(await this.must(repo, ["remote"])));
    if (!remotes.has("origin") || !remotes.has("upstream")) {
      return { ok: false, reason: "missing_remote" };
    }
    if (!opts.allowUpstreamPush) {
      const pushUrls = lines(
        await this.must(repo, ["remote", "get-url", "--push", "--all", "upstream"]),
      );
      if (pushUrls.length === 0 || pushUrls.some((u) => !pushDisabled(u))) {
        return { ok: false, reason: "upstream_push_enabled" };
      }
    }
    if (!(await this.remoteHasBranch(repo, "origin", parent))) {
      return { ok: false, reason: "parent_missing_origin" };
    }
    if (!(await this.remoteHasBranch(repo, "upstream", parent))) {
      return { ok: false, reason: "parent_missing_upstream" };
    }
    return { ok: true };
  }

  async localState(repo: string): Promise<GitLocalStateResult> {
    let real: string;
    try {
      real = realpathSync(repo);
    } catch {
      return { ok: false, reason: "not_a_repository" };
    }
    const top = await this.git(repo, ["rev-parse", "--show-toplevel"]);
    if (top.timedOut) throw new GitWorkflowError("git_timeout");
    if (top.code !== 0 || top.stdout.trim() !== real || real !== repo) {
      return { ok: false, reason: "not_a_repository" };
    }
    if (await this.mergeInProgress(repo)) return { ok: false, reason: "merge_in_progress" };
    if (await this.dirty(repo)) return { ok: false, reason: "dirty_tree" };
    return { ok: true };
  }

  async currentBranch(repo: string): Promise<string | null> {
    const r = await this.git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (r.code === 0) return r.stdout.trim() || null;
    if (r.code === 1) return null;
    throw new GitWorkflowError(r.timedOut ? "git_timeout" : "git_failed");
  }

  // ---- E8 ------------------------------------------------------------------------------------

  async createTaskBranch(
    repo: string,
    parent: string,
    taskBranch: string,
  ): Promise<{ baseSha: string }> {
    this.ref(parent);
    this.ref(taskBranch);
    if ((await this.mergeInProgress(repo)) || (await this.dirty(repo))) {
      throw new GitWorkflowError("dirty_tree");
    }
    if (await this.refExists(repo, `refs/heads/${taskBranch}`)) {
      throw new GitWorkflowError("branch_exists");
    }
    await this.fetchParent(repo, "origin", parent);
    await this.fetchParent(repo, "upstream", parent);
    const local = `refs/heads/${parent}`;
    const tracking = `refs/remotes/origin/${parent}`;
    const target = (
      await this.must(repo, ["rev-parse", "--verify", `${tracking}^{commit}`])
    ).trim();
    if (!(await this.refExists(repo, local))) {
      await this.must(repo, ["branch", "--no-track", parent, tracking]);
    } else {
      const current = (
        await this.must(repo, ["rev-parse", "--verify", `${local}^{commit}`])
      ).trim();
      const ff = await this.git(repo, ["merge-base", "--is-ancestor", local, tracking]);
      if (ff.timedOut) throw new GitWorkflowError("git_timeout");
      // Fast-forward only: a local parent with commits of its own is left as it is.
      if (ff.code === 0 && current !== target) {
        if ((await this.currentBranch(repo)) === parent) {
          await this.must(repo, [
            ...mergeGuard(parent),
            "merge",
            "--ff-only",
            "--no-autostash",
            tracking,
          ]);
        } else {
          await this.must(repo, ["update-ref", local, target, current]);
        }
      }
    }
    await this.must(repo, [
      "switch",
      "--no-track",
      "--no-recurse-submodules",
      "-c",
      taskBranch,
      local,
    ]);
    return { baseSha: (await this.must(repo, ["rev-parse", "--verify", "HEAD"])).trim() };
  }

  // ---- E10 -----------------------------------------------------------------------------------

  async configFingerprint(repo: string): Promise<string> {
    const { gitDir, common } = this.gitDirs(repo);
    const h = createHash("sha256");
    const file = (label: string, path: string) => h.update(`${label}\0${fileMarker(path)}\0`);
    file("config", join(common, "config"));
    file("config.worktree", join(common, "config.worktree"));
    if (gitDir !== common) file("worktree/config.worktree", join(gitDir, "config.worktree"));
    file("info/attributes", join(common, "info", "attributes"));
    h.update("hooks\0");
    this.walk(h, join(common, "hooks"), "", null);
    file("global", join(this.opts.home, ".gitconfig"));
    file("xdg/config", join(this.xdg, "git", "config"));
    file("xdg/attributes", join(this.xdg, "git", "attributes"));
    file("system", this.opts.systemConfig ?? "/etc/gitconfig");
    return h.digest("hex");
  }

  async gitDirFingerprint(repo: string): Promise<string> {
    const { gitDir, common } = this.gitDirs(repo);
    const h = createHash("sha256");
    h.update(`config\0${await this.configFingerprint(repo)}\0`);
    // `.git` at the top may be a file (worktree pointer) or a symlink: its content counts too.
    const dotGit = join(repo, ".git");
    try {
      const st = lstatSync(dotGit);
      if (st.isSymbolicLink()) h.update(`dotgit-link\0${readlinkSync(dotGit)}\0`);
      else if (st.isFile()) h.update(`dotgit-file\0${fileMarker(dotGit)}\0`);
    } catch {
      h.update("dotgit-unreadable\0");
    }
    h.update(`common\0${common}\0`);
    this.walk(h, common, "", gitDir === common ? null : "worktrees");
    if (gitDir !== common) {
      h.update(`gitdir\0${gitDir}\0`);
      this.walk(h, gitDir, "", null);
    }
    return h.digest("hex");
  }

  async diffSummary(repo: string, opts: GitDiffOptions = {}): Promise<GitDiffSummary> {
    // Fingerprint first: a changed config could name a filter that status or diff would run.
    if (
      opts.gitDirBaseline !== undefined &&
      (await this.gitDirFingerprint(repo)) !== opts.gitDirBaseline
    ) {
      return {
        files: [],
        hash: "",
        unsafe: true,
        unsafeReasons: ["git_dir_changed"],
        diffText: "",
        truncated: false,
      };
    }
    const c = await this.collect(repo);
    const { text, truncated } = await this.diffText(repo, c.entries);
    const unsafeReasons = [...c.reasons].sort();
    return {
      files: c.files,
      hash: c.hash,
      unsafe: unsafeReasons.length > 0,
      unsafeReasons,
      diffText: text,
      truncated,
    };
  }

  async commitAll(
    repo: string,
    message: string,
    expectedHash: string,
    opts: GitCommitOptions = {},
  ): Promise<{ sha: string }> {
    await this.guardConfig(repo, opts);
    if (
      opts.gitDirBaseline !== undefined &&
      (await this.gitDirFingerprint(repo)) !== opts.gitDirBaseline
    ) {
      throw new GitWorkflowError("unsafe_change");
    }
    const before = await this.collect(repo);
    if (before.files.length === 0) throw new GitWorkflowError("nothing_to_commit");
    if (before.reasons.size > 0) throw new GitWorkflowError("unsafe_change");
    if (before.hash !== expectedHash) throw new GitWorkflowError("diff_changed");
    await this.must(repo, ["add", "-A"]);
    // Re-check after staging: the index must hold exactly the approved state, with nothing
    // left unstaged (Y column) or untracked.
    const after = await this.collect(repo);
    const unstaged = after.entries.some((e) => e.xy[1] !== " ");
    if (after.reasons.size > 0 || after.hash !== expectedHash || unstaged) {
      await this.git(repo, ["reset", "-q"]);
      throw new GitWorkflowError(after.reasons.size > 0 ? "unsafe_change" : "diff_changed");
    }
    await this.must(repo, ["commit", "-q", "--no-verify", "-m", message]);
    return { sha: (await this.must(repo, ["rev-parse", "--verify", "HEAD"])).trim() };
  }

  // ---- E11 / E12 -----------------------------------------------------------------------------

  async updateParent(
    repo: string,
    parent: string,
    opts: GitConfigGuard = {},
  ): Promise<{ ok: true } | { ok: false; conflict: true }> {
    this.ref(parent);
    await this.guardConfig(repo, opts);
    await this.requireClean(repo);
    if (!(await this.refExists(repo, `refs/heads/${parent}`))) {
      throw new GitWorkflowError("branch_missing");
    }
    await this.must(repo, ["switch", "--no-guess", "--no-recurse-submodules", parent]);
    for (const remote of ["origin", "upstream"] as const) {
      // `git pull` = fetch + merge; done in two steps so `pull.rebase` config can't make it a rebase.
      await this.fetchParent(repo, remote, parent);
      const ref = `refs/remotes/${remote}/${parent}`;
      const ff = await this.git(repo, [
        ...mergeGuard(parent),
        "merge",
        "--ff-only",
        "--no-edit",
        "--no-autostash",
        ref,
      ]);
      if (ff.timedOut) throw new GitWorkflowError("git_timeout");
      if (ff.code === 0) continue;
      // Remote content: the user's merge.verifySignatures policy (if any) is left in force.
      const msg = `Merge branch '${parent}' of ${remote} into ${parent}`;
      if (!(await this.merge(repo, parent, ["--ff", "-m", msg, ref]))) {
        return { ok: false, conflict: true };
      }
    }
    return { ok: true };
  }

  async mergeLocal(
    repo: string,
    parent: string,
    taskBranch: string,
    opts: GitMergeOptions = {},
  ): Promise<{ ok: true; sha: string } | { ok: false; conflict: true }> {
    this.ref(parent);
    this.ref(taskBranch);
    await this.guardConfig(repo, opts);
    await this.requireClean(repo);
    for (const b of [parent, taskBranch]) {
      if (!(await this.refExists(repo, `refs/heads/${b}`))) {
        throw new GitWorkflowError("branch_missing");
      }
    }
    if ((await this.currentBranch(repo)) !== parent) {
      await this.must(repo, ["switch", "--no-guess", "--no-recurse-submodules", parent]);
    }
    let target = `refs/heads/${taskBranch}`;
    if (opts.commit !== undefined) {
      if ((await this.branchTip(repo, taskBranch)) !== opts.commit) {
        throw new GitWorkflowError("branch_moved");
      }
      target = opts.commit;
    }
    const msg = `Merge branch '${taskBranch}' into ${parent}`;
    // --no-verify-signatures only here: this merges Synapse's own local task branch (its commit
    // is made unsigned-or-not by the user's config), never remote content.
    const args = ["--no-ff", "--no-verify-signatures", "-m", msg, target];
    if (!(await this.merge(repo, parent, args))) {
      return { ok: false, conflict: true };
    }
    return { ok: true, sha: (await this.must(repo, ["rev-parse", "--verify", "HEAD"])).trim() };
  }

  // ---- E13 -----------------------------------------------------------------------------------

  async pushParent(repo: string, parent: string, opts: GitPushOptions): Promise<{ ok: true }> {
    this.ref(parent);
    if (opts.protectedBranches.includes(parent)) throw new GitWorkflowError("protected_branch");
    await this.guardConfig(repo, opts);
    const remotes = new Set(lines(await this.must(repo, ["remote"])));
    if (!remotes.has("origin")) throw new GitWorkflowError("missing_remote");
    if (!opts.upstreamUrl && !remotes.has("upstream")) {
      throw new GitWorkflowError("no_upstream_reference");
    }
    const upstreamKeys = new Set<string>();
    const upstreamRepos = new Set<string>();
    const add = (u: string | null) => {
      const k = u === null ? null : remoteKey(u);
      if (!k) return;
      upstreamKeys.add(k);
      const or = ownerRepo(k);
      if (or) upstreamRepos.add(or);
    };
    add(opts.upstreamUrl);
    if (remotes.has("upstream")) {
      for (const u of lines(await this.must(repo, ["remote", "get-url", "--all", "upstream"])))
        add(u);
    }
    const pushUrls = lines(
      await this.must(repo, ["remote", "get-url", "--push", "--all", "origin"]),
    );
    // The same URL, or the same owner/repo under another host alias or scheme.
    const isUpstream = (u: string) => {
      const k = remoteKey(u);
      if (!k) return false;
      const or = ownerRepo(k);
      return upstreamKeys.has(k) || (or !== null && upstreamRepos.has(or));
    };
    if (pushUrls.some(isUpstream)) {
      throw new GitWorkflowError("push_target_is_upstream");
    }
    if (opts.expectedOriginUrl !== undefined) {
      // The effective URLs (insteadOf/pushInsteadOf expanded) must all be the registered origin.
      const isOrigin = (u: string) => sameOriginRemote(u, opts.expectedOriginUrl ?? null);
      if (pushUrls.length === 0 || !pushUrls.every(isOrigin)) {
        throw new GitWorkflowError("origin_changed");
      }
    }
    if (!(await this.refExists(repo, `refs/heads/${parent}`))) {
      throw new GitWorkflowError("branch_missing");
    }
    let source = `refs/heads/${parent}`;
    if (opts.expectedSha !== undefined) {
      if ((await this.branchTip(repo, parent)) !== opts.expectedSha) {
        throw new GitWorkflowError("branch_moved");
      }
      source = opts.expectedSha;
    }
    const r = await this.git(repo, [
      "push",
      "--no-follow-tags",
      "--recurse-submodules=no",
      "--no-signed",
      "--no-verify",
      "origin",
      `${source}:refs/heads/${parent}`,
    ]);
    if (r.timedOut) throw new GitWorkflowError("git_timeout");
    if (r.code !== 0) throw new GitWorkflowError("push_failed");
    return { ok: true };
  }

  async discardChanges(
    repo: string,
    expectedHash: string,
    opts: GitConfigGuard = {},
  ): Promise<{ ok: true }> {
    await this.guardConfig(repo, opts);
    if (await this.mergeInProgress(repo)) throw new GitWorkflowError("dirty_tree");
    const c = await this.collect(repo);
    if (c.files.length === 0) return { ok: true };
    if (c.reasons.size > 0) throw new GitWorkflowError("unsafe_change");
    if (c.hash !== expectedHash) throw new GitWorkflowError("diff_changed");
    const untracked = c.entries.filter((e) => e.xy === "??").map((e) => `:(literal)${e.path}`);
    await this.must(repo, ["reset", "-q", "--hard", "--no-recurse-submodules", "HEAD"]);
    if (untracked.length > 0) await this.must(repo, ["clean", "-f", "-q", "--", ...untracked]);
    if (await this.dirty(repo)) throw new GitWorkflowError("dirty_tree");
    return { ok: true };
  }

  async branchExists(repo: string, name: string): Promise<boolean> {
    this.ref(name);
    return this.refExists(repo, `refs/heads/${name}`);
  }

  async branchTip(repo: string, name: string): Promise<string | null> {
    this.ref(name);
    const r = await this.git(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${name}^{commit}`,
    ]);
    if (r.timedOut) throw new GitWorkflowError("git_timeout");
    if (r.code !== 0) return null;
    return r.stdout.trim() || null;
  }

  async commitsAhead(repo: string, parent: string): Promise<GitCommitSummary[]> {
    this.ref(parent);
    const tracking = `refs/remotes/origin/${parent}`;
    const local = `refs/heads/${parent}`;
    if (!(await this.refExists(repo, tracking)) || !(await this.refExists(repo, local))) {
      throw new GitWorkflowError("branch_missing");
    }
    const out = await this.must(repo, [
      "log",
      "-z",
      "--no-color",
      "--no-show-signature",
      "--max-count=500",
      "--format=%H%x00%s",
      `${tracking}..${local}`,
    ]);
    const parts = out.split("\0");
    const commits: GitCommitSummary[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const sha = (parts[i] ?? "").trim();
      if (sha) commits.push({ sha, subject: parts[i + 1] ?? "" });
    }
    return commits;
  }

  // ---- E15 -----------------------------------------------------------------------------------

  async cleanup(
    repo: string,
    taskBranch: string,
    returnTo: string | null,
    opts: { force: boolean },
  ): Promise<{ ok: true; deleted: boolean } | { ok: false; dirty: true }> {
    this.ref(taskBranch);
    if (returnTo !== null) this.ref(returnTo);
    if ((await this.mergeInProgress(repo)) || (await this.dirty(repo))) {
      return { ok: false, dirty: true };
    }
    if (returnTo !== null && (await this.currentBranch(repo)) !== returnTo) {
      if (!(await this.refExists(repo, `refs/heads/${returnTo}`))) {
        throw new GitWorkflowError("branch_missing");
      }
      await this.must(repo, ["switch", "--no-guess", "--no-recurse-submodules", returnTo]);
    }
    const task = `refs/heads/${taskBranch}`;
    if (!(await this.refExists(repo, task))) return { ok: true, deleted: false };
    // Never delete the branch that is checked out (no return branch to go to).
    if ((await this.currentBranch(repo)) === taskBranch) return { ok: true, deleted: false };
    if (!opts.force) {
      const containing = lines(
        await this.must(repo, [
          "for-each-ref",
          "--format=%(refname)",
          "--contains",
          task,
          "refs/heads",
        ]),
      );
      if (!containing.some((r) => r !== task)) return { ok: true, deleted: false };
    }
    await this.must(repo, ["branch", "-D", taskBranch]);
    return { ok: true, deleted: true };
  }

  // ---- internals -----------------------------------------------------------------------------

  private get xdg(): string {
    return this.opts.xdgConfigHome ?? join(this.opts.home, ".config");
  }

  private git(repo: string, args: string[]): Promise<GitResult> {
    return runGit(repo, args, {
      home: this.opts.home,
      binary: this.opts.binary,
      extraEnv: { ...(this.opts.extraEnv ?? {}), XDG_CONFIG_HOME: this.xdg },
      exec: this.opts.exec,
    });
  }

  /** Refuses with `config_changed`, before any git command, when the config moved. */
  private async guardConfig(repo: string, opts: GitConfigGuard): Promise<void> {
    if (opts.expectedConfigFingerprint === undefined) return;
    if ((await this.configFingerprint(repo)) !== opts.expectedConfigFingerprint) {
      throw new GitWorkflowError("config_changed");
    }
  }

  /**
   * The git dir and common dir from the filesystem alone (no git command): `.git` as a
   * directory, a symlink, or a `gitdir:` file, plus `commondir` for a linked worktree.
   */
  private gitDirs(repo: string): { gitDir: string; common: string } {
    const dot = join(repo, ".git");
    let gitDir: string;
    try {
      const st = lstatSync(dot);
      if (st.isDirectory()) gitDir = dot;
      else if (st.isSymbolicLink()) gitDir = realpathSync(dot);
      else {
        const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(dot, "utf8"));
        if (!m?.[1]) throw new Error("no gitdir");
        gitDir = resolve(repo, m[1]);
      }
    } catch {
      throw new GitWorkflowError("git_failed");
    }
    let common = gitDir;
    try {
      common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
    } catch {
      // No commondir: the git dir is the common dir.
    }
    return { gitDir, common };
  }

  /** stdout of a command that must succeed, else a fixed-code error. */
  private async must(repo: string, args: string[], code: GitWorkflowErrorCode = "git_failed") {
    const r = await this.git(repo, args);
    if (r.timedOut) throw new GitWorkflowError("git_timeout");
    if (r.code !== 0) throw new GitWorkflowError(code);
    return r.stdout;
  }

  private ref(name: string): void {
    if (!isSafeBranchName(name)) throw new GitWorkflowError("invalid_ref");
  }

  private async refExists(repo: string, ref: string): Promise<boolean> {
    const r = await this.git(repo, ["show-ref", "--verify", "--quiet", ref]);
    if (r.timedOut) throw new GitWorkflowError("git_timeout");
    return r.code === 0;
  }

  private async remoteHasBranch(repo: string, remote: string, branch: string): Promise<boolean> {
    const ref = `refs/heads/${branch}`;
    const r = await this.git(repo, ["ls-remote", "--exit-code", remote, ref]);
    if (r.timedOut) throw new GitWorkflowError("git_timeout");
    if (r.code === 2) return false;
    if (r.code !== 0) throw new GitWorkflowError("fetch_failed");
    return lines(r.stdout).some((l) => l.endsWith(`\t${ref}`));
  }

  private async fetchParent(repo: string, remote: string, parent: string): Promise<void> {
    await this.must(
      repo,
      [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        remote,
        `+refs/heads/${parent}:refs/remotes/${remote}/${parent}`,
      ],
      "fetch_failed",
    );
  }

  private async mergeInProgress(repo: string): Promise<boolean> {
    const gitDir = (await this.must(repo, ["rev-parse", "--absolute-git-dir"])).trim();
    return MERGE_STATE.some((f) => existsSync(join(gitDir, f)));
  }

  private async status(repo: string): Promise<StatusEntry[]> {
    const out = await this.must(repo, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--ignore-submodules=none",
    ]);
    const parts = out.split("\0");
    const entries: StatusEntry[] = [];
    for (let i = 0; i < parts.length; i++) {
      const rec = parts[i] ?? "";
      if (rec.length < 4) continue;
      const xy = rec.slice(0, 2);
      entries.push({ xy, path: rec.slice(3) });
      // A rename or copy carries its source path as the next record.
      if (xy.includes("R") || xy.includes("C")) {
        const from = parts[++i];
        if (from) entries.push({ xy: "D ", path: from });
      }
    }
    return entries;
  }

  private async dirty(repo: string): Promise<boolean> {
    return (await this.status(repo)).length > 0;
  }

  private async requireClean(repo: string): Promise<void> {
    if ((await this.mergeInProgress(repo)) || (await this.dirty(repo))) {
      throw new GitWorkflowError("dirty_tree");
    }
  }

  /**
   * `git merge --no-edit <args>`; on failure, an in-progress merge (a conflict) is aborted and
   * false returned. A failure that left no merge state is an error, not a conflict.
   */
  private async merge(repo: string, parent: string, args: string[]): Promise<boolean> {
    const r = await this.git(repo, [
      ...mergeGuard(parent),
      "merge",
      "--no-edit",
      "--no-autostash",
      ...args,
    ]);
    if (r.timedOut) throw new GitWorkflowError("git_timeout");
    if (r.code === 0) return true;
    if (!(await this.mergeInProgress(repo))) throw new GitWorkflowError("git_failed");
    await this.must(repo, [...mergeGuard(parent), "merge", "--abort"]);
    if (await this.mergeInProgress(repo)) throw new GitWorkflowError("git_failed");
    return false;
  }

  /**
   * Hashes a directory tree (sorted): file content and mode, symlink targets; no object stores
   * or reflogs at any depth. Never throws: an unreadable entry hashes as a fixed marker.
   */
  private walk(h: Hash, root: string, rel: string, skipTop: string | null): void {
    let names: string[];
    try {
      names = readdirSync(join(root, rel)).sort();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      h.update(`${code === "ENOENT" ? "M" : "U"}\0${rel}\0`);
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && name === skipTop) continue;
      const full = join(root, r);
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) {
          h.update(`L\0${r}\0${readlinkSync(full)}\0`);
        } else if (st.isDirectory()) {
          if (FINGERPRINT_SKIP_DIRS.has(name)) {
            // Object stores and reflogs are skipped; alternates could point objects elsewhere.
            if (r === "objects") {
              for (const alt of ["objects/info/alternates", "objects/info/http-alternates"]) {
                h.update(`F\0${alt}\0${fileMarker(join(root, alt))}\0`);
              }
            }
            continue;
          }
          h.update(`D\0${r}\0`);
          this.walk(h, root, r, null);
        } else if (st.isFile()) {
          if (!rel && (FINGERPRINT_SKIP_TOP_FILES.has(name) || name.endsWith(".lock"))) continue;
          h.update(`F\0${r}\0${st.mode}\0${fileMarker(full)}\0`);
        } else {
          h.update(`O\0${r}\0`);
        }
      } catch {
        h.update(`U\0${r}\0`);
      }
    }
  }

  /**
   * Status, per-file counts, the staging-invariant hash, and the path safety check. The hash
   * covers HEAD plus, for every changed path, its kind, mode and content (or symlink target)
   * as it is on disk; so any edit changes it while `git add` does not.
   */
  private async collect(repo: string): Promise<Collected> {
    const head = (await this.must(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const statusEntries = await this.status(repo);
    const byPath = new Map<string, StatusEntry>();
    for (const e of statusEntries) if (!byPath.has(e.path)) byPath.set(e.path, e);
    const sorted = [...byPath.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );

    const counts = new Map<string, { added: number; removed: number }>();
    const numstat = await this.must(repo, [
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "HEAD",
    ]);
    for (const rec of numstat.split("\0")) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec.replace(/^\n/, ""));
      if (m) {
        counts.set(m[3] ?? "", {
          added: m[1] === "-" ? 0 : Number(m[1]),
          removed: m[2] === "-" ? 0 : Number(m[2]),
        });
      }
    }

    let real: string;
    try {
      real = realpathSync(repo);
    } catch {
      throw new GitWorkflowError("git_failed");
    }
    const h = createHash("sha256");
    h.update(`head\0${head}\0`);
    const reasons = new Set<GitUnsafeReason>();
    const files: GitDiffFile[] = [];
    const entries: CollectedEntry[] = [];
    for (const e of sorted) {
      const untracked = e.xy === "??";
      const check = this.inspectPath(real, e.path, e.xy);
      for (const r of check.reasons) reasons.add(r);
      entries.push({ ...e, kind: check.kind });
      h.update(`${e.path}\0${check.fingerprint}\0`);
      const n = counts.get(e.path);
      if (untracked) files.push({ path: e.path, added: check.lines, removed: 0 });
      else files.push({ path: e.path, added: n?.added ?? 0, removed: n?.removed ?? 0 });
    }
    return { head, entries, files, hash: h.digest("hex"), reasons };
  }

  /**
   * Safety and content fingerprint of one changed path. Never follows a symlink and never
   * throws: a filesystem error becomes the `unreadable` reason (no raw error, no path escapes).
   */
  private inspectPath(
    real: string,
    rel: string,
    xy: string,
  ): { reasons: GitUnsafeReason[]; kind: EntryKind; fingerprint: string; lines: number } {
    const reasons: GitUnsafeReason[] = [];
    const segs = rel.split("/");
    if (hasDotGitSegment(rel)) reasons.push("git_path");
    if (GIT_METADATA_FILES.has((segs[segs.length - 1] ?? "").toLowerCase())) {
      reasons.push("git_metadata_changed");
    }
    const full = join(real, rel);
    if (rel.length === 0 || rel.startsWith("/") || segs.includes("..") || !within(real, full)) {
      reasons.push("outside_repo");
    }
    try {
      if (!within(real, realpathSync(dirname(full)))) reasons.push("outside_repo");
    } catch {
      // The parent directory is gone (a deleted file's directory): nothing on disk to escape.
    }
    if (rel.endsWith("/")) {
      // An embedded repository or directory entry.
      reasons.push("not_a_file");
      return { reasons, kind: "other", fingerprint: "dir", lines: 0 };
    }
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        // Deleted. A path git says still exists but that is gone cannot be verified.
        if (!xy.includes("D")) reasons.push("unreadable");
        return { reasons, kind: "missing", fingerprint: "missing", lines: 0 };
      }
      reasons.push("unreadable");
      return { reasons, kind: "unreadable", fingerprint: "unreadable", lines: 0 };
    }
    try {
      if (st.isSymbolicLink()) {
        const target = readlinkSync(full);
        let resolved = resolve(dirname(full), target);
        try {
          resolved = realpathSync(resolved);
        } catch {
          // Dangling: judge the lexical target.
        }
        const relTarget = resolved.slice(real.length + 1);
        if (!within(real, resolved) || resolved === real || hasDotGitSegment(relTarget)) {
          reasons.push("symlink_outside");
        }
        return { reasons, kind: "link", fingerprint: `link\0${sha256(target)}`, lines: 1 };
      }
      if (st.isFile()) {
        const buf = readFileSync(full);
        const mode = st.mode & 0o111 ? "755" : "644";
        return {
          reasons,
          kind: "file",
          fingerprint: `file\0${mode}\0${sha256(buf)}`,
          lines: countLines(buf),
        };
      }
    } catch {
      reasons.push("unreadable");
      return { reasons, kind: "unreadable", fingerprint: "unreadable", lines: 0 };
    }
    // A directory (submodule or embedded repository) or a special file.
    reasons.push("not_a_file");
    return { reasons, kind: "other", fingerprint: `other\0${st.mode}`, lines: 0 };
  }

  /** The plain-text diff (tracked, then each new file), cut at GIT_DIFF_TEXT_MAX_BYTES. */
  private async diffText(
    repo: string,
    entries: CollectedEntry[],
  ): Promise<{ text: string; truncated: boolean }> {
    const common = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const chunks: string[] = [await this.must(repo, ["diff", ...common, "HEAD"])];
    let size = Buffer.byteLength(chunks[0] ?? "");
    for (const e of entries) {
      if (size > GIT_DIFF_TEXT_MAX_BYTES) break;
      // New regular files and symlinks only: anything else (directory, special or unreadable
      // file) is already unsafe and is never handed to git diff.
      if (e.xy !== "??" || (e.kind !== "file" && e.kind !== "link")) continue;
      // Exit 1 means "differences found"; symlinks are shown as their target, never followed.
      const r = await this.git(repo, ["diff", ...common, "--no-index", "--", "/dev/null", e.path]);
      if (r.timedOut) throw new GitWorkflowError("git_timeout");
      if (r.code !== 0 && r.code !== 1) throw new GitWorkflowError("git_failed");
      chunks.push(r.stdout);
      size += Buffer.byteLength(r.stdout);
    }
    const all = Buffer.from(chunks.join(""));
    if (all.length <= GIT_DIFF_TEXT_MAX_BYTES) return { text: all.toString(), truncated: false };
    // Cut on a UTF-8 character boundary so the text stays within the cap.
    let cut = GIT_DIFF_TEXT_MAX_BYTES;
    while (cut > 0 && ((all[cut] ?? 0) & 0xc0) === 0x80) cut--;
    return { text: all.subarray(0, cut).toString(), truncated: true };
  }
}
