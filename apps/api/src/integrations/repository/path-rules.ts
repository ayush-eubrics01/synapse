import { realpathSync, statSync } from "node:fs";
import { isSafeAbsolutePath, type PathCheckResult } from "@synapse/contracts";
import { type GitOptions, runGit } from "./git";

/** Directories under $HOME that hold credentials or tool config: never registrable (C2). */
const FORBIDDEN_UNDER_HOME = [".claude", ".ssh", ".config"];

function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** $HOME as given and as its realpath (when it exists), so a symlinked home is covered too. */
function homeForms(home: string): string[] {
  const forms = new Set([trimSlash(home)]);
  try {
    forms.add(realpathSync(home));
  } catch {
    // A home that does not exist only needs its literal form.
  }
  return [...forms].filter((h) => h.startsWith("/"));
}

/**
 * C2 path rules for registering a repository. The checks run in this order, and the first
 * failure wins: absolute, exists, is a directory, not a forbidden location (`/`, `$HOME`, or
 * inside `~/.claude`, `~/.ssh` or `~/.config`, judged by realpath so symlinks cannot sneak in),
 * safe characters and segments (input and realpath), the top level of a git work tree
 * (`git rev-parse --show-toplevel` equals the realpath), not already registered, and not nested
 * inside or around a registered path. On success the realpath is what gets stored.
 */
export async function checkRegistrablePath(
  path: string,
  home: string,
  registeredPaths: readonly string[],
  git: Partial<GitOptions> = {},
): Promise<PathCheckResult> {
  if (typeof path !== "string" || !path.startsWith("/"))
    return { ok: false, reason: "not_absolute" };

  let isDir: boolean;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!isDir) return { ok: false, reason: "not_directory" };

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, reason: "not_found" };
  }

  if (real === "/") return { ok: false, reason: "forbidden_location" };
  for (const h of homeForms(home)) {
    if (real === h) return { ok: false, reason: "forbidden_location" };
    if (FORBIDDEN_UNDER_HOME.some((d) => within(real, `${h}/${d}`))) {
      return { ok: false, reason: "forbidden_location" };
    }
  }

  if (!isSafeAbsolutePath(path) || !isSafeAbsolutePath(real)) {
    return { ok: false, reason: "unsafe_chars" };
  }

  const top = await runGit(real, ["rev-parse", "--show-toplevel"], { home, ...git });
  if (top.code !== 0 || top.stdout.trim() !== real) return { ok: false, reason: "not_git_root" };

  const registered = registeredPaths.map(trimSlash);
  if (registered.includes(real)) return { ok: false, reason: "already_registered" };
  if (registered.some((r) => within(real, r) || within(r, real))) {
    return { ok: false, reason: "nested" };
  }
  return { ok: true, realpath: real };
}
