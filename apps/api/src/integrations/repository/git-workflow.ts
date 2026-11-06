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
  type GitCommitSummary,
  type GitDiffFile,
  type GitDiffOptions,
  type GitDiffSummary,
  type GitPreflightResult,
  type GitPushOptions,
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

const MERGE_STATE = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

/** Directories never hashed into the git-dir fingerprint (at any depth): object stores, reflogs. */
const FINGERPRINT_SKIP_DIRS = new Set(["objects", "logs"]);

interface StatusEntry {
  xy: string;
  path: string;
}

interface Collected {
  head: string;
  entries: StatusEntry[];
  files: GitDiffFile[];
  hash: string;
  unsafe: boolean;
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
          await this.must(repo, ["merge", "--ff-only", "--no-autostash", tracking]);
        } else {
          await this.must(repo, ["update-ref", local, target, current]);
        }
      }
    }
    await this.must(repo, ["switch", "--no-track", "-c", taskBranch, local]);
    return { baseSha: (await this.must(repo, ["rev-parse", "--verify", "HEAD"])).trim() };
  }

  // ---- E10 -----------------------------------------------------------------------------------

  async gitDirFingerprint(repo: string): Promise<string> {
    const gitDir = (await this.must(repo, ["rev-parse", "--absolute-git-dir"])).trim();
    const common = resolve(
      repo,
      (await this.must(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
    );
    const h = createHash("sha256");
    // `.git` at the top may be a file (worktree pointer) or a symlink: its content counts too.
    const dotGit = join(repo, ".git");
    try {
      const st = lstatSync(dotGit);
      if (st.isSymbolicLink()) h.update(`dotgit-link\0${readlinkSync(dotGit)}\0`);
      else if (st.isFile()) h.update(`dotgit-file\0${sha256(readFileSync(dotGit))}\0`);
    } catch {
      h.update("dotgit-missing\0");
    }
    h.update(`common\0${common}\0`);
    this.walk(h, common, "", gitDir === common ? null : "worktrees");
    if (gitDir !== common) {
      h.update(`gitdir\0${gitDir}\0`);
      this.walk(h, gitDir, "", null);
    }
    // The index by content (mode, blob, stage, path), not bytes: a stat refresh is not a change.
    h.update(await this.must(repo, ["ls-files", "--stage", "-z"]));
    return h.digest("hex");
  }

  async diffSummary(repo: string, opts: GitDiffOptions = {}): Promise<GitDiffSummary> {
    const c = await this.collect(repo);
    let unsafe = c.unsafe;
    if (opts.gitDirBaseline !== undefined && !unsafe) {
      unsafe = (await this.gitDirFingerprint(repo)) !== opts.gitDirBaseline;
    }
    const { text, truncated } = await this.diffText(repo, c.entries);
    return { files: c.files, hash: c.hash, unsafe, diffText: text, truncated };
  }

  async commitAll(repo: string, message: string, expectedHash: string): Promise<{ sha: string }> {
    const before = await this.collect(repo);
    if (before.files.length === 0) throw new GitWorkflowError("nothing_to_commit");
    if (before.unsafe) throw new GitWorkflowError("unsafe_change");
    if (before.hash !== expectedHash) throw new GitWorkflowError("diff_changed");
    await this.must(repo, ["add", "-A"]);
    // Re-check after staging: the index must hold exactly the approved state.
    const after = await this.collect(repo);
    if (after.unsafe || after.hash !== expectedHash) {
      await this.git(repo, ["reset", "-q"]);
      throw new GitWorkflowError(after.unsafe ? "unsafe_change" : "diff_changed");
    }
    await this.must(repo, ["commit", "-q", "--no-verify", "-m", message]);
    return { sha: (await this.must(repo, ["rev-parse", "--verify", "HEAD"])).trim() };
  }

  // ---- E11 / E12 -----------------------------------------------------------------------------

  async updateParent(
    repo: string,
    parent: string,
  ): Promise<{ ok: true } | { ok: false; conflict: true }> {
    this.ref(parent);
    await this.requireClean(repo);
    if (!(await this.refExists(repo, `refs/heads/${parent}`))) {
      throw new GitWorkflowError("branch_missing");
    }
    await this.must(repo, ["switch", "--no-guess", parent]);
    for (const remote of ["origin", "upstream"] as const) {
      // `git pull` = fetch + merge; done in two steps so `pull.rebase` config can't make it a rebase.
      await this.fetchParent(repo, remote, parent);
      const ref = `refs/remotes/${remote}/${parent}`;
      const ff = await this.git(repo, ["merge", "--ff-only", "--no-edit", "--no-autostash", ref]);
      if (ff.timedOut) throw new GitWorkflowError("git_timeout");
      if (ff.code === 0) continue;
      const msg = `Merge branch '${parent}' of ${remote} into ${parent}`;
      if (!(await this.merge(repo, ["--ff", "-m", msg, ref]))) return { ok: false, conflict: true };
    }
    return { ok: true };
  }

  async mergeLocal(
    repo: string,
    parent: string,
    taskBranch: string,
  ): Promise<{ ok: true; sha: string } | { ok: false; conflict: true }> {
    this.ref(parent);
    this.ref(taskBranch);
    await this.requireClean(repo);
    for (const b of [parent, taskBranch]) {
      if (!(await this.refExists(repo, `refs/heads/${b}`))) {
        throw new GitWorkflowError("branch_missing");
      }
    }
    if ((await this.currentBranch(repo)) !== parent) {
      await this.must(repo, ["switch", "--no-guess", parent]);
    }
    const msg = `Merge branch '${taskBranch}' into ${parent}`;
    if (!(await this.merge(repo, ["--no-ff", "-m", msg, `refs/heads/${taskBranch}`]))) {
      return { ok: false, conflict: true };
    }
    return { ok: true, sha: (await this.must(repo, ["rev-parse", "--verify", "HEAD"])).trim() };
  }

  // ---- E13 -----------------------------------------------------------------------------------

  async pushParent(repo: string, parent: string, opts: GitPushOptions): Promise<{ ok: true }> {
    this.ref(parent);
    if (opts.protectedBranches.includes(parent)) throw new GitWorkflowError("protected_branch");
    const remotes = new Set(lines(await this.must(repo, ["remote"])));
    if (!remotes.has("origin")) throw new GitWorkflowError("missing_remote");
    const upstreamKeys = new Set<string>();
    const add = (u: string | null) => {
      const k = u === null ? null : remoteKey(u);
      if (k) upstreamKeys.add(k);
    };
    add(opts.upstreamUrl);
    if (remotes.has("upstream")) {
      for (const u of lines(await this.must(repo, ["remote", "get-url", "--all", "upstream"])))
        add(u);
    }
    const pushUrls = lines(
      await this.must(repo, ["remote", "get-url", "--push", "--all", "origin"]),
    );
    if (pushUrls.some((u) => upstreamKeys.has(remoteKey(u) ?? ""))) {
      throw new GitWorkflowError("push_target_is_upstream");
    }
    if (!(await this.refExists(repo, `refs/heads/${parent}`))) {
      throw new GitWorkflowError("branch_missing");
    }
    const r = await this.git(repo, [
      "push",
      "--no-follow-tags",
      "--recurse-submodules=no",
      "--no-signed",
      "--no-verify",
      "origin",
      `refs/heads/${parent}:refs/heads/${parent}`,
    ]);
    if (r.timedOut) throw new GitWorkflowError("git_timeout");
    if (r.code !== 0) throw new GitWorkflowError("push_failed");
    return { ok: true };
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
    returnTo: string,
    opts: { force: boolean },
  ): Promise<{ ok: true; deleted: boolean } | { ok: false; dirty: true }> {
    this.ref(taskBranch);
    this.ref(returnTo);
    if ((await this.mergeInProgress(repo)) || (await this.dirty(repo))) {
      return { ok: false, dirty: true };
    }
    if ((await this.currentBranch(repo)) !== returnTo) {
      if (!(await this.refExists(repo, `refs/heads/${returnTo}`))) {
        throw new GitWorkflowError("branch_missing");
      }
      await this.must(repo, ["switch", "--no-guess", returnTo]);
    }
    const task = `refs/heads/${taskBranch}`;
    if (returnTo === taskBranch || !(await this.refExists(repo, task))) {
      return { ok: true, deleted: false };
    }
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

  private git(repo: string, args: string[]): Promise<GitResult> {
    return runGit(repo, args, {
      home: this.opts.home,
      binary: this.opts.binary,
      extraEnv: this.opts.extraEnv,
      exec: this.opts.exec,
    });
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
  private async merge(repo: string, args: string[]): Promise<boolean> {
    const r = await this.git(repo, [
      "merge",
      "--no-edit",
      "--no-autostash",
      "--no-verify-signatures",
      ...args,
    ]);
    if (r.timedOut) throw new GitWorkflowError("git_timeout");
    if (r.code === 0) return true;
    if (!(await this.mergeInProgress(repo))) throw new GitWorkflowError("git_failed");
    await this.must(repo, ["merge", "--abort"]);
    if (await this.mergeInProgress(repo)) throw new GitWorkflowError("git_failed");
    return false;
  }

  /** Hashes a directory tree (sorted): file content and mode, symlink targets, no objects/logs. */
  private walk(h: Hash, root: string, rel: string, skipTop: string | null): void {
    let names: string[];
    try {
      names = readdirSync(join(root, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && name === skipTop) continue;
      // The raw index is stat-dependent; it is fingerprinted by content (ls-files) instead.
      if (!rel && name === "index") continue;
      const full = join(root, r);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        h.update(`L\0${r}\0${readlinkSync(full)}\0`);
      } else if (st.isDirectory()) {
        if (FINGERPRINT_SKIP_DIRS.has(name)) {
          // Object stores and reflogs are skipped; alternates could point objects elsewhere.
          if (r === "objects") {
            for (const alt of ["objects/info/alternates", "objects/info/http-alternates"]) {
              if (existsSync(join(root, alt))) {
                h.update(`F\0${alt}\0${sha256(readFileSync(join(root, alt)))}\0`);
              }
            }
          }
          continue;
        }
        h.update(`D\0${r}\0`);
        this.walk(h, root, r, null);
      } else if (st.isFile()) {
        h.update(`F\0${r}\0${st.mode}\0${sha256(readFileSync(full))}\0`);
      } else {
        h.update(`O\0${r}\0`);
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
    const entries = [...byPath.values()].sort((a, b) =>
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
    let unsafe = false;
    const files: GitDiffFile[] = [];
    for (const e of entries) {
      const untracked = e.xy === "??";
      const check = this.inspectPath(real, e.path, e.xy);
      if (check.unsafe) unsafe = true;
      h.update(`${e.path}\0${check.fingerprint}\0`);
      const n = counts.get(e.path);
      if (untracked) files.push({ path: e.path, added: check.lines, removed: 0 });
      else files.push({ path: e.path, added: n?.added ?? 0, removed: n?.removed ?? 0 });
    }
    return { head, entries, files, hash: h.digest("hex"), unsafe };
  }

  /** Safety and content fingerprint of one changed path; never follows a symlink. */
  private inspectPath(
    real: string,
    rel: string,
    xy: string,
  ): { unsafe: boolean; fingerprint: string; lines: number } {
    const segs = rel.split("/");
    let unsafe =
      rel.length === 0 ||
      rel.startsWith("/") ||
      rel.endsWith("/") || // an embedded repository or directory entry
      segs.includes("..") ||
      hasDotGitSegment(rel);
    const full = join(real, rel);
    if (!within(real, full)) unsafe = true;
    try {
      if (!within(real, realpathSync(dirname(full)))) unsafe = true;
    } catch {
      // The parent directory is gone (a deleted file's directory): nothing on disk to escape.
    }
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      // Deleted. A path git says still exists but that we cannot stat is not verifiable.
      if (!xy.includes("D")) unsafe = true;
      return { unsafe, fingerprint: "missing", lines: 0 };
    }
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
        unsafe = true;
      }
      return { unsafe, fingerprint: `link\0${sha256(target)}`, lines: 1 };
    }
    if (st.isFile()) {
      const buf = readFileSync(full);
      const mode = st.mode & 0o111 ? "755" : "644";
      return { unsafe, fingerprint: `file\0${mode}\0${sha256(buf)}`, lines: countLines(buf) };
    }
    // A directory (submodule or embedded repository) or a special file.
    return { unsafe: true, fingerprint: `other\0${st.mode}`, lines: 0 };
  }

  /** The plain-text diff (tracked, then each new file), cut at GIT_DIFF_TEXT_MAX_BYTES. */
  private async diffText(
    repo: string,
    entries: StatusEntry[],
  ): Promise<{ text: string; truncated: boolean }> {
    const common = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const chunks: string[] = [await this.must(repo, ["diff", ...common, "HEAD"])];
    let size = Buffer.byteLength(chunks[0] ?? "");
    for (const e of entries) {
      if (size > GIT_DIFF_TEXT_MAX_BYTES) break;
      if (e.xy !== "??" || e.path.endsWith("/")) continue;
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
