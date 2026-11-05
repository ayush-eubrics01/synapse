import type { FlagSeverity } from "@synapse/contracts";

export interface FlagRule {
  id: string;
  severity: FlagSeverity;
  /** Regex sources, matched case-insensitively. */
  patterns: string[];
}

/** Source of the hidden-character class; shared with the detector's excerpt rendering. */
export const HIDDEN_CHAR_CLASS = "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]";

export const STARTER_RULES: FlagRule[] = [
  {
    id: "override.ignore_instructions",
    severity: "high",
    patterns: [
      "ignore (all|any|previous|prior|your) (instructions|rules)",
      "disregard (the|all) (above|previous)",
      "forget (your|all) (rules|instructions)",
    ],
  },
  {
    id: "override.role",
    severity: "high",
    patterns: ["\\byou are now\\b", "\\bact as\\b", "system prompt", "developer mode"],
  },
  {
    id: "tools.named",
    severity: "high",
    patterns: [
      "mcp__",
      "slack_send_message",
      "\\b(Bash|Edit|Write|NotebookEdit)\\(",
      "<invoke",
      "<function",
    ],
  },
  {
    id: "exfil.secrets",
    severity: "high",
    patterns: [
      "(send|share|give|show|paste|reveal)\\b.{0,40}(\\.env\\b|\\b(tokens?|api keys?|secret keys?|passwords?|credentials))",
    ],
  },
  { id: "hidden.unicode", severity: "high", patterns: [HIDDEN_CHAR_CLASS] },
  {
    id: "hidden.blob",
    severity: "warning",
    patterns: ["[A-Za-z0-9+/=]{200,}", "\\b[0-9a-f]{120,}\\b", "<!--[\\s\\S]*?\\S[\\s\\S]*?-->"],
  },
  {
    id: "action.command",
    severity: "warning",
    patterns: [
      "\\b(claude|ai|bot|assistant)\\b.{0,60}\\b(run (this|the) command|git push|delete|merge this|deploy)\\b",
    ],
  },
  {
    id: "address.claude",
    severity: "info",
    patterns: ["^\\s*(hey |hi )?(claude|ai)\\b[,:]", "\\bhey (claude|ai)\\b"],
  },
];
