import { expect, test } from "bun:test";
import { parseSelf } from "../send-smoke";

test("send-smoke requires a well-formed --self id and never defaults one", () => {
  expect(parseSelf(["--self", "UABC123456"])).toBe("UABC123456");
  expect(() => parseSelf([])).toThrow(/usage/);
  expect(() => parseSelf(["--self", "bob"])).toThrow(/usage/);
});
