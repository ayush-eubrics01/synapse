import type { WorkerProfile } from "@synapse/contracts";

export type ToolClass = "read" | "write" | "builtin_read" | "builtin_write";

export const BUILTIN_WRITE = ["Bash", "Edit", "Write", "NotebookEdit"];
export const BUILTIN_READ = ["Read", "Grep", "Glob", "ToolSearch"];
/** Network-capable built-ins; classified as write. */
export const BUILTIN_NETWORK = ["WebFetch", "WebSearch", "Agent"];

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

const ATLASSIAN_READ_EXACT = new Set(["atlassianUserInfo", "fetch", "executeRead"]);
const ATLASSIAN_READ_PREFIXES = ["get", "search", "lookup"];

/** Known write-class tools per server, so they can be denied individually when the server is used. */
const KNOWN_WRITE_TOOLS: Record<string, string[]> = {
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

export function classifyTool(name: string): ToolClass {
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
  profile: WorkerProfile,
): string[] {
  const allowedSet = new Set(allowed);
  const deny = new Set<string>(BUILTIN_NETWORK);
  if (profile !== "engineering") for (const t of BUILTIN_WRITE) deny.add(t);
  const used = new Set<string>();
  for (const t of allowed) {
    const s = connectorServerOf(t);
    if (s) used.add(s);
  }
  for (const s of knownServers) if (!used.has(s)) deny.add(s);
  for (const s of used) {
    for (const t of KNOWN_WRITE_TOOLS[s] ?? []) deny.add(`${s}__${t}`);
  }
  return [...deny].filter((t) => !allowedSet.has(t)).sort();
}
