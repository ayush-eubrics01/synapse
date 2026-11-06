import { expect, test } from "bun:test";
import { hueFor, initials } from "../lib/avatar";

test("hueFor is stable, in range and differs for two ids", () => {
  const a = hueFor("U0ADA");
  expect(hueFor("U0ADA")).toBe(a);
  for (const id of ["U0ADA", "U0GRACE", "C0OPS", "", "x"]) {
    const h = hueFor(id);
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  }
  expect(hueFor("U0GRACE")).not.toBe(a);
});

test("initials take the first and last word, uppercase", () => {
  expect(initials("Ada Lovelace", "U1")).toBe("AL");
  expect(initials("grace brewster hopper", "U2")).toBe("GH");
  expect(initials("Linus", "U3")).toBe("L");
});

test("initials fall back to the id, then to ?", () => {
  expect(initials(null, "U0ADA")).toBe("U0");
  expect(initials("   ", "u9x")).toBe("U9");
  expect(initials(null, "")).toBe("?");
  expect(initials("--", "!!")).toBe("?");
});
