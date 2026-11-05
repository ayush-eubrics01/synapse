import { expect, test } from "bun:test";
import { backfillAction } from "../lib/backfill-action";

test("idle starts, error and resumable resume, everything else is disabled (R54, R60 M4)", () => {
  expect(backfillAction({ status: "idle", resumable: false })).toEqual({
    enabled: true,
    label: "Start 90-day backfill",
  });
  expect(backfillAction({ status: "error", resumable: false })).toEqual({
    enabled: true,
    label: "Resume backfill",
  });
  expect(backfillAction({ status: "running", resumable: true })).toEqual({
    enabled: true,
    label: "Resume backfill",
  });
  for (const status of ["running", "paused", "complete"] as const) {
    expect(backfillAction({ status, resumable: false }).enabled).toBe(false);
  }
});
