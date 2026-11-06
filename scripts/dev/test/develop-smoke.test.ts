import { expect, test } from "bun:test";
import { formatSummary, outcomeOf, type SmokeSummary } from "../develop-smoke";

const base: SmokeSummary = {
  investigate: { ok: true },
  develop: { files: 2, testsPassed: true, unsafe: false },
  commit: { ok: true },
  mergeLocal: { ok: true },
  cancelledBeforePush: true,
  lockReleased: true,
};

test("formatSummary prints statuses and counts only, in the documented lines", () => {
  expect(formatSummary(base)).toEqual([
    "investigate: ok",
    "develop: files=2 testsPassed=true unsafe=false",
    "commit: ok",
    "merge_local: ok",
    "cancelled_before_push: true",
    "lock_released: true",
  ]);
});

test("formatSummary shows failure codes and a develop run that never happened", () => {
  const lines = formatSummary({
    ...base,
    investigate: { ok: false, code: "parse_failed" },
    develop: null,
    commit: { ok: false, code: "not_run" },
    mergeLocal: { ok: false, code: "not_run" },
    cancelledBeforePush: false,
    lockReleased: false,
  });
  expect(lines).toEqual([
    "investigate: failed(parse_failed)",
    "develop: not_run",
    "commit: failed(not_run)",
    "merge_local: failed(not_run)",
    "cancelled_before_push: false",
    "lock_released: false",
  ]);
});

test("outcomeOf maps a done step to ok and anything else to a fixed code", () => {
  expect(outcomeOf("done", null)).toEqual({ ok: true });
  expect(outcomeOf("failed", "unsafe_change")).toEqual({ ok: false, code: "unsafe_change" });
  expect(outcomeOf("awaiting_approval", null)).toEqual({ ok: false, code: "awaiting_approval" });
  expect(outcomeOf(undefined, null)).toEqual({ ok: false, code: "not_run" });
});

test("outcomeOf never echoes a failure that is not a fixed code", () => {
  expect(outcomeOf("failed", "secret text /home/me/x")).toEqual({ ok: false, code: "unknown" });
  expect(outcomeOf("failed", "registry_error:duplicate_name")).toEqual({
    ok: false,
    code: "registry_error:duplicate_name",
  });
});
