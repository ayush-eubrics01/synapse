import type { ConversationType, ScreeningRecord, UrgencyLevel } from "@synapse/contracts";
import type { KeywordRule } from "./rules";

export interface ScreenInput {
  text: string;
  conversationType: ConversationType;
  mentionsSelf: boolean;
  inThreadWithSelf: boolean;
  priority: "normal" | "high" | "critical";
  extraAttention: boolean;
}

export interface ScreenConfig {
  keywords: KeywordRule[];
  threshold: number;
}

export type ScreenResult = Omit<ScreeningRecord, "route" | "skipReason" | "assessed" | "version">;

const LEVEL_RANK: Record<UrgencyLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Keyword patterns are user-editable, so cap what a pattern can chew on. */
const MAX_SCAN_CHARS = 8_000;

function compile(rule: KeywordRule): RegExp | null {
  try {
    return new RegExp(rule.pattern, "i");
  } catch {
    return null;
  }
}

/** Ids of keyword rules whose pattern is not a valid regex; screening skips them. */
export function invalidKeywordIds(keywords: KeywordRule[]): string[] {
  return keywords.filter((k) => compile(k) === null).map((k) => k.id);
}

/** Pure rule screening, no AI. Invalid user-edited patterns are skipped, never thrown. */
export function screenMessage(input: ScreenInput, cfg: ScreenConfig): ScreenResult {
  const text = input.text.slice(0, MAX_SCAN_CHARS);
  const matched: KeywordRule[] = [];
  for (const rule of cfg.keywords) {
    const re = compile(rule);
    if (re?.test(text)) matched.push(rule);
  }

  let score = matched.reduce((sum, k) => sum + k.weight, 0);
  if (input.conversationType === "im") score += 1;
  else if (input.conversationType === "mpim") score += 0.5;
  if (input.mentionsSelf) score += 1;
  if (input.inThreadWithSelf) score += 1;
  const boosted = input.priority !== "normal" || input.extraAttention;
  if (input.priority !== "normal") score += 1;
  if (input.extraAttention) score += 1;

  const urgencySignals = matched.filter((k) => k.signal).map((k) => k.id);
  const threshold = boosted ? Math.max(1, cfg.threshold - 1) : cfg.threshold;
  const candidate = urgencySignals.length >= 1 && score >= threshold;

  let ruleLevel: UrgencyLevel = "low";
  for (const k of matched) if (LEVEL_RANK[k.level] > LEVEL_RANK[ruleLevel]) ruleLevel = k.level;

  return {
    candidate,
    score,
    ruleLevel,
    matchedRules: matched.map((k) => k.id),
    urgencySignals,
  };
}
