import { expect, test } from "bun:test";
import { assemblePrompt, UNTRUSTED_WARNING } from "../../src/core/orchestrator/prompt";

test("wraps untrusted parts and leads with warning", () => {
  const p = assemblePrompt(
    "do it",
    [
      { provenance: "system", content: "sys" },
      { provenance: "untrusted", source: 'sl"ack<x>', content: "hello" },
    ],
    "B1",
  );
  expect(p.startsWith(UNTRUSTED_WARNING)).toBe(true);
  expect(p).toContain('<<<UNTRUSTED B1 source="slackx">>>\nhello\n<<<END B1>>>');
});

test("no warning without untrusted parts", () => {
  const p = assemblePrompt("do it", [{ provenance: "user_approved", content: "ok" }], "B1");
  expect(p).not.toContain("UNTRUSTED");
  expect(p).toContain("ok");
});
