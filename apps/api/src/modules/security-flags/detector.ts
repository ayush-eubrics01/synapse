import type { FlagSeverity } from "@synapse/contracts";
import { type FlagRule, HIDDEN_CHAR_CLASS } from "./rules";

export interface Detection {
  ruleId: string;
  severity: FlagSeverity;
  excerpt: string;
}

const CONTEXT_CHARS = 60;
const DEFAULT_EXCERPT_MAX = 300;
const HIDDEN_CHARS = new RegExp(HIDDEN_CHAR_CLASS, "g");

function visible(s: string): string {
  return s.replace(HIDDEN_CHARS, (c) => {
    const hex = (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    return `\\u{${hex}}`;
  });
}

function excerptAround(text: string, start: number, end: number, max: number): string {
  const raw = text.slice(Math.max(0, start - CONTEXT_CHARS), end + CONTEXT_CHARS);
  return visible(raw).slice(0, max);
}

/** Pure rule matching. Throws on an invalid pattern; the caller decides how to degrade. */
export function scanText(
  text: string,
  rules: FlagRule[],
  opts: { excerptMaxChars?: number } = {},
): Detection[] {
  const max = opts.excerptMaxChars ?? DEFAULT_EXCERPT_MAX;
  const out: Detection[] = [];
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      const m = new RegExp(pattern, "i").exec(text);
      if (!m) continue;
      out.push({
        ruleId: rule.id,
        severity: rule.severity,
        excerpt: excerptAround(text, m.index, m.index + m[0].length, max),
      });
      break;
    }
  }
  // Addressing Claude is only conversational until it comes with an action verb.
  if (out.some((d) => d.ruleId === "action.command")) {
    for (const d of out) {
      if (d.ruleId === "address.claude" && d.severity === "info") d.severity = "warning";
    }
  }
  return out;
}
