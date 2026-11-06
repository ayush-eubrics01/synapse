import { describe, expect, test } from "bun:test";
import {
  encodeProjectDir,
  extractSessionMeta,
  foldMeta,
  isCandidateDir,
  MAX_LINE_BYTES,
  splitCompleteLines,
} from "../../src/modules/claude-activity/session-meta";
import { SENTINEL } from "../fixtures/claude-sessions";

const WHITELIST = new Set([
  "cwd",
  "gitBranch",
  "timestamp",
  "version",
  "entrypoint",
  "aiTitle",
  "pr",
]);
const enc = (s: string) => new TextEncoder().encode(s);

describe("extractSessionMeta", () => {
  const types = [
    "user",
    "assistant",
    "last-prompt",
    "queue-operation",
    "attachment",
    "file-history-snapshot",
    "system",
    "ai-title",
    "pr-link",
    "x-new",
  ];
  for (const type of types) {
    test(`never leaks non-whitelisted content (${type})`, () => {
      const line = {
        type,
        sessionId: "s",
        cwd: "/tmp/demo-app",
        message: { content: SENTINEL, nested: { deep: SENTINEL } },
        lastPrompt: SENTINEL,
        content: SENTINEL,
        snapshot: { files: [SENTINEL] },
        attachment: { text: SENTINEL },
        toolUseResult: SENTINEL,
        thinking: SENTINEL,
        operation: SENTINEL,
        aiTitle: type === "ai-title" ? "Demo title" : undefined,
        prUrl: type === "pr-link" ? "https://github.com/demo-org/demo-app/pull/7" : undefined,
        prNumber: type === "pr-link" ? 7 : undefined,
        prRepository: type === "pr-link" ? "demo-org/demo-app" : undefined,
      };
      const out = extractSessionMeta(line);
      expect(JSON.stringify(out)).not.toContain(SENTINEL);
      for (const k of Object.keys(out ?? {})) expect(WHITELIST.has(k)).toBe(true);
    });
  }

  test("aiTitle only from ai-title lines, cut to 200", () => {
    expect(extractSessionMeta({ type: "ai-title", aiTitle: "Demo title", sessionId: "s" })).toEqual(
      {
        aiTitle: "Demo title",
      },
    );
    expect(
      extractSessionMeta({ type: "ai-title", aiTitle: "x".repeat(300) })?.aiTitle,
    ).toHaveLength(200);
    expect(extractSessionMeta({ type: "user", aiTitle: "Demo title" })).toBeNull();
  });

  test("title cut never leaves a lone surrogate", () => {
    const title = `${"a".repeat(199)}\u{1F600}tail`;
    const cut = extractSessionMeta({ type: "ai-title", aiTitle: title })?.aiTitle ?? "";
    expect(cut).toBe("a".repeat(199));
    expect(cut.isWellFormed()).toBe(true);
  });

  test("pr only from valid pr-link lines", () => {
    const ok = {
      type: "pr-link",
      prUrl: "https://github.com/demo-org/demo-app/pull/7",
      prNumber: 7,
      prRepository: "demo-org/demo-app",
    };
    expect(extractSessionMeta(ok)?.pr).toEqual({
      url: ok.prUrl,
      number: 7,
      repository: "demo-org/demo-app",
    });
    expect(extractSessionMeta({ ...ok, prNumber: "7" })?.pr).toBeUndefined();
    expect(extractSessionMeta({ ...ok, prNumber: 0 })?.pr).toBeUndefined();
    expect(extractSessionMeta({ ...ok, prUrl: "http://x/1" })?.pr).toBeUndefined();
    expect(extractSessionMeta({ ...ok, type: "user" })?.pr).toBeUndefined();
  });

  test("scalar fields are validated", () => {
    expect(
      extractSessionMeta({
        cwd: "/tmp/demo-app",
        gitBranch: "main",
        version: "2.1.0",
        entrypoint: "cli",
        timestamp: "2026-11-06T10:00:00.000Z",
      }),
    ).toEqual({
      cwd: "/tmp/demo-app",
      gitBranch: "main",
      version: "2.1.0",
      entrypoint: "cli",
      timestamp: "2026-11-06T10:00:00.000Z",
    });
    expect(extractSessionMeta({ cwd: "relative/path" })).toBeNull();
    expect(extractSessionMeta({ timestamp: "not a date" })).toBeNull();
    for (const bad of ["1", "Nov 6", "2026-11-06", "6 Nov 2026 10:00 UTC"]) {
      expect(extractSessionMeta({ timestamp: bad })).toBeNull();
    }
    expect(extractSessionMeta({ timestamp: "2026-11-06T11:00:00+01:00" })?.timestamp).toBe(
      "2026-11-06T10:00:00.000Z",
    );
    expect(extractSessionMeta({ gitBranch: "b".repeat(256) })).toBeNull();
  });

  test("non-objects and empty objects yield null", () => {
    expect(extractSessionMeta(42)).toBeNull();
    expect(extractSessionMeta(null)).toBeNull();
    expect(extractSessionMeta([])).toBeNull();
    expect(extractSessionMeta({})).toBeNull();
  });
});

describe("project dir encoding", () => {
  test("encodeProjectDir", () => {
    expect(encodeProjectDir("/tmp/demo app/x.y")).toBe("-tmp-demo-app-x-y");
  });
  test("isCandidateDir", () => {
    const e = encodeProjectDir("/tmp/demo-app");
    expect(isCandidateDir(e, [e])).toBe(true);
    expect(isCandidateDir(`${e}-src`, [e])).toBe(true);
    expect(isCandidateDir(`${e}x`, [e])).toBe(false);
    expect(isCandidateDir("-tmp-other", [e])).toBe(false);
  });
});

describe("splitCompleteLines", () => {
  test("partial tail is not consumed", () => {
    expect(splitCompleteLines(enc("a\nb\npar"), 100)).toEqual({
      lines: ["a", "b"],
      consumed: 4,
      oversized: 0,
    });
  });
  test("multi-byte characters count in bytes", () => {
    const r = splitCompleteLines(enc("h\u00e9\u{1F600}\nz\n\u00e9"), 100);
    expect(r.lines).toEqual(["h\u00e9\u{1F600}", "z"]);
    expect(r.consumed).toBe(1 + 2 + 4 + 1 + 1 + 1);
    expect(splitCompleteLines(enc("\u00e9\u00e9\u00e9\n"), 5).oversized).toBe(1);
  });
  test("oversized line is consumed unparsed", () => {
    const big = "x".repeat(MAX_LINE_BYTES + (MAX_LINE_BYTES >> 1));
    const r = splitCompleteLines(enc(`${big}\nok\n`), MAX_LINE_BYTES);
    expect(r.oversized).toBe(1);
    expect(r.lines).toEqual(["ok"]);
    expect(r.consumed).toBe(big.length + 1 + 3);
  });
  test("oversized newline-free chunk is consumed", () => {
    const r = splitCompleteLines(enc("x".repeat(2 << 20)), MAX_LINE_BYTES);
    expect(r).toEqual({ lines: [], consumed: 2 << 20, oversized: 1 });
  });
  test("short newline-free chunk waits", () => {
    expect(splitCompleteLines(enc("0123456789"), MAX_LINE_BYTES)).toEqual({
      lines: [],
      consumed: 0,
      oversized: 0,
    });
  });
});

describe("foldMeta", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  test("a duplicate PR url keeps the first-seen seenAt and branch", () => {
    const pr = {
      url: "https://github.com/demo-org/demo-app/pull/7",
      number: 7,
      repository: "demo-org/demo-app",
    };
    const acc = foldMeta(
      null,
      [
        { gitBranch: "feature-x" },
        { pr, timestamp: "2026-11-06T10:00:00.000Z" },
        { gitBranch: "main" },
        { pr, timestamp: "2026-11-06T11:00:00.000Z" },
      ],
      now,
    );
    expect(acc.prs).toEqual([{ ...pr, seenAt: "2026-11-06T10:00:00.000Z", branch: "feature-x" }]);
  });
  test("first cwd wins, last branch wins", () => {
    const acc = foldMeta(
      null,
      [
        { cwd: "/a", gitBranch: "main" },
        { cwd: "/b", gitBranch: "stage" },
        { aiTitle: "T1" },
        { aiTitle: "T2" },
      ],
      now,
    );
    expect(acc.cwd).toBe("/a");
    expect(acc.gitBranch).toBe("stage");
    expect(acc.title).toBe("T2");
    const next = foldMeta(acc, [{ cwd: "/c" }], now);
    expect(next.cwd).toBe("/a");
  });
  test("future timestamps are ignored", () => {
    const acc = foldMeta(
      null,
      [{ timestamp: "2026-11-06T11:00:00.000Z" }, { timestamp: "2026-11-06T13:00:00.000Z" }],
      now,
    );
    expect(acc.lastAt).toBe("2026-11-06T11:00:00.000Z");
    expect(acc.firstAt).toBe("2026-11-06T11:00:00.000Z");
  });
  test("a PR carries the branch seen before it", () => {
    const pr = {
      url: "https://github.com/demo-org/demo-app/pull/7",
      number: 7,
      repository: "demo-org/demo-app",
    };
    const acc = foldMeta(
      null,
      [
        { gitBranch: "feature-x" },
        { pr, timestamp: "2026-11-06T11:00:00.000Z" },
        { gitBranch: "main" },
      ],
      now,
    );
    expect(acc.prs).toEqual([{ ...pr, seenAt: "2026-11-06T11:00:00.000Z", branch: "feature-x" }]);
    expect(acc.gitBranch).toBe("main");
  });
});
