import { expect, test } from "bun:test";
import { codeAnswerOutputSchema, codeAnswerStatusSchema } from "../src/code-answers.ts";

const inj = { detected: false, severity: "info", quote: "", reason: "" };
const ok = {
  answerable: true,
  answer: "x",
  confidence: 0.8,
  evidence: [{ path: "src/a.ts", line: 3 }],
  suspectedInjection: inj,
};

test("a valid answerable output parses", () => {
  expect(codeAnswerOutputSchema.safeParse(ok).success).toBe(true);
});

test("answerable needs a non-empty answer and evidence", () => {
  expect(codeAnswerOutputSchema.safeParse({ ...ok, answer: "" }).success).toBe(false);
  expect(codeAnswerOutputSchema.safeParse({ ...ok, evidence: [] }).success).toBe(false);
});

test("not answerable needs an empty answer", () => {
  const na = { ...ok, answerable: false, answer: "", evidence: [], notAnswerableReason: "r" };
  expect(codeAnswerOutputSchema.safeParse(na).success).toBe(true);
  expect(codeAnswerOutputSchema.safeParse({ ...na, answer: "something" }).success).toBe(false);
});

test("evidence bounds, strictness and line >= 1", () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.ts` }));
  expect(codeAnswerOutputSchema.safeParse({ ...ok, evidence: nine }).success).toBe(false);
  expect(codeAnswerOutputSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  expect(
    codeAnswerOutputSchema.safeParse({ ...ok, evidence: [{ path: "a.ts", line: 0 }] }).success,
  ).toBe(false);
});

test("status enum has the nine C4 statuses", () => {
  expect(codeAnswerStatusSchema.options).toHaveLength(9);
});
