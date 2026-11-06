import type { WorkerProfile } from "@synapse/contracts";

export type ToolClass = "read" | "write" | "builtin_read" | "builtin_write";

export const BUILTIN_WRITE = ["Bash", "Edit", "Write", "NotebookEdit", "MultiEdit", "Monitor"];
export const BUILTIN_READ = ["Read", "Grep", "Glob", "ToolSearch"];
/**
 * Filesystem readers: engineering and reader only, path-scoped by validator rule L (R33/I4, C1).
 * Collector and intelligence runs may not allow them, and every run denies the ones it does not
 * allow. They are the only built-ins a reader run may allow.
 */
export const BUILTIN_FS_READ = ["Read", "Grep", "Glob"];
/** Network-capable built-ins; classified as write. */
export const BUILTIN_NETWORK = ["WebFetch", "WebSearch", "Agent", "Task"];

/** A connector server name: `mcp__` plus a non-empty server part with at least one alnum (R31). */
export const SERVER_NAME_RE = /^mcp__[A-Za-z0-9_]*[A-Za-z0-9][A-Za-z0-9_]*$/;

export const DEFAULT_KNOWN_SERVERS = [
  "mcp__claude_ai_Slack",
  "mcp__claude_ai_Atlassian",
  "mcp__claude_ai_Atlassian_MCP",
  "mcp__claude_ai_Gmail",
  "mcp__claude_ai_Google_Drive",
  "mcp__claude_ai_Google_Calendar",
  "mcp__claude_ai_Google_Docs",
  "mcp__claude_ai_Google_Sheets",
  "mcp__claude_ai_Claude_Docs",
  "mcp__claude_ai_Canva",
  "mcp__claude_ai_Notion",
  "mcp__claude_ai_Linear",
  "mcp__claude_ai_HubSpot",
  "mcp__claude_ai_Figma",
  "mcp__claude_ai_Asana",
  "mcp__claude_ai_Box",
  "mcp__claude_ai_Apollo_io",
  "mcp__claude_ai_Clay",
  "mcp__claude_ai_Exa",
  "mcp__claude_ai_Fathom_Your_Meeting_Intelligence_Layer",
  "mcp__claude_ai_Intercom",
  "mcp__claude_ai_Mixpanel",
  "mcp__claude_ai_Semrush",
  "mcp__claude_ai_Wispr_Flow",
  "mcp__claude_ai_Zoho_Desk",
  "mcp__claude_ai_bigin_zohomcp_com",
  "mcp__claude_ai_monday_com",
  "mcp__claude_ai_n8n",
  "mcp__rea",
  "mcp__plugin_postman_postman",
  "mcp__workspace",
];

const SLACK_PREFIX = "mcp__claude_ai_Slack__";
const ATLASSIAN_PREFIXES = ["mcp__claude_ai_Atlassian__", "mcp__claude_ai_Atlassian_MCP__"];

const SLACK_READ = new Set([
  "slack_search_public",
  "slack_search_public_and_private",
  "slack_read_channel",
  "slack_read_thread",
  "slack_read_canvas",
  "slack_read_file",
  "slack_read_list",
  "slack_read_user_profile",
  "slack_search_users",
  "slack_search_channels",
  "slack_search_emojis",
  "slack_list_user_channels",
  "slack_list_channel_members",
  "slack_get_reactions",
]);

const ATLASSIAN_READ_EXACT = new Set([
  "atlassianUserInfo",
  "fetch",
  "executeRead",
  "listJiraIssueComments",
]);
const ATLASSIAN_READ_PREFIXES = ["get", "search", "lookup"];

/** Known write-class tools per server, so they can be denied individually when the server is used. */
export const KNOWN_WRITE_TOOLS: Record<string, string[]> = {
  mcp__claude_ai_Slack: [
    "slack_add_list_record",
    "slack_add_reaction",
    "slack_complete_file_upload",
    "slack_create_canvas",
    "slack_create_conversation",
    "slack_create_list",
    "slack_get_file_upload_url",
    "slack_schedule_message",
    "slack_send_message",
    "slack_send_message_draft",
    "slack_update_canvas",
    "slack_update_list",
    "slack_update_list_record",
  ],
  mcp__claude_ai_Atlassian: [
    "addCommentToJiraIssue",
    "addTeamworkGraphContext",
    "addWorklogToJiraIssue",
    "createCompassComponent",
    "createCompassComponentRelationship",
    "createCompassCustomFieldDefinition",
    "createConfluenceFooterComment",
    "createConfluenceInlineComment",
    "createConfluencePage",
    "createIssueLink",
    "createJiraIssue",
    "editJiraIssue",
    "transitionJiraIssue",
    "updateConfluencePage",
  ],
  mcp__claude_ai_Atlassian_MCP: [
    "addGraphContext",
    "addOrEditJiraIssueComment",
    "createConfluenceContent",
    "createJiraIssue",
    "editJiraIssue",
    "executeDestructive",
    "executeWrite",
    "transitionJiraIssue",
    "updateConfluenceContent",
  ],
};

/** Strip a permission specifier, e.g. `Bash(curl:*)` -> `Bash`. */
export function normalizeTool(name: string): string {
  const i = name.indexOf("(");
  return (i === -1 ? name : name.slice(0, i)).trim();
}

export function classifyTool(rawName: string): ToolClass {
  const name = normalizeTool(rawName);
  if (BUILTIN_WRITE.includes(name)) return "builtin_write";
  if (BUILTIN_READ.includes(name)) return "builtin_read";
  if (name.startsWith(SLACK_PREFIX)) {
    return SLACK_READ.has(name.slice(SLACK_PREFIX.length)) ? "read" : "write";
  }
  for (const p of ATLASSIAN_PREFIXES) {
    if (name.startsWith(p)) {
      const part = name.slice(p.length);
      if (ATLASSIAN_READ_EXACT.has(part)) return "read";
      if (ATLASSIAN_READ_PREFIXES.some((x) => part.startsWith(x))) return "read";
      return "write";
    }
  }
  return "write";
}

export function connectorServerOf(tool: string): string | null {
  if (!tool.startsWith("mcp__")) return null;
  const rest = tool.slice("mcp__".length);
  const i = rest.indexOf("__");
  if (i <= 0 || i + 2 >= rest.length) return null;
  return `mcp__${rest.slice(0, i)}`;
}

export function buildDenylist(
  allowed: string[],
  knownServers: string[],
  /** Kept for callers; every profile now denies the write and fs-read built-ins it does not allow. */
  _profile: WorkerProfile,
): string[] {
  const allowedSet = new Set(allowed.map(normalizeTool));
  const deny = new Set<string>(BUILTIN_NETWORK);
  // Engineering runs keep the write and fs-read built-ins they allow (filtered out below) and
  // deny the rest, so a user-level `permissions.allow` cannot widen a read-only inspection run.
  // Reader runs (C1) keep only their scoped Read/Grep/Glob, so Bash and every write built-in are
  // always denied. Collector and intelligence runs may not allow either, so they deny all of them.
  for (const t of BUILTIN_WRITE) deny.add(t);
  for (const t of BUILTIN_FS_READ) deny.add(t);
  const used = new Set<string>();
  for (const t of allowed.map(normalizeTool)) {
    const s = connectorServerOf(t);
    if (s) used.add(s);
  }
  for (const s of knownServers) if (!used.has(s)) deny.add(s);
  for (const s of used) {
    for (const t of KNOWN_WRITE_TOOLS[s] ?? []) deny.add(`${s}__${t}`);
  }
  // Network tools are always denied (no profile may allow them); everything else never overlaps allowed.
  return [...deny].filter((t) => BUILTIN_NETWORK.includes(t) || !allowedSet.has(t)).sort();
}
