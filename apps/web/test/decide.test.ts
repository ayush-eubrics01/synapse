import { expect, test } from "bun:test";
import { decideThenRefresh } from "../lib/decide";

test("a rejected decision keeps its error after a successful refresh", async () => {
  let refreshed = 0;
  const out = await decideThenRefresh(
    () => Promise.reject(new Error("POST /api/approvals/a1/approve failed with 409: expired")),
    async () => {
      refreshed++;
      return null;
    },
  );
  expect(refreshed).toBe(1);
  expect(out.actionError).toContain("409");
  expect(out.loadError).toBeNull();
});

test("a successful decision has no action error; load error is reported separately", async () => {
  const out = await decideThenRefresh(
    async () => ({}),
    async () => "load failed",
  );
  expect(out).toEqual({ actionError: null, loadError: "load failed" });
});
