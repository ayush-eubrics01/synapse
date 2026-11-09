import { userInfo } from "node:os";
import { dirname, isAbsolute } from "node:path";

/** How many include levels `configFingerprint` follows below a config file (git's MAX_INCLUDE_DEPTH; the file itself is 0). */
export const INCLUDE_DEPTH_MAX = 10;

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", b: "\b", '"': '"', "\\": "\\" };

/**
 * Parses a git config value (quotes, escapes, `;`/`#` comments); the rest of the line only.
 * A continuation (a backslash-newline kept in the logical line, or a backslash ending the
 * text) keeps the whitespace before it, as git does.
 */
function parseValue(raw: string): string {
  let out = "";
  let quoted = false;
  let end = 0; // length of `out` that trailing-whitespace trimming must keep
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c === "\\") {
      const n = raw[i + 1];
      if (n === undefined || n === "\n") {
        end = out.length;
        i++;
        continue;
      }
      if (n in ESCAPES) {
        out += ESCAPES[n];
        end = out.length;
        i++;
      }
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      end = out.length;
      continue;
    }
    if (!quoted && (c === ";" || c === "#")) break;
    out += c;
    if (quoted || (c !== " " && c !== "\t")) end = out.length;
  }
  return out.slice(0, end);
}

/** Prefix of a target the fingerprint cannot resolve without the filesystem (`~name/...`); it is hashed as is. */
export const UNRESOLVED_PREFIX = "unresolved:";

function currentUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

/** Index of the `]` closing the header that starts at `rest[0] === "["`, skipping quoted subsections. */
function headerEnd(rest: string): number {
  let quoted = false;
  for (let i = 1; i < rest.length; i++) {
    const c = rest[i];
    if (quoted && c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (c === "]" && !quoted) return i;
  }
  return -1;
}

/**
 * Splits config text into logical lines like git: a backslash-newline continues a line only
 * inside a value and outside a comment (a `#` or `;` comment ends at the newline, whatever
 * it ends with). Header, key and value contexts are tracked so `=` and `;` inside a quoted
 * subsection or value are not misread.
 */
function logicalLines(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n");
  const lines: string[] = [];
  let cur = "";
  let ctx: "start" | "header" | "key" | "value" | "comment" = "start";
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "\n") {
      lines.push(cur);
      cur = "";
      ctx = "start";
      quote = false;
      continue;
    }
    if (ctx === "value" && c === "\\") {
      const n = text[i + 1];
      if (n === "\n") {
        // Kept for parseValue: whitespace before a continuation is part of the value.
        cur += "\\\n";
        i++;
        continue;
      }
      cur += c;
      if (n !== undefined) {
        cur += n;
        i++;
      }
      continue;
    }
    cur += c;
    if (ctx === "comment") continue;
    if (ctx === "header") {
      if (quote && c === "\\") {
        const n = text[i + 1];
        if (n !== undefined && n !== "\n") {
          cur += n;
          i++;
        }
      } else if (c === '"') quote = !quote;
      else if (c === "]" && !quote) ctx = "start";
    } else if (ctx === "value") {
      if (c === '"') quote = !quote;
      else if (!quote && (c === "#" || c === ";")) ctx = "comment";
    } else if (c === "#" || c === ";") ctx = "comment";
    else if (c === "[" && ctx === "start") ctx = "header";
    else if (c === "=" && ctx === "key") ctx = "value";
    else if (ctx === "start" && c !== " " && c !== "\t") ctx = "key";
  }
  lines.push(cur);
  return lines;
}

/**
 * The `path` values of `[include]` and `[includeIf "..."]` sections in git config `text`
 * (read from `file`), in file order, duplicates kept. A relative path is `dirname(file)/path`
 * with no normalisation (the kernel resolves it when opened, as git does, so `l1/../x` through
 * a symlinked directory points where git's does); `~/` and `~<current user>/` are `home`; any
 * other `~name/` is returned as `unresolved:<raw value>` (fail closed). `includeIf` conditions
 * are not evaluated (every target counts). Pure: never touches the filesystem.
 */
export function includeTargets(text: string, file: string, home: string): string[] {
  const out: string[] = [];
  let inInclude = false;
  for (const line of logicalLines(text)) {
    let rest = line.trimStart();
    if (rest.startsWith("[")) {
      const close = headerEnd(rest);
      if (close < 0) continue;
      const name = (/^[^\s".\]]*/.exec(rest.slice(1))?.[0] ?? "").toLowerCase();
      inInclude = name === "include" || name === "includeif";
      rest = rest.slice(close + 1).trimStart();
    }
    if (!inInclude) continue;
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*(=([\s\S]*))?$/.exec(rest);
    if (!m || (m[1] as string).toLowerCase() !== "path" || m[2] === undefined) continue;
    const value = parseValue((m[3] ?? "").trimStart());
    if (value === "") continue;
    if (value === "~" || value.startsWith("~/")) out.push(home + value.slice(1));
    else if (value.startsWith("~")) {
      const um = /^~([^/]+)(\/.*)?$/.exec(value);
      if (um && um[1] === currentUser()) out.push(home + (um[2] ?? ""));
      else out.push(UNRESOLVED_PREFIX + value);
    } else out.push(isAbsolute(value) ? value : `${dirname(file)}/${value}`);
  }
  return out;
}
