import { dirname, isAbsolute, join, resolve } from "node:path";

/** How many include levels `configFingerprint` follows below a config file (the file itself is 0). */
export const INCLUDE_DEPTH_MAX = 5;

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", b: "\b", '"': '"', "\\": "\\" };

/** Parses a git config value (quotes, escapes, `;`/`#` comments); the rest of the line only. */
function parseValue(raw: string): string {
  let out = "";
  let quoted = false;
  let end = 0; // length of `out` that trailing-whitespace trimming must keep
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c === "\\") {
      const n = raw[i + 1];
      if (n !== undefined && n in ESCAPES) {
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

/**
 * The `path` values of `[include]` and `[includeIf "..."]` sections in git config `text`
 * (read from `file`), as absolute paths in file order, duplicates kept. A relative path is
 * relative to `file`'s directory; `~/` is `home`. `includeIf` conditions are not evaluated
 * (every target counts). Pure: never touches the filesystem.
 */
export function includeTargets(text: string, file: string, home: string): string[] {
  const out: string[] = [];
  let inInclude = false;
  for (const line of text.split(/\r?\n/)) {
    let rest = line.trimStart();
    if (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      if (close < 0) continue;
      const name = (/^[^\s"\]]*/.exec(rest.slice(1))?.[0] ?? "").toLowerCase();
      inInclude = name === "include" || name === "includeif";
      rest = rest.slice(close + 1).trimStart();
    }
    if (!inInclude) continue;
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*(=([\s\S]*))?$/.exec(rest);
    if (!m || (m[1] as string).toLowerCase() !== "path" || m[2] === undefined) continue;
    const value = parseValue((m[3] ?? "").trimStart());
    if (value === "") continue;
    if (value === "~" || value.startsWith("~/")) out.push(resolve(join(home, value.slice(1))));
    else out.push(isAbsolute(value) ? resolve(value) : resolve(dirname(file), value));
  }
  return out;
}
