import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  environmentCandidates,
  LocalGitProvider,
  stripCredentials,
} from "../../src/integrations/repository/local-git";
import { checkRegistrablePath } from "../../src/integrations/repository/path-rules";
import { git, initRepo, makeDemoRepo, tempDir } from "../fixtures/git-repo";

const roots: string[] = [];
const scratch = () => {
  const d = tempDir();
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("stripCredentials", () => {
  test("drops user and token from an https URL", () => {
    expect(stripCredentials("https://user:tok@example.com/a.git")).toBe(
      "https://example.com/a.git",
    );
  });
  test("drops a bare token user from an https URL", () => {
    expect(stripCredentials("https://ghp_abc123@example.com/a.git")).toBe(
      "https://example.com/a.git",
    );
  });
  test("drops only the password from an ssh URL, keeping the login", () => {
    expect(stripCredentials("ssh://git:secret@example.com/a.git")).toBe(
      "ssh://git@example.com/a.git",
    );
    expect(stripCredentials("ssh://git@example.com/a.git")).toBe("ssh://git@example.com/a.git");
  });
  test("strips userinfo for every non-ssh scheme", () => {
    expect(stripCredentials("git://tok@example.com/a.git")).toBe("git://example.com/a.git");
    expect(stripCredentials("ftp://u:p@example.com/a.git")).toBe("ftp://example.com/a.git");
    expect(stripCredentials("file://u@localhost/srv/a.git")).toBe("file://localhost/srv/a.git");
    expect(stripCredentials("custom+x://u:p@example.com/a")).toBe("custom+x://example.com/a");
    expect(stripCredentials("HTTPS://u:p@example.com/a")).toBe("HTTPS://example.com/a");
  });
  test("ssh, git+ssh and ssh+git keep the login and lose the password", () => {
    expect(stripCredentials("git+ssh://git:pw@example.com/a.git")).toBe(
      "git+ssh://git@example.com/a.git",
    );
    expect(stripCredentials("ssh+git://git:pw@example.com/a.git")).toBe(
      "ssh+git://git@example.com/a.git",
    );
    expect(stripCredentials("ssh://:pw@example.com/a.git")).toBe("ssh://example.com/a.git");
  });
  test("strips inside remote-helper syntax", () => {
    expect(stripCredentials("helper::https://user:tok@host/x")).toBe("helper::https://host/x");
    expect(stripCredentials("a::b::https://u:p@host/x")).toBe("a::b::https://host/x");
    expect(stripCredentials("helper::git@host:org/repo")).toBe("helper::git@host:org/repo");
  });
  test("an IPv6 host is not mistaken for helper syntax", () => {
    expect(stripCredentials("https://u:p@[::1]/a.git")).toBe("https://[::1]/a.git");
    expect(stripCredentials("https://[::1]/a.git")).toBe("https://[::1]/a.git");
  });
  test("leaves scp-style and plain URLs alone", () => {
    expect(stripCredentials("git@example.com:demo/app.git")).toBe("git@example.com:demo/app.git");
    expect(stripCredentials("https://example.com/demo/app.git")).toBe(
      "https://example.com/demo/app.git",
    );
    expect(stripCredentials("/srv/git/app.git")).toBe("/srv/git/app.git");
  });
});

describe("environmentCandidates", () => {
  test("finds stage and prod (and main) but not feature-x", () => {
    expect(environmentCandidates(["feature-x", "main", "prod", "prod-hotfix", "stage"])).toEqual([
      { name: "main", branch: "main" },
      { name: "prod", branch: "prod" },
      { name: "stage", branch: "stage" },
    ]);
  });
  test("recognises every C3 name and de-duplicates", () => {
    const all = ["staging", "production", "master", "develop", "dev", "release", "dev"];
    expect(environmentCandidates(all).map((c) => c.name)).toEqual([
      "dev",
      "develop",
      "master",
      "production",
      "release",
      "staging",
    ]);
  });
});

describe("LocalGitProvider.inspect", () => {
  let home: string;
  let repo: string;
  let provider: LocalGitProvider;
  beforeAll(() => {
    home = scratch();
    repo = makeDemoRepo(scratch());
    provider = new LocalGitProvider({ home });
  });

  test("reports the current branch, HEAD sha and top level", async () => {
    const r = await provider.inspect(repo);
    if (!r.ok) throw new Error(r.reason);
    expect(r.inspection.currentBranch).toBe("main");
    expect(r.inspection.headSha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(r.inspection.topLevel).toBe(repo);
  });

  test("returns local branches, plus remote branches once a remote ref exists", async () => {
    const before = await provider.inspect(repo);
    if (!before.ok) throw new Error(before.reason);
    expect(before.inspection.localBranches).toEqual(["feature-x", "main", "prod", "stage"]);
    expect(before.inspection.remoteBranches).toEqual([]);

    git(repo, "update-ref", "refs/remotes/origin/prod", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/release", "HEAD");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/prod");
    const after = await provider.inspect(repo);
    if (!after.ok) throw new Error(after.reason);
    expect(after.inspection.remoteBranches).toEqual(["origin/prod", "origin/release"]);
  });

  test("returns origin and upstream, with upstream pushes disabled", async () => {
    const r = await provider.inspect(repo);
    if (!r.ok) throw new Error(r.reason);
    expect(r.inspection.remotes.origin).toEqual({
      fetch: "https://example.com/demo/app.git",
      push: "https://example.com/demo/app.git",
    });
    expect(r.inspection.remotes.upstream).toEqual({
      fetch: "https://example.com/upstream/app.git",
      push: "no_push",
    });
    expect(r.inspection.upstreamPushDisabled).toBe(true);
  });

  test("an upstream that can push is not disabled; credentials never leave the provider", async () => {
    const other = makeDemoRepo(scratch());
    git(other, "remote", "set-url", "origin", "https://user:tok@example.com/demo/app.git");
    git(other, "remote", "set-url", "--push", "upstream", "https://example.com/upstream/app.git");
    const r = await provider.inspect(other);
    if (!r.ok) throw new Error(r.reason);
    expect(r.inspection.upstreamPushDisabled).toBe(false);
    expect(r.inspection.remotes.origin?.fetch).toBe("https://example.com/demo/app.git");
    expect(JSON.stringify(r)).not.toContain("tok");
  });

  test("DISABLED as the push URL also counts as disabled; no upstream means not disabled", async () => {
    const a = makeDemoRepo(scratch());
    git(a, "remote", "set-url", "--push", "upstream", "DISABLED");
    const ra = await provider.inspect(a);
    expect(ra.ok && ra.inspection.upstreamPushDisabled).toBe(true);

    const b = initRepo(join(scratch(), "plain"));
    const rb = await provider.inspect(b);
    if (!rb.ok) throw new Error(rb.reason);
    expect(rb.inspection.remotes).toEqual({});
    expect(rb.inspection.upstreamPushDisabled).toBe(false);
  });

  test("a detached HEAD has no current branch", async () => {
    const d = makeDemoRepo(scratch());
    git(d, "checkout", "-q", "--detach");
    const r = await provider.inspect(d);
    expect(r.ok && r.inspection.currentBranch).toBeNull();
  });

  test("git that cannot be spawned is git_failed, never path_missing or not_a_repository", async () => {
    const broken = new LocalGitProvider({ home, binary: "/nonexistent/synapse-git" });
    expect(await broken.inspect(repo)).toEqual({ ok: false, reason: "git_failed" });
  });

  test("a missing path and a non-repository fail with fixed reasons", async () => {
    expect(await provider.inspect(join(scratch(), "gone"))).toEqual({
      ok: false,
      reason: "path_missing",
    });
    expect(await provider.inspect(scratch())).toEqual({ ok: false, reason: "not_a_repository" });
  });
});

describe("checkRegistrablePath", () => {
  let home: string;
  let base: string;
  let repo: string;
  beforeAll(() => {
    home = scratch();
    base = scratch();
    repo = makeDemoRepo(base);
  });

  test("a repo top level is accepted and returned as its realpath", async () => {
    expect(await checkRegistrablePath(repo, home, [])).toEqual({ ok: true, realpath: repo });
    expect(await checkRegistrablePath(`${repo}/`, home, [])).toEqual({ ok: true, realpath: repo });
  });

  test("a symlink to a repo is stored as its realpath", async () => {
    const link = join(base, "link-to-app");
    symlinkSync(repo, link);
    expect(await checkRegistrablePath(link, home, [])).toEqual({ ok: true, realpath: repo });
  });

  test.each([
    ["relative", "app"],
    ["empty", ""],
  ])("refuses a %s path as not_absolute", async (_n, p) => {
    expect(await checkRegistrablePath(p, home, [])).toEqual({ ok: false, reason: "not_absolute" });
  });

  test("refuses a missing path, a file and a non-git directory", async () => {
    expect(await checkRegistrablePath(join(base, "nope"), home, [])).toEqual({
      ok: false,
      reason: "not_found",
    });
    const file = join(base, "file.txt");
    writeFileSync(file, "x");
    expect(await checkRegistrablePath(file, home, [])).toEqual({
      ok: false,
      reason: "not_directory",
    });
    const plain = join(base, "plain-dir");
    mkdirSync(plain);
    expect(await checkRegistrablePath(plain, home, [])).toEqual({
      ok: false,
      reason: "not_git_root",
    });
  });

  test("refuses a subdirectory of a repo and its .git directory", async () => {
    const sub = join(repo, "src");
    mkdirSync(sub, { recursive: true });
    expect(await checkRegistrablePath(sub, home, [])).toEqual({
      ok: false,
      reason: "not_git_root",
    });
    expect(await checkRegistrablePath(join(repo, ".git"), home, [])).toEqual({
      ok: false,
      reason: "not_git_root",
    });
  });

  test("refuses a repo whose path has a space, and dot segments in the input", async () => {
    const spaced = initRepo(join(base, "my app"));
    expect(await checkRegistrablePath(spaced, home, [])).toEqual({
      ok: false,
      reason: "unsafe_chars",
    });
    expect(await checkRegistrablePath(`${repo}/../app`, home, [])).toEqual({
      ok: false,
      reason: "unsafe_chars",
    });
    expect(await checkRegistrablePath(`${base}//app`, home, [])).toEqual({
      ok: false,
      reason: "unsafe_chars",
    });
  });

  test("refuses /, $HOME and repos inside ~/.claude, ~/.ssh or ~/.config", async () => {
    expect(await checkRegistrablePath("/", home, [])).toEqual({
      ok: false,
      reason: "forbidden_location",
    });
    initRepo(home);
    expect(await checkRegistrablePath(home, home, [])).toEqual({
      ok: false,
      reason: "forbidden_location",
    });
    for (const dir of [".claude", ".ssh", ".config"]) {
      const inner = initRepo(join(home, dir, "proj"));
      expect(await checkRegistrablePath(inner, home, [])).toEqual({
        ok: false,
        reason: "forbidden_location",
      });
      const top = initRepo(join(home, dir));
      expect(await checkRegistrablePath(top, home, [])).toEqual({
        ok: false,
        reason: "forbidden_location",
      });
    }
  });

  test("a symlink into a forbidden location is refused by its realpath", async () => {
    const h = scratch();
    const secret = initRepo(join(h, ".ssh", "keys"));
    const link = join(base, "innocent");
    symlinkSync(secret, link);
    expect(await checkRegistrablePath(link, h, [])).toEqual({
      ok: false,
      reason: "forbidden_location",
    });
  });

  test("refuses an already registered path, and paths nested in or around one", async () => {
    expect(await checkRegistrablePath(repo, home, [repo])).toEqual({
      ok: false,
      reason: "already_registered",
    });
    const inner = initRepo(join(repo, "vendor", "lib"));
    expect(await checkRegistrablePath(inner, home, [repo])).toEqual({
      ok: false,
      reason: "nested",
    });
    expect(await checkRegistrablePath(repo, home, [inner])).toEqual({
      ok: false,
      reason: "nested",
    });
    // A sibling whose name merely shares a prefix is not nested.
    const sibling = initRepo(join(base, "app2"));
    expect(await checkRegistrablePath(sibling, home, [repo])).toEqual({
      ok: true,
      realpath: sibling,
    });
  });

  test("refuses any ancestor of $HOME, even when it is a git root", async () => {
    const top = scratch();
    const nestedHome = join(top, "a", "b", "home");
    mkdirSync(nestedHome, { recursive: true });
    const parent = initRepo(join(top, "a"));
    expect(await checkRegistrablePath(parent, nestedHome, [])).toEqual({
      ok: false,
      reason: "forbidden_location",
    });
    const grand = initRepo(join(top, "a", "b"));
    expect(await checkRegistrablePath(grand, nestedHome, [])).toEqual({
      ok: false,
      reason: "forbidden_location",
    });
    // Through a symlinked home too: judged by the home's realpath.
    const link = join(scratch(), "home-link");
    symlinkSync(nestedHome, link);
    expect(await checkRegistrablePath(parent, link, [])).toEqual({
      ok: false,
      reason: "forbidden_location",
    });
    // A sibling of the home's ancestors is fine.
    const sibling = initRepo(join(top, "c"));
    expect(await checkRegistrablePath(sibling, nestedHome, [])).toEqual({
      ok: true,
      realpath: sibling,
    });
  });

  test("the provider's checkPath applies the same rules with its injected home", async () => {
    const p = new LocalGitProvider({ home });
    expect(await p.checkPath(repo, [])).toEqual({ ok: true, realpath: repo });
    expect(await p.checkPath(home, [])).toEqual({ ok: false, reason: "forbidden_location" });
  });
});
