import { realpathSync, statSync } from "node:fs";
import type {
  PathCheckResult,
  RepositoryInspectResult,
  RepositoryProvider,
  RepositoryRemote,
} from "@synapse/contracts";
import { type GitResult, lines, runGit } from "./git";
import { checkRegistrablePath } from "./path-rules";

export { environmentCandidates } from "@synapse/contracts";

/** SSH schemes, where the userinfo's login selects the account and is kept. */
const SSH_SCHEMES = new Set(["ssh", "git+ssh", "ssh+git"]);

/**
 * Removes credentials from a remote URL before it is stored or returned (C3):
 * `https://user:token@host/x` becomes `https://host/x`. Every scheme loses its whole userinfo
 * (a token often travels as the user name), except the SSH schemes, which keep the login and
 * lose only a password. Remote-helper syntax (`<helper>::<address>`) is stripped inside the
 * address. scp-style (`git@host:org/repo.git`) and local paths carry no credentials and are
 * unchanged.
 */
export function stripCredentials(url: string): string {
  const helper = /^([A-Za-z][A-Za-z0-9+.-]*)::(.*)$/s.exec(url);
  if (helper) return `${helper[1]}::${stripCredentials(helper[2] ?? "")}`;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/s.exec(url);
  if (!m) return url;
  const [, scheme = "", authority = "", rest = ""] = m;
  const at = authority.lastIndexOf("@");
  if (at < 0) return url;
  const userinfo = authority.slice(0, at);
  const host = authority.slice(at + 1);
  if (!SSH_SCHEMES.has(scheme.toLowerCase())) return `${scheme}://${host}${rest}`;
  const login = userinfo.split(":")[0] ?? "";
  return `${scheme}://${login ? `${login}@` : ""}${host}${rest}`;
}

/** A push URL that git can never push to: the conventional `no_push`, `DISABLED`, or empty. */
export function pushDisabled(push: string): boolean {
  return push === "" || push === "no_push" || push === "DISABLED";
}

class GitFailed extends Error {}

export interface LocalGitOptions {
  /** $HOME for git and for the C2 forbidden locations (injected; tests use a temp dir). */
  home: string;
  timeoutMs?: number;
  /** The git executable; defaults to `git` on PATH. */
  binary?: string;
}

/** C3: read-only inspection of local repositories through the git CLI. */
export class LocalGitProvider implements RepositoryProvider {
  constructor(private readonly opts: LocalGitOptions) {}

  checkPath(path: string, registeredPaths: readonly string[]): Promise<PathCheckResult> {
    return checkRegistrablePath(path, this.opts.home, registeredPaths, {
      timeoutMs: this.opts.timeoutMs,
      binary: this.opts.binary,
    });
  }

  async inspect(path: string): Promise<RepositoryInspectResult> {
    let real: string;
    try {
      if (!statSync(path).isDirectory()) return { ok: false, reason: "path_missing" };
      real = realpathSync(path);
    } catch {
      return { ok: false, reason: "path_missing" };
    }
    const top = await this.git(real, ["rev-parse", "--show-toplevel"]);
    // -1: timed out or could not be spawned. Not evidence that the repository is gone.
    if (top.code === -1) return { ok: false, reason: "git_failed" };
    if (top.code !== 0 || top.stdout.trim() !== real)
      return { ok: false, reason: "not_a_repository" };

    try {
      const [branch, head, local, remote, remoteNames] = await Promise.all([
        this.git(real, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
        this.git(real, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
        this.must(real, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"]),
        this.must(real, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/remotes"]),
        this.must(real, ["remote"]),
      ]);
      // Exit 1 means "detached" / "no commit yet"; anything else is a failure.
      for (const r of [branch, head]) if (r.code < 0 || r.code > 1) throw new GitFailed();
      const names = new Set(lines(remoteNames));
      const origin = names.has("origin") ? await this.remote(real, "origin") : undefined;
      const upstream = names.has("upstream") ? await this.remote(real, "upstream") : undefined;
      return {
        ok: true,
        inspection: {
          topLevel: real,
          currentBranch: branch.code === 0 ? branch.stdout.trim() || null : null,
          headSha: head.code === 0 ? head.stdout.trim() || null : null,
          remotes: { ...(origin ? { origin } : {}), ...(upstream ? { upstream } : {}) },
          upstreamPushDisabled: upstream ? pushDisabled(upstream.push) : false,
          localBranches: lines(local).sort(),
          remoteBranches: lines(remote)
            .filter((r) => r.includes("/") && !r.endsWith("/HEAD"))
            .sort(),
        },
      };
    } catch (e) {
      if (e instanceof GitFailed) return { ok: false, reason: "git_failed" };
      throw e;
    }
  }

  private async remote(dir: string, name: string): Promise<RepositoryRemote> {
    const fetch = await this.must(dir, ["remote", "get-url", name]);
    const push = await this.must(dir, ["remote", "get-url", "--push", name]);
    return { fetch: stripCredentials(fetch.trim()), push: stripCredentials(push.trim()) };
  }

  private git(dir: string, args: string[]): Promise<GitResult> {
    return runGit(dir, args, {
      home: this.opts.home,
      timeoutMs: this.opts.timeoutMs,
      binary: this.opts.binary,
    });
  }

  /** stdout of a command that must succeed; otherwise GitFailed (no stderr, no path). */
  private async must(dir: string, args: string[]): Promise<string> {
    const r = await this.git(dir, args);
    if (r.code !== 0) throw new GitFailed();
    return r.stdout;
  }
}
