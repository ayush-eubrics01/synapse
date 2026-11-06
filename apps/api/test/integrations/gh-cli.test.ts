import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PullRequestError } from "@synapse/contracts";
import { GitHubCliProvider, parseGithubRemote } from "../../src/integrations/github/gh-cli";

let dir: string;
let fake: string;
let log: string;
const up = { owner: "o", repo: "r" };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fakegh-"));
  log = join(dir, "argv.log");
  fake = join(dir, "gh");
  writeFileSync(
    fake,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const d = import.meta.dir;
const cfg = JSON.parse(readFileSync(d + "/cfg.json", "utf8"));
appendFileSync(d + "/argv.log", JSON.stringify(process.argv.slice(2)) + "\\n");
appendFileSync(d + "/argv.log", "ENV " + process.env.GH_PROMPT_DISABLED + " " + process.env.NO_COLOR + "\\n");
process.stdout.write(cfg.out);
process.stderr.write(cfg.err);
process.exit(cfg.code);
`,
  );
  chmodSync(fake, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(out: string, code = 0, err = "") {
  writeFileSync(log, "");
  writeFileSync(join(dir, "cfg.json"), JSON.stringify({ out, code, err }));
  return new GitHubCliProvider({ binary: fake });
}
const argvs = () =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("["))
    .map((l) => JSON.parse(l));

describe("parseGithubRemote", () => {
  test.each([
    ["https://github.com/o/r", "o", "r"],
    ["https://github.com/o/r.git", "o", "r"],
    ["git@github.com:o/r.git", "o", "r"],
    ["git@github.com:o/r", "o", "r"],
    ["ssh://git@github.com/o/r.git", "o", "r"],
    ["ssh://git@github.com/o/r", "o", "r"],
    ["https://github.com/my-o.x/r_e.po.git", "my-o.x", "r_e.po"],
  ])("%s", (u, owner, repo) => {
    expect(parseGithubRemote(u)).toEqual({ owner, repo });
  });
  test.each([
    "https://gitlab.com/o/r.git",
    "git@bitbucket.org:o/r.git",
    "https://github.com.evil.com/o/r",
    "https://github.com/o",
    "https://github.com/o/r/extra",
    "https://github.com/o b/r",
    "git@github.com:o/r;rm.git",
    "",
  ])("null for %s", (u) => {
    expect(parseGithubRemote(u)).toBeNull();
  });
});

describe("GitHubCliProvider", () => {
  test("createPr argv and parse", async () => {
    const p = run("https://github.com/o/r/pull/42\n");
    const res = await p.createPr({
      upstream: up,
      headOwner: "fork",
      branch: "stage",
      title: "T",
      body: "B",
    });
    expect(res).toEqual({ url: "https://github.com/o/r/pull/42", number: 42 });
    expect(argvs()).toEqual([
      [
        "pr",
        "create",
        "--repo",
        "o/r",
        "--head",
        "fork:stage",
        "--base",
        "stage",
        "--title",
        "T",
        "--body",
        "B",
      ],
    ]);
    expect(readFileSync(log, "utf8")).toContain("ENV 1 1");
  });

  test("createPr with unparseable output fails with a fixed code", async () => {
    const p = run("nonsense");
    await expect(
      p.createPr({ upstream: up, headOwner: "f", branch: "b", title: "T", body: "B" }),
    ).rejects.toMatchObject({ code: "pr_create_failed" });
  });

  test("mergePr argv", async () => {
    const p = run("");
    expect(await p.mergePr({ upstream: up, number: 7 })).toEqual({ merged: true });
    expect(argvs()).toEqual([["pr", "merge", "7", "--repo", "o/r", "--merge"]]);
  });

  test("mergePr failure", async () => {
    const p = run("", 1, "boom");
    await expect(p.mergePr({ upstream: up, number: 7 })).rejects.toMatchObject({
      code: "pr_merge_failed",
    });
  });

  const view = (rollup: unknown[]) =>
    JSON.stringify({
      number: 3,
      url: "u",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: rollup,
    });

  test("prStatus argv and mapping", async () => {
    const cases: [unknown[], string][] = [
      [[], "none"],
      [
        [
          { conclusion: "SUCCESS", status: "COMPLETED" },
          { conclusion: "SKIPPED", status: "COMPLETED" },
          { state: "SUCCESS" },
        ],
        "passing",
      ],
      [
        [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }, { status: "IN_PROGRESS" }],
        "failing",
      ],
      [[{ conclusion: "TIMED_OUT" }], "failing"],
      [[{ state: "ERROR" }], "failing"],
      [
        [
          { conclusion: "SUCCESS", status: "COMPLETED" },
          { status: "IN_PROGRESS", conclusion: "" },
        ],
        "pending",
      ],
      [[{ state: "PENDING" }], "pending"],
      [[{ status: "QUEUED" }], "pending"],
    ];
    for (const [rollup, want] of cases) {
      const p = run(view(rollup));
      const s = await p.prStatus({ upstream: up, number: 3 });
      expect(s).toEqual({ state: "OPEN", mergeable: "MERGEABLE", checks: want as never });
    }
    expect(argvs()).toEqual([
      [
        "pr",
        "view",
        "3",
        "--repo",
        "o/r",
        "--json",
        "number,url,state,mergeable,statusCheckRollup",
      ],
    ]);
  });

  test("non-zero exit gives fixed code and never leaks title, body or output", async () => {
    const p = run("SECRETOUT", 1, "SECRETERR");
    const logged: unknown[] = [];
    const [oLog, oErr, oWarn] = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...a: unknown[]) => void logged.push(a);
    let err: unknown;
    try {
      await p.createPr({
        upstream: up,
        headOwner: "f",
        branch: "b",
        title: "SECRETTITLE",
        body: "SECRETBODY",
      });
    } catch (e) {
      err = e;
    } finally {
      console.log = oLog;
      console.error = oErr;
      console.warn = oWarn;
    }
    expect(err).toBeInstanceOf(PullRequestError);
    const text =
      JSON.stringify(err) +
      String((err as Error).message) +
      (err as Error).stack +
      JSON.stringify(logged);
    expect((err as PullRequestError).code).toBe("pr_create_failed");
    for (const s of ["SECRETTITLE", "SECRETBODY", "SECRETOUT", "SECRETERR"]) {
      expect(text).not.toContain(s);
    }
  });

  test("auth failure maps to gh_auth", async () => {
    const p = run("", 1, "gh auth login required: not logged in");
    await expect(p.mergePr({ upstream: up, number: 1 })).rejects.toMatchObject({ code: "gh_auth" });
  });

  test("missing binary maps to gh_not_found", async () => {
    const p = new GitHubCliProvider({ binary: join(dir, "nope") });
    await expect(p.mergePr({ upstream: up, number: 1 })).rejects.toMatchObject({
      code: "gh_not_found",
    });
  });
});
