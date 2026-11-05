import type { FlagSeverity } from "@synapse/contracts";
import { type FlagRule, HIDDEN_CHAR_CLASS } from "./rules";

export interface Detection {
  ruleId: string;
  severity: FlagSeverity;
  excerpt: string;
}

const CONTEXT_CHARS = 60;
const DEFAULT_EXCERPT_MAX = 300;
/** Defence in depth against pathological input: only this prefix is scanned. */
export const MAX_SCAN_CHARS = 20_000;
const HIDDEN_CHARS = new RegExp(HIDDEN_CHAR_CLASS, "gu");

const compiled = new WeakMap<FlagRule, RegExp[]>();

function compile(rule: FlagRule): RegExp[] {
  let res = compiled.get(rule);
  if (!res) {
    const flags = rule.caseSensitive ? "u" : "iu";
    res = rule.patterns.map((p) => new RegExp(p, flags));
    compiled.set(rule, res);
  }
  return res;
}

/**
 * Renders text for storage: hidden characters become `\u{XXXX}`, then the result is capped at
 * `max` code points without cutting an escape in half.
 */
export function renderExcerpt(raw: string, max: number = DEFAULT_EXCERPT_MAX): string {
  let out = "";
  let used = 0;
  for (const ch of raw) {
    HIDDEN_CHARS.lastIndex = 0;
    const piece = HIDDEN_CHARS.test(ch)
      ? `\\u{${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`
      : ch;
    const len = [...piece].length;
    if (used + len > max) break;
    out += piece;
    used += len;
  }
  return out;
}

function unescapeSlack(t: string): string {
  return t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Pure rule matching. Throws on an invalid pattern; the caller decides how to degrade. */
export function scanText(
  fullText: string,
  rules: FlagRule[],
  opts: { excerptMaxChars?: number } = {},
): Detection[] {
  const max = opts.excerptMaxChars ?? DEFAULT_EXCERPT_MAX;
  const text = fullText.slice(0, MAX_SCAN_CHARS);
  // Slack escapes < > &, so "<invoke" arrives as "&lt;invoke": scan both forms.
  const unescaped = unescapeSlack(text);
  const variants = unescaped === text ? [text] : [text, unescaped];
  const out: Detection[] = [];
  for (const rule of rules) {
    const regexes = compile(rule);
    let found: Detection | null = null;
    for (const t of variants) {
      for (const re of regexes) {
        const m = re.exec(t);
        if (!m) continue;
        const start = Math.max(0, m.index - CONTEXT_CHARS);
        const raw = t.slice(start, m.index + m[0].length + CONTEXT_CHARS);
        found = { ruleId: rule.id, severity: rule.severity, excerpt: renderExcerpt(raw, max) };
        break;
      }
      if (found) break;
    }
    if (found) out.push(found);
  }
  // Addressing Claude is only conversational until it comes with an action verb.
  if (out.some((d) => d.ruleId === "action.command")) {
    for (const d of out) {
      if (d.ruleId === "address.claude" && d.severity === "info") d.severity = "warning";
    }
  }
  return out;
}
