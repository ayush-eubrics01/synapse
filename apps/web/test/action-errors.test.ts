import { expect, test } from "bun:test";
import { actionErrorText, NO_ACTION_ERRORS } from "../lib/action-errors";

test("immediate and deferred errors are shown together, deferred first", () => {
  expect(actionErrorText(NO_ACTION_ERRORS)).toBeNull();
  expect(actionErrorText({ immediate: "409 conflict", deferred: null })).toBe("409 conflict");
  expect(actionErrorText({ immediate: null, deferred: "commit failed" })).toBe("commit failed");
  expect(actionErrorText({ immediate: "409 conflict", deferred: "commit failed" })).toBe(
    "commit failed · 409 conflict",
  );
});
