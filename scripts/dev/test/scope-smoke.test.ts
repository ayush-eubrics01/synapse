import { expect, test } from "bun:test";
import {
  buildScopeRequest,
  classifyControl,
  classifyScope,
  smokeVerdict,
  summarizeScope,
} from "../scope-smoke";

const paths = { insidePath: "/tmp/x/inside/a.txt", outsidePath: "/tmp/x/outside/b.txt" };
const markers = { insideMarker: "INSIDE-MARK", outsideMarker: "OUTSIDE-MARK" };
const opts = { ...paths, ...markers };

const read = (file: string, content: string, isError = false) => ({
  toolName: "Read",
  input: { file_path: file },
  isError,
  content,
});

test("blocked: inside read ok, outside read is an error", () => {
  const c = classifyScope(
    [read(paths.insidePath, "1\tINSIDE-MARK"), read(paths.outsidePath, "permission denied", true)],
    [],
    opts,
  );
  expect(c).toEqual({ inside: "ok", outside: "blocked", verdict: "blocked" });
});

test("blocked: outside attempt shown only as a permission denial", () => {
  const c = classifyScope([read(paths.insidePath, "INSIDE-MARK")], ["Read"], opts);
  expect(c.verdict).toBe("blocked");
  expect(c.outside).toBe("blocked");
});

test("leaked: the outside marker appears in any result, even a non-Read one", () => {
  const c = classifyScope(
    [
      read(paths.insidePath, "INSIDE-MARK"),
      { toolName: "Grep", input: {}, isError: false, content: "x OUTSIDE-MARK y" },
    ],
    [],
    opts,
  );
  expect(c.outside).toBe("leaked");
  expect(c.verdict).toBe("leaked");
});

test("leaked wins even when the inside read failed", () => {
  const c = classifyScope([read(paths.outsidePath, "OUTSIDE-MARK")], [], opts);
  expect(c).toEqual({ inside: "missing", outside: "leaked", verdict: "leaked" });
});

test("inconclusive: outside never attempted", () => {
  const c = classifyScope([read(paths.insidePath, "INSIDE-MARK")], [], opts);
  expect(c).toEqual({ inside: "ok", outside: "not_attempted", verdict: "inconclusive" });
});

test("inconclusive: outside blocked but the inside read did not succeed", () => {
  const c = classifyScope(
    [read(paths.insidePath, "denied", true), read(paths.outsidePath, "denied", true)],
    [],
    opts,
  );
  expect(c).toEqual({ inside: "missing", outside: "blocked", verdict: "inconclusive" });
});

test("inconclusive: no results at all", () => {
  expect(classifyScope([], [], opts)).toEqual({
    inside: "missing",
    outside: "not_attempted",
    verdict: "inconclusive",
  });
});

const BLOCKED = { inside: "ok", outside: "blocked", verdict: "blocked" } as const;

test("control: denied when the inside read errors or only a denial is recorded", () => {
  expect(
    classifyControl([read(paths.insidePath, "denied", true)], [], paths.insidePath, "INSIDE-MARK"),
  ).toBe("denied");
  expect(classifyControl([], ["Read"], paths.insidePath, "INSIDE-MARK")).toBe("denied");
  expect(classifyControl([], [], paths.insidePath, "INSIDE-MARK")).toBe("not_attempted");
});

test("control: ok when the inside content came back by any tool", () => {
  expect(
    classifyControl(
      [read(paths.insidePath, "1\tINSIDE-MARK")],
      [],
      paths.insidePath,
      "INSIDE-MARK",
    ),
  ).toBe("ok");
  expect(
    classifyControl(
      [{ toolName: "Grep", input: {}, isError: false, content: "INSIDE-MARK" }],
      ["Read"],
      paths.insidePath,
      "INSIDE-MARK",
    ),
  ).toBe("ok");
});

test("verdict: blocked needs double blocked AND the control denied", () => {
  expect(smokeVerdict(BLOCKED, "denied")).toBe("blocked");
  // A control that read the file means something other than the rule grants access.
  expect(smokeVerdict(BLOCKED, "ok")).toBe("leaked");
  expect(smokeVerdict(BLOCKED, "not_attempted")).toBe("inconclusive");
  expect(smokeVerdict({ inside: "ok", outside: "leaked", verdict: "leaked" }, "denied")).toBe(
    "leaked",
  );
  expect(
    smokeVerdict({ inside: "missing", outside: "blocked", verdict: "inconclusive" }, "denied"),
  ).toBe("inconclusive");
});

test("summarizeScope prints only the three status lines, never content", () => {
  expect(summarizeScope(BLOCKED, "denied")).toEqual([
    "double: inside=ok outside=blocked",
    "single(control): inside=denied",
    "scope-smoke: blocked",
  ]);
  expect(summarizeScope(BLOCKED, "ok").at(-1)).toBe("scope-smoke: LEAKED");
  expect(summarizeScope(BLOCKED, "not_attempted").at(-1)).toBe("scope-smoke: inconclusive");
});

test("buildScopeRequest: one allowed tool, engineering denylist, cwd as given", () => {
  const r = buildScopeRequest("Read(//tmp/x/inside/**)", "/tmp/x/cwd", "go");
  expect(r.allowedTools).toEqual(["Read(//tmp/x/inside/**)"]);
  expect(r.workingDirectory).toBe("/tmp/x/cwd");
  expect(r.workerProfile).toBe("engineering");
  for (const t of ["Bash", "Edit", "Write", "Grep", "Glob", "WebFetch"]) {
    expect(r.disallowedTools).toContain(t);
  }
  expect(r.disallowedTools).not.toContain("Read");
});
