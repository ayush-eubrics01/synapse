import { expect, test } from "bun:test";
import { followupThreadTs } from "../../src/modules/commitments/thread";

test("R11 placement: im top-level unless a thread reply; mpim and channel thread under the source", () => {
  expect(followupThreadTs("im", null, "5.1")).toBeNull();
  expect(followupThreadTs("im", "4.0", "5.1")).toBe("4.0");
  expect(followupThreadTs("mpim", null, "5.1")).toBe("5.1");
  expect(followupThreadTs("channel", null, "5.1")).toBe("5.1");
  expect(followupThreadTs("channel", "4.0", "5.1")).toBe("4.0");
});
