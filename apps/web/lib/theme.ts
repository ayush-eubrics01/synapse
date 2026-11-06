export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "synapse.theme";

function isTheme(v: unknown): v is Theme {
  return v === "dark" || v === "light";
}

/** The stored choice wins; with none (or unreadable storage) the theme follows the system. */
export function readTheme(storage: Pick<Storage, "getItem"> | null, prefersDark: boolean): Theme {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // storage blocked (private mode, sandbox): fall back to the system preference
  }
  return prefersDark ? "dark" : "light";
}

/**
 * The system preference, with one rule shared with THEME_BOOT_SCRIPT: matchMedia missing or
 * throwing means light.
 */
export function systemPrefersDark(
  win: { matchMedia?: (query: string) => { matches: boolean } } | null,
): boolean {
  try {
    return !!win?.matchMedia?.("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** Best effort: a blocked storage only means the choice is not remembered. */
export function writeTheme(storage: Pick<Storage, "setItem"> | null, t: Theme): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, t);
  } catch {
    // not remembered; the theme still applies for this page
  }
}

/**
 * Runs in <head> before first paint, so the page never flashes the wrong theme (spec D3).
 * Same rules as readTheme and systemPrefersDark, written as plain ES5 because it runs before any
 * bundle.
 */
export const THEME_BOOT_SCRIPT = `(function(){var t=null;try{t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}if(t!=="dark"&&t!=="light"){var m=false;try{m=!!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)}catch(e){}t=m?"dark":"light"}document.documentElement.setAttribute("data-theme",t)})()`;
