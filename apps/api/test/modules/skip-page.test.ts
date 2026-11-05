import { expect, test } from "bun:test";
import { addOneSecond } from "../../src/modules/inbox/skip-page";

test("addOneSecond adds exactly one second and keeps the fraction", () => {
  expect(addOneSecond("1793872920.000500")).toBe("1793872921.000500");
  expect(addOneSecond("1793872999.999999")).toBe("1793873000.999999");
  expect(addOneSecond("1793872920.000000")).toBe("1793872921.000000");
});

test("addOneSecond returns null for malformed input", () => {
  for (const bad of ["", "abc", "1793872920", "1793872920.5", "1793872920.0000001", "-1.000000"]) {
    expect(addOneSecond(bad)).toBeNull();
  }
});
