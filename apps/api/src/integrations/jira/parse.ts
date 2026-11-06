import { type SourceIssue, sourceIssueSchema } from "@synapse/contracts";
import { z } from "zod";

/** Connector output no longer matches the known shape (drift). The message is fixed: no content. */
export class JiraParseError extends Error {
  constructor() {
    super("unexpected jira connector result shape");
    this.name = "JiraParseError";
  }
}

/** Accepts the bare JSON string or MCP text blocks `[{type:"text",text}]` carrying it. */
function decode(content: string): unknown {
  try {
    let v: unknown = JSON.parse(content);
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text")
    ) {
      v = JSON.parse(v.map((b) => String((b as { text?: unknown }).text ?? "")).join(""));
    }
    return v;
  } catch {
    throw new JiraParseError();
  }
}

const nodeSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  webUrl: z.string().min(1),
  fields: z.object({
    summary: z.string(),
    status: z.object({
      name: z.string(),
      statusCategory: z.object({ key: z.enum(["new", "indeterminate", "done"]) }),
    }),
    priority: z.object({ name: z.string() }).nullish(),
    issuetype: z.object({ name: z.string() }),
    project: z.object({ key: z.string().min(1) }),
    labels: z.array(z.string()).nullish(),
    duedate: z.string().nullish(),
    created: z.string(),
    updated: z.string(),
  }),
});

const searchSchema = z.object({
  issues: z.object({
    totalCount: z.number().int().nonnegative().optional(),
    nodes: z.array(nodeSchema),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  }),
});

const resourcesSchema = z.array(
  z.object({ id: z.string().min(1), url: z.string(), name: z.string() }),
);

function toUtcIso(s: string): string {
  // "+0530" lacks a colon, which not every engine accepts.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) throw new JiraParseError(); // never fall back to local time
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = new Date(fixed).getTime();
  if (Number.isNaN(t)) throw new JiraParseError();
  return new Date(t).toISOString();
}

export function parseSearchResult(content: string): {
  issues: SourceIssue[];
  nextPageToken: string | null;
  total: number | null;
} {
  const r = searchSchema.safeParse(decode(content));
  if (!r.success) throw new JiraParseError();
  const { nodes, pageInfo, totalCount } = r.data.issues;
  const issues = nodes.map((n) => {
    const r = sourceIssueSchema.safeParse({
      key: n.key,
      jiraId: n.id,
      projectKey: n.fields.project.key,
      summary: n.fields.summary,
      statusName: n.fields.status.name,
      statusCategory: n.fields.status.statusCategory.key,
      priority: n.fields.priority?.name ?? null,
      issueType: n.fields.issuetype.name,
      labels: n.fields.labels ?? [],
      dueDate: n.fields.duedate ?? null,
      createdAt: toUtcIso(n.fields.created),
      updatedAt: toUtcIso(n.fields.updated),
      // Only an https link may reach the UI as an href.
      webUrl: n.webUrl.startsWith("https://") ? n.webUrl : null,
    });
    // A ZodError message can echo Jira content; throw the fixed-message error instead.
    if (!r.success) throw new JiraParseError();
    return r.data;
  });
  const nextPageToken = pageInfo.hasNextPage ? (pageInfo.endCursor ?? null) : null;
  if (pageInfo.hasNextPage && !nextPageToken) throw new JiraParseError();
  return { issues, nextPageToken, total: totalCount ?? null };
}

export function parseResources(content: string): { id: string; url: string; name: string }[] {
  const r = resourcesSchema.safeParse(decode(content));
  if (!r.success) throw new JiraParseError();
  return r.data;
}
