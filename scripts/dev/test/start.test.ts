import { expect, test } from "bun:test";
import { LineSplitter } from "../start";

test("LineSplitter emits complete lines with the prefix and keeps the partial tail", () => {
  const out: string[] = [];
  const s = new LineSplitter("[api] ", (l) => out.push(l));
  s.push("one\ntw");
  expect(out).toEqual(["[api] one"]);
  s.push("o\nthree\n");
  expect(out).toEqual(["[api] one", "[api] two", "[api] three"]);
  s.flush();
  expect(out).toHaveLength(3);
});

test("LineSplitter flushes a trailing partial line", () => {
  const out: string[] = [];
  const s = new LineSplitter("[web] ", (l) => out.push(l));
  s.push("ready");
  s.flush();
  expect(out).toEqual(["[web] ready"]);
});
