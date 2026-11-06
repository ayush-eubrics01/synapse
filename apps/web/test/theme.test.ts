import { expect, test } from "bun:test";
import {
  readTheme,
  systemPrefersDark,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  writeTheme,
} from "../lib/theme";

const store = (value: string | null) => ({ getItem: (_k: string) => value });

test("readTheme falls back to prefers-color-scheme with no storage", () => {
  expect(readTheme(null, true)).toBe("dark");
  expect(readTheme(null, false)).toBe("light");
});

test("readTheme uses the fallback when getItem throws", () => {
  const throwing = {
    getItem: () => {
      throw new Error("denied");
    },
  };
  expect(readTheme(throwing, true)).toBe("dark");
  expect(readTheme(throwing, false)).toBe("light");
});

test("a stored theme wins and a junk value is ignored", () => {
  expect(readTheme(store("light"), true)).toBe("light");
  expect(readTheme(store("dark"), false)).toBe("dark");
  expect(readTheme(store("purple"), true)).toBe("dark");
  expect(readTheme(store(null), false)).toBe("light");
});

test("writeTheme stores under synapse.theme and swallows errors", () => {
  const writes: Array<[string, string]> = [];
  writeTheme({ setItem: (k: string, v: string) => void writes.push([k, v]) }, "light");
  expect(writes).toEqual([[THEME_STORAGE_KEY, "light"]]);
  expect(THEME_STORAGE_KEY).toBe("synapse.theme");
  const throwing = {
    setItem: () => {
      throw new Error("quota");
    },
  };
  expect(() => writeTheme(throwing, "dark")).not.toThrow();
  expect(() => writeTheme(null, "dark")).not.toThrow();
});

type Media = "missing" | "throws" | boolean;
const mediaWindow = (m: Media): { matchMedia?: (q: string) => { matches: boolean } } =>
  m === "missing"
    ? {}
    : {
        matchMedia: () => {
          if (m === "throws") throw new Error("no media queries");
          return { matches: m };
        },
      };

function boot(stored: string | null | "throw", prefersDark: Media): string | null {
  const attrs: Record<string, string> = {};
  const localStorage = {
    getItem: () => {
      if (stored === "throw") throw new Error("denied");
      return stored;
    },
  };
  const window = mediaWindow(prefersDark);
  const document = {
    documentElement: {
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
    },
  };
  new Function("localStorage", "window", "document", THEME_BOOT_SCRIPT)(
    localStorage,
    window,
    document,
  );
  return attrs["data-theme"] ?? null;
}

test("the boot script applies the stored theme, else the system preference", () => {
  expect(boot("light", true)).toBe("light");
  expect(boot("junk", true)).toBe("dark");
  expect(boot(null, false)).toBe("light");
  expect(boot("throw", true)).toBe("dark");
});

test("the switch and the boot script share one rule when matchMedia is missing or throws", () => {
  for (const m of ["missing", "throws", true, false] as const) {
    expect(readTheme(null, systemPrefersDark(mediaWindow(m))) as string).toBe(boot(null, m) ?? "");
  }
  expect(systemPrefersDark(mediaWindow("missing"))).toBe(false);
  expect(systemPrefersDark(mediaWindow("throws"))).toBe(false);
  expect(systemPrefersDark(null)).toBe(false);
  expect(systemPrefersDark(mediaWindow(true))).toBe(true);
});
