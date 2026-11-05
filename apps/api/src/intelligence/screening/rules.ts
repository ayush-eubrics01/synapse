import type { UrgencyLevel } from "@synapse/contracts";

export interface KeywordRule {
  id: string;
  pattern: string;
  weight: number;
  level: UrgencyLevel;
  signal: boolean;
}

/** Default `urgency.rules.keywords`; patterns are case-insensitive regex sources. */
export const DEFAULT_KEYWORDS: KeywordRule[] = [
  {
    id: "incident",
    pattern:
      "\\b(prod(uction)?|live|site|api|app)\\b.{0,30}\\b(down|outage|broken|failing|500s?|incident)\\b|\\b(outage|incident|sev ?[12]|p0|p1)\\b",
    weight: 3,
    level: "critical",
    signal: true,
  },
  {
    id: "blocker",
    pattern: "\\b(blocker|blocked|blocking)\\b",
    weight: 2,
    level: "high",
    signal: true,
  },
  {
    id: "urgent",
    pattern: "\\b(urgent|asap|immediately|right now|emergency)\\b",
    weight: 2,
    level: "high",
    signal: true,
  },
  {
    id: "deadline",
    pattern:
      "\\b(deadline|due (today|tonight|in \\d+ ?(h|hours?|mins?))|by (eod|end of day|today|tonight))\\b",
    weight: 2,
    level: "high",
    signal: true,
  },
  {
    id: "today",
    pattern: "\\b(today|tonight|this morning|this afternoon)\\b",
    weight: 1,
    level: "medium",
    signal: true,
  },
  { id: "question", pattern: "\\?\\s*$", weight: 0, level: "low", signal: false },
];
