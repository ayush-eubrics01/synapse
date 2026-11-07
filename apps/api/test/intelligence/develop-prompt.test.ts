import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDevelopRequest,
  repoInDenyMask,
  repoInMaskedPath,
  runRootMasked,
  SANDBOX_HOME_DENY,
  sandboxDenyRead,
} from "../../src/intelligence/engineering/develop-prompt";

const HOME = "/home/u";
const DATA = "/home/u/.local/share/synapse";
const BACKUPS = "/home/u/.local/share/synapse-backups";
const REPO = "/home/u/projects/demo";

const HOME_ENTRIES = [
  "/home/u/.ssh",
  "/home/u/.gnupg",
  "/home/u/.aws",
  "/home/u/.azure",
  "/home/u/.kube",
  "/home/u/.docker",
  "/home/u/.config",
  "/home/u/.claude",
  "/home/u/.netrc",
  "/home/u/.git-credentials",
  "/home/u/.npmrc",
  "/home/u/.pypirc",
  "/home/u/.cargo/credentials",
  "/home/u/.cargo/credentials.toml",
];

describe("sandboxDenyRead (F1.3)", () => {
  test("the home list is the exact F1.3 list, in order", () => {
    expect([...SANDBOX_HOME_DENY]).toEqual([
      ".ssh",
      ".gnupg",
      ".aws",
      ".azure",
      ".kube",
      ".docker",
      ".config",
      ".claude",
      ".netrc",
      ".git-credentials",
      ".npmrc",
      ".pypirc",
      ".cargo/credentials",
      ".cargo/credentials.toml",
    ]);
  });

  test("the 14 home entries, then the protected dirs, in order", () => {
    expect(sandboxDenyRead(HOME, [DATA, BACKUPS])).toEqual([...HOME_ENTRIES, DATA, BACKUPS]);
  });

  test("no entry is ever dropped: a repository inside one is refused instead (fix rounds 1-2)", () => {
    // repoInDenyMask refuses such a repository; nothing here depends on it.
    expect(sandboxDenyRead(HOME, [DATA, BACKUPS])).toHaveLength(16);
  });

  test("trailing slashes on home and the dirs change nothing", () => {
    const base = sandboxDenyRead(HOME, [DATA, BACKUPS]);
    expect(sandboxDenyRead(`${HOME}/`, [`${DATA}/`, `${BACKUPS}/`])).toEqual(base);
  });

  test("duplicates are dropped in first-seen order", () => {
    expect(sandboxDenyRead(HOME, ["/home/u/.ssh", DATA, DATA])).toEqual([...HOME_ENTRIES, DATA]);
  });
});

describe("repoInMaskedPath (controller ruling)", () => {
  test("a repository at or under /tmp, /run or /var/run is in a masked path", () => {
    for (const p of ["/tmp", "/tmp/demo", "/tmp/a/demo/", "/run/demo", "/var/run", "/var/run/x"]) {
      expect(repoInMaskedPath(p)).toBe(true);
    }
  });
  test("other paths, including shared prefixes, are not", () => {
    for (const p of [REPO, "/tmpx/demo", "/runner/demo", "/var/running/demo", "/var/tmp/demo"]) {
      expect(repoInMaskedPath(p)).toBe(false);
    }
  });
  test("the roots can be given", () => {
    expect(repoInMaskedPath("/tmp/demo", [])).toBe(false);
    expect(repoInMaskedPath("/srv/x/demo", ["/srv/x"])).toBe(true);
  });
});

describe("repoInDenyMask (fix rounds 1-2 rulings)", () => {
  test("a repository at or inside a home deny entry is masked", () => {
    for (const p of [
      "/home/u/.config/nvim",
      "/home/u/.claude",
      "/home/u/.docker/demo/",
      "/home/u/.cargo/credentials/x",
    ]) {
      expect(repoInDenyMask(HOME, [], p)).toBe(true);
      expect(repoInDenyMask(`${HOME}/`, [], p)).toBe(true);
    }
  });
  test("a repository at or inside the data or backup dir is masked", () => {
    for (const p of [DATA, `${DATA}/`, `${DATA}/scratch/demo`, `${BACKUPS}/x`]) {
      expect(repoInDenyMask(HOME, [DATA, BACKUPS], p)).toBe(true);
      expect(repoInDenyMask(HOME, [`${DATA}/`, `${BACKUPS}/`], p)).toBe(true);
    }
  });
  test("other repositories are not, including shared prefixes and home itself", () => {
    for (const p of [REPO, "/home/u/.configx/demo", "/home/u/.cargo/demo", HOME, `${DATA}x/demo`]) {
      expect(repoInDenyMask(HOME, [DATA, BACKUPS], p)).toBe(false);
    }
  });
});

describe("buildDevelopRequest sandbox", () => {
  const TASK = {
    approvedDescription: "Fix add",
    plan: {
      summary: "Fix add.",
      plan: [{ step: "Change add" }],
      filesLikelyTouched: ["src/add.ts"],
      testCommand: "bun test",
      risk: "low" as const,
      size: "s" as const,
      unclear: [],
    },
  };
  const S = { model: "sonnet", maxTurns: 30, timeoutMinutes: 30 };
  const SANDBOX = {
    tmpDir: `${HOME}/.cache/synapse/runs/j1/tmp`,
    home: HOME,
    protectedDirs: [DATA],
  };

  test("a null sandbox setting leaves no sandbox key", () => {
    const req = buildDevelopRequest(
      TASK,
      { localPath: REPO, testCommand: "bun test" },
      { ...S, sandbox: null },
    );
    expect("sandbox" in req).toBe(false);
  });

  test("a sandbox carries the given tmpDir and the deny list for the repository", () => {
    const req = buildDevelopRequest(
      TASK,
      { localPath: `${REPO}/`, testCommand: "bun test" },
      { ...S, sandbox: SANDBOX },
    );
    expect(req.sandbox?.tmpDir).toBe(SANDBOX.tmpDir);
    expect(req.sandbox?.denyRead).toEqual([...HOME_ENTRIES, DATA]);
  });
});

describe("symlinked home and data dirs (final review)", () => {
  test("the mask uses realpaths, and a repo under the real .config is refused", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "synapse-symhome-")));
    try {
      const realHome = join(base, "real-home");
      const realData = join(base, "real-data");
      mkdirSync(join(realHome, ".config", "app"), { recursive: true });
      mkdirSync(realData, { recursive: true });
      const linkHome = join(base, "link-home");
      const linkData = join(base, "link-data");
      symlinkSync(realHome, linkHome);
      symlinkSync(realData, linkData);

      const deny = sandboxDenyRead(linkHome, [linkData]);
      expect(deny).toContain(join(realHome, ".config"));
      expect(deny).toContain(realData);
      expect(deny.some((d) => d.startsWith(linkHome) || d === linkData)).toBe(false);
      // The repo realpath is under the real .config; the symlinked home must not hide that.
      expect(repoInDenyMask(linkHome, [linkData], join(realHome, ".config", "app"))).toBe(true);
      expect(repoInDenyMask(linkHome, [linkData], join(realData, "x"))).toBe(true);
      expect(repoInDenyMask(linkHome, [linkData], join(base, "elsewhere"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("runRootMasked (H4.6)", () => {
  test("true under a home deny entry or a protected dir, or a masked root", () => {
    expect(runRootMasked("/home/u/.config/c/synapse/abcd1234", "/home/u", [])).toBe(true);
    expect(
      runRootMasked("/home/u/.cache/synapse/abcd1234", "/home/u", ["/home/u/.local/share/synapse"]),
    ).toBe(false);
    expect(runRootMasked("/tmp/x/synapse/abcd1234", "/home/u", [])).toBe(true);
    expect(runRootMasked("/tmp/x/synapse/abcd1234", "/home/u", [], [])).toBe(false);
    expect(
      runRootMasked("/home/u/.local/share/synapse", "/home/u", ["/home/u/.local/share/synapse"]),
    ).toBe(true);
  });
});
