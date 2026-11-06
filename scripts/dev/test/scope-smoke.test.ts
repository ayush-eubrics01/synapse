import { expect, test } from "bun:test";
import { classifyScope, summarizeScope } from "../scope-smoke";

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

test("summarizeScope prints only the three status lines, never content", () => {
  const lines = summarizeScope({ inside: "ok", outside: "blocked", verdict: "blocked" });
  expect(lines).toEqual(["inside: ok", "outside: blocked", "scope-smoke: blocked"]);
  expect(summarizeScope({ inside: "ok", outside: "leaked", verdict: "leaked" }).at(-1)).toBe(
    "scope-smoke: LEAKED",
  );
});
