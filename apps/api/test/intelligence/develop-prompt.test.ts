import { describe, expect, test } from "bun:test";
import {
  buildDevelopRequest,
  repoInHomeMask,
  repoInMaskedPath,
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
    expect(sandboxDenyRead(HOME, [DATA, BACKUPS], REPO)).toEqual([...HOME_ENTRIES, DATA, BACKUPS]);
  });

  test("a home entry is never dropped, even when it contains the repository (fix round 1)", () => {
    // Such a repository is refused (repoInHomeMask), never unmasked with its whole directory.
    expect(sandboxDenyRead(HOME, [DATA, BACKUPS], "/home/u/.docker/demo")).toEqual([
      ...HOME_ENTRIES,
      DATA,
      BACKUPS,
    ]);
    expect(sandboxDenyRead(HOME, [], "/home/u/.config")).toEqual(HOME_ENTRIES);
  });

  test("entries inside the repository stay masked", () => {
    expect(sandboxDenyRead(HOME, [DATA], HOME)).toEqual([...HOME_ENTRIES, DATA]);
  });

  test("a repository equal to a protected dir drops that entry", () => {
    const out = sandboxDenyRead(HOME, [DATA, BACKUPS], DATA);
    expect(out).toEqual([...HOME_ENTRIES, BACKUPS]);
  });

  test("a protected dir containing the repository is dropped; a sibling prefix is kept", () => {
    expect(sandboxDenyRead(HOME, [DATA, BACKUPS], `${DATA}/scratch/demo`)).toEqual([
      ...HOME_ENTRIES,
      BACKUPS,
    ]);
    // `/home/u/.sshx` is not inside `/home/u/.ssh`.
    expect(sandboxDenyRead(HOME, [], "/home/u/.sshx/demo")).toEqual(HOME_ENTRIES);
  });

  test("trailing slashes on home, the dirs and the repository change nothing", () => {
    const base = sandboxDenyRead(HOME, [DATA, BACKUPS], REPO);
    expect(sandboxDenyRead(`${HOME}/`, [DATA, BACKUPS], REPO)).toEqual(base);
    expect(sandboxDenyRead(HOME, [`${DATA}/`, `${BACKUPS}/`], `${REPO}/`)).toEqual(base);
    expect(sandboxDenyRead(`${HOME}/`, [`${DATA}/`], `${DATA}/`)).toEqual(HOME_ENTRIES);
  });

  test("duplicates are dropped in first-seen order", () => {
    expect(sandboxDenyRead(HOME, ["/home/u/.ssh", DATA, DATA], REPO)).toEqual([
      ...HOME_ENTRIES,
      DATA,
    ]);
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

describe("repoInHomeMask (fix round 1 ruling)", () => {
  test("a repository at or inside a home deny entry is masked", () => {
    for (const p of [
      "/home/u/.config/nvim",
      "/home/u/.claude",
      "/home/u/.docker/demo/",
      "/home/u/.cargo/credentials/x",
    ]) {
      expect(repoInHomeMask(HOME, p)).toBe(true);
      expect(repoInHomeMask(`${HOME}/`, p)).toBe(true);
    }
  });
  test("other repositories are not, including shared prefixes and home itself", () => {
    for (const p of [REPO, "/home/u/.configx/demo", "/home/u/.cargo/demo", HOME, DATA]) {
      expect(repoInHomeMask(HOME, p)).toBe(false);
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
  const SANDBOX = { tmpDir: `${DATA}/scratch/runs/j1/tmp`, home: HOME, protectedDirs: [DATA] };

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
