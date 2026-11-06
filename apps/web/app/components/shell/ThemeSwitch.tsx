"use client";

import { useEffect, useState } from "react";
import { readTheme, type Theme, writeTheme } from "../../../lib/theme";
import { Segmented } from "../ui/Segmented";

const OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
] as const;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function prefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true;
  }
}

/**
 * Dark/Light switch (spec D3). The boot script already set data-theme before paint; on mount this
 * reads the same rules and re-applies them (React's dev remount can reset <html> attributes).
 */
export function ThemeSwitch() {
  // Server render shows the CSS default (dark) until mounted.
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    const t = readTheme(storage(), prefersDark());
    document.documentElement.dataset.theme = t;
    setTheme(t);
  }, []);
  const choose = (t: Theme) => {
    writeTheme(storage(), t);
    document.documentElement.dataset.theme = t;
    setTheme(t);
  };
  return <Segmented ariaLabel="Theme" options={OPTIONS} value={theme} onChange={choose} />;
}
