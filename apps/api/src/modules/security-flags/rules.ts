import type { FlagSeverity } from "@synapse/contracts";

export interface FlagRule {
  id: string;
  severity: FlagSeverity;
  /** Regex sources (unicode mode), matched case-insensitively unless `caseSensitive`. */
  patterns: string[];
  caseSensitive?: boolean;
}

/**
 * Source of the hidden-character class (unicode mode); shared with excerpt rendering. Covers
 * soft hyphen, zero-width and bidi controls, word joiner, invisible operators, BOM, tag characters.
 */
export const HIDDEN_CHAR_CLASS =
  "[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u{E0000}-\\u{E007F}]";

export const STARTER_RULES: FlagRule[] = [
  {
    id: "override.ignore_instructions",
    severity: "high",
    patterns: [
      "ignore (all|any|previous|prior|your) (instructions|rules)",
      "disregard (all |the )?(above|previous|prior) (instructions|rules|prompts?)",
      "forget (your|all) (rules|instructions)",
    ],
  },
  {
    id: "override.role",
    severity: "high",
    patterns: [
      "\\byou are now\\b",
      "\\bact as (an? )?(ai|assistant|llm|chatbot|claude|gpt|different (ai|assistant|model))\\b",
      "\\b(reveal|show|print|ignore|override|change|repeat) (me )?(your |the )?system prompt\\b",
      "\\bdeveloper mode\\b",
    ],
  },
  {
    id: "tools.named",
    severity: "high",
    caseSensitive: true,
    patterns: [
      "mcp__",
      "slack_send_message",
      "(?<![\\w.])(Bash|Edit|Write|NotebookEdit)\\(",
      "<invoke",
      "<function",
    ],
  },
  {
    id: "exfil.secrets",
    severity: "high",
    patterns: [
      "\\b(send|share|give|show|paste|reveal|print|cat)\\b.{0,40}(\\.env(?![\\w.])|\\b(private keys?|secret keys?|ssh keys?|credentials\\.json))",
    ],
  },
  {
    id: "exfil.secrets_generic",
    severity: "warning",
    patterns: [
      "\\b(send|share|give|show|paste|reveal)\\b.{0,40}\\b(tokens?|api keys?|passwords?|credentials)\\b",
    ],
  },
  { id: "hidden.unicode", severity: "high", patterns: [HIDDEN_CHAR_CLASS] },
  {
    id: "hidden.blob",
    severity: "warning",
    // The comment pattern must stay linear: no nested lazy quantifiers.
    patterns: ["[A-Za-z0-9+/=]{200,}", "\\b[0-9a-f]{120,}\\b", "<!--\\s*(?!-->)\\S"],
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
