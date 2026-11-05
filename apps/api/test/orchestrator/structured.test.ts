import { expect, test } from "bun:test";
import { z } from "zod";
import { extractJson, parseStructured } from "../../src/core/orchestrator/structured";

test("extractJson: last fenced block wins", () => {
  const t = 'a\n```json\n{"a":1}\n```\nmore\n```json\n{"a":2}\n```\n';
  expect(extractJson(t)).toEqual({ a: 2 });
});
test("extractJson: raw JSON", () => {
  expect(extractJson('  {"a":1} ')).toEqual({ a: 1 });
});
test("extractJson: prose has no JSON", () => {
  expect(extractJson("nothing to see")).toBeUndefined();
});
test("parseStructured ok and failure reasons carry no values", () => {
  const schema = z.object({ n: z.number() });
  expect(parseStructured('```json\n{"n":3}\n```', schema)).toEqual({ ok: true, value: { n: 3 } });
  const bad = parseStructured('{"n":"SECRET-VALUE"}', schema);
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.reason).not.toContain("SECRET-VALUE");
  expect(parseStructured("prose", schema).ok).toBe(false);
});
