import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CandidateFile,
  defaultFsOps,
  type FsOps,
  listCandidateFiles,
  ProjectsDirUnreadable,
  readNewLines,
  SessionFileUnreadable,
} from "../../src/modules/claude-activity/scanner";
import { encodeProjectDir } from "../../src/modules/claude-activity/session-meta";
import { sessionLine, writeSession } from "../fixtures/claude-sessions";
import { tempDir } from "../fixtures/git-repo";

const REPO = "/work/demo-app";
const ID = "00000000-0000-4000-8000-000000000001";

function recording(): { fs: FsOps; touched: string[] } {
  const touched: string[] = [];
  const rec =
    <A extends unknown[], R>(fn: (p: string, ...a: A) => R) =>
    (p: string, ...a: A): R => {
      touched.push(p);
      return fn(p, ...a);
    };
  return {
    touched,
    fs: {
      readdir: rec(defaultFsOps.readdir),
      lstat: rec(defaultFsOps.lstat),
      realpath: rec(defaultFsOps.realpath),
      readRange: rec(defaultFsOps.readRange),
    },
  };
}

const dirs: string[] = [];
function projects(): string {
  const d = tempDir("synapse-claude-proj-");
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o755);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});

describe("listCandidateFiles", () => {
  test("lists top-level jsonl in candidate dirs only; unregistered dirs are never touched", async () => {
    const root = projects();
    const enc = encodeProjectDir(REPO);
    writeSession(join(root, enc), ID, [sessionLine("user")]);
    writeSession(join(root, `${enc}-sub`), "s2", [sessionLine("user")]);
    writeSession(join(root, "-work-other"), "s3", [sessionLine("user")]);
    writeSession(join(root, `${enc}x`), "s4", [sessionLine("user")]);
    writeSession(join(root, enc, "subagents"), "x", [sessionLine("user")]);
    mkdirSync(join(root, enc, "tool-results"), { recursive: true });
    writeFileSync(join(root, enc, "tool-results", "r.jsonl"), "{}\n");
    writeFileSync(join(root, enc, "notes.txt"), "x");
    writeFileSync(join(root, enc, "bad name.jsonl"), "{}\n");
    const { fs, touched } = recording();
    const files = await listCandidateFiles(root, [REPO], fs);
    expect(files.map((f) => f.sessionId).sort()).toEqual([ID, "s2"]);
    expect(touched.some((p) => p.includes("-work-other") || p.includes(`${enc}x`))).toBe(false);
    expect(touched.some((p) => p.includes("subagents") || p.includes("tool-results"))).toBe(false);
  });

  test("symlinked files and symlinked candidate dirs are skipped", async () => {
    const root = projects();
    const outside = projects();
    const enc = encodeProjectDir(REPO);
    writeSession(outside, "real", [sessionLine("user")]);
    mkdirSync(join(root, enc), { recursive: true });
    symlinkSync(join(outside, "real.jsonl"), join(root, enc, "linked.jsonl"));
    writeSession(outside, "other", [sessionLine("user")]);
    symlinkSync(outside, join(root, `${enc}-link`));
    const files = await listCandidateFiles(root, [REPO]);
    expect(files).toEqual([]);
  });

  test("missing projects dir returns []", async () => {
    expect(await listCandidateFiles(join(projects(), "nope"), [REPO])).toEqual([]);
  });

  test("an unreadable projects dir throws ProjectsDirUnreadable", async () => {
    const root = projects();
    const fs: FsOps = {
      ...defaultFsOps,
      readdir: async () => {
        throw Object.assign(new Error("denied /secret/path"), { code: "EACCES" });
      },
    };
    const err = await listCandidateFiles(root, [REPO], fs).catch((e) => e);
    expect(err).toBeInstanceOf(ProjectsDirUnreadable);
    expect(String(err.message)).not.toContain("/secret/path");
  });
});

describe("readNewLines", () => {
  function fileOf(path: string, size: number): CandidateFile {
    return { path, sessionId: ID, size, mtimeMs: 0 };
  }

  test("stops at the last newline; garbage and unknown lines do not throw", async () => {
    const root = projects();
    const path = writeSession(root, ID, [
      sessionLine("user", { cwd: "/work/demo-app", gitBranch: "main" }),
      "not json at all",
      sessionLine("x-new", { foo: 1 }),
    ]);
    const complete = Bun.file(path).size;
    writeFileSync(path, `${await Bun.file(path).text()}{"type":"ai-ti`);
    const size = Bun.file(path).size;
    const r = await readNewLines(fileOf(path, size), 0);
    expect(r.consumedTo).toBe(complete);
    expect(r.lines).toBe(3);
    expect(r.known).toBe(1);
    expect(r.parseErrors).toBe(1);
    expect(r.deltas).toEqual([{ cwd: "/work/demo-app", gitBranch: "main" }]);

    writeFileSync(
      path,
      `${(await Bun.file(path).text()).slice(0, complete)}${sessionLine("ai-title", { aiTitle: "Demo title" })}\n`,
    );
    const r2 = await readNewLines(fileOf(path, Bun.file(path).size), r.consumedTo);
    expect(r2.deltas).toEqual([{ aiTitle: "Demo title" }]);
    expect(r2.consumedTo).toBe(Bun.file(path).size);
  });

  test("a file deleted after listing throws a path-free error", async () => {
    const root = projects();
    const path = writeSession(root, ID, [sessionLine("user")]);
    const size = Bun.file(path).size;
    rmSync(path);
    const err = await readNewLines(fileOf(path, size), 0).catch((e) => e);
    expect(err).toBeInstanceOf(SessionFileUnreadable);
    expect(err.code).toBe("ENOENT");
    expect(err.message).not.toContain(root);
  });

  test("a file that became a symlink is not followed", async () => {
    const root = projects();
    const outside = writeSession(projects(), "t", [sessionLine("user", { cwd: "/x" })]);
    const path = join(root, `${ID}.jsonl`);
    symlinkSync(outside, path);
    const err = await readNewLines(fileOf(path, Bun.file(outside).size), 0).catch((e) => e);
    expect(err).toBeInstanceOf(SessionFileUnreadable);
  });

  test("the tail of a consumed oversized line is skipped, not parsed", async () => {
    const root = projects();
    const first = `${"x".repeat(5)}`;
    const path = join(root, `${ID}.jsonl`);
    const tail = `ZZZ"}\n${sessionLine("ai-title", { aiTitle: "Demo title" })}\n`;
    writeFileSync(path, first + tail);
    // offset 5: previous byte is "x", not a newline
    const r = await readNewLines(fileOf(path, Bun.file(path).size), 5);
    expect(r.parseErrors).toBe(0);
    expect(r.deltas).toEqual([{ aiTitle: "Demo title" }]);
    // tail with no newline at all is consumed whole
    writeFileSync(path, `${first}ZZZ`);
    const r2 = await readNewLines(fileOf(path, Bun.file(path).size), 5);
    expect(r2).toMatchObject({ lines: 0, parseErrors: 0, consumedTo: 8 });
  });

  test("nothing new reads nothing", async () => {
    const root = projects();
    const path = writeSession(root, ID, [sessionLine("user")]);
    const size = Bun.file(path).size;
    const r = await readNewLines(fileOf(path, size), size);
    expect(r).toEqual({
      deltas: [],
      consumedTo: size,
      lines: 0,
      known: 0,
      parseErrors: 0,
      oversized: 0,
    });
  });
});
