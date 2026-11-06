import { z } from "zod";
import { jiraAttentionSchema } from "./jira";

/** C2: embedded in tool permission specifiers, so no spaces, commas, parentheses or quotes. */
export const REPO_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

/**
 * True for an absolute path that is safe to embed in a `Tool(<path>/**)` specifier: safe
 * characters only, no empty, `.` or `..` segment (so no `//` or `/tmp/a/../..`), and at least two
 * segments (so neither `/` nor a top-level directory like `/tmp` can become a scope). One trailing
 * slash is tolerated.
 */
export function isSafeAbsolutePath(p: string): boolean {
  if (!REPO_PATH_RE.test(p)) return false;
  const body = p.endsWith("/") ? p.slice(0, -1) : p;
  if (body === "") return false;
  const segs = body.slice(1).split("/");
  if (segs.length < 2) return false;
  return segs.every((x) => x !== "" && x !== "." && x !== "..");
}

const safePathSchema = z.string().refine(isSafeAbsolutePath, "unsafe path");

export const factKindSchema = z.enum([
  "purpose",
  "stack",
  "module",
  "entrypoint",
  "convention",
  "risk",
  "note",
]);
export type FactKind = z.infer<typeof factKindSchema>;

export const factStatusSchema = z.enum(["needs_review", "approved", "rejected", "outdated"]);
export type FactStatus = z.infer<typeof factStatusSchema>;

export const factSourceSchema = z.enum(["inspection", "user"]);
export type FactSource = z.infer<typeof factSourceSchema>;

export const milestoneStatusSchema = z.enum(["planned", "done", "slipped", "cancelled"]);
export type MilestoneStatus = z.infer<typeof milestoneStatusSchema>;

const jiraKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]+$/);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const evidenceSchema = z.object({
  path: z.string().min(1).max(500),
  line: z.number().int().positive().optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const environmentInputSchema = z.object({
  name: z.string().min(1).max(60),
  branch: z.string().min(1).max(200),
  protected: z.boolean(),
  autoDeploysOnMerge: z.boolean(),
  notes: z.string().max(500).optional(),
});
export type EnvironmentInput = z.infer<typeof environmentInputSchema>;

export const environmentViewSchema = environmentInputSchema.extend({ id: z.string() });
export type EnvironmentView = z.infer<typeof environmentViewSchema>;

export const repositoryDriftSchema = z.object({
  detectedAt: z.string(),
  reasons: z.array(z.string()),
});
export type RepositoryDrift = z.infer<typeof repositoryDriftSchema>;

/** `POST /api/repos`: re-inspected and saved in one transaction. */
export const repositoryRegisterInputSchema = z.object({
  path: safePathSchema,
  name: z.string().min(1).max(80),
  trackedBranch: z.string().min(1).max(200),
  environments: z.array(environmentInputSchema).max(10).default([]),
  jiraProjectKeys: z.array(jiraKeySchema).max(20).default([]),
  notes: z.string().max(1000).optional(),
});
export type RepositoryRegisterInput = z.infer<typeof repositoryRegisterInputSchema>;

/** `POST /api/repos/inspect`: saves nothing. */
export const repositoryProposalSchema = z.object({
  path: z.string(),
  suggestedName: z.string(),
  currentBranch: z.string().nullable(),
  suggestedTrackedBranch: z.string().nullable(),
  headSha: z.string().nullable(),
  remotes: z.object({
    origin: z.object({ fetch: z.string(), push: z.string() }).optional(),
    upstream: z.object({ fetch: z.string(), push: z.string() }).optional(),
  }),
  upstreamPushDisabled: z.boolean(),
  branches: z.array(z.string()),
  environmentCandidates: z.array(z.object({ name: z.string(), branch: z.string() })),
});
export type RepositoryProposal = z.infer<typeof repositoryProposalSchema>;

export const repositoryViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  localPath: z.string(),
  originUrl: z.string().nullable(),
  upstreamUrl: z.string().nullable(),
  upstreamPushDisabled: z.boolean(),
  trackedBranch: z.string(),
  jiraProjectKeys: z.array(z.string()),
  notes: z.string().nullable(),
  headSha: z.string().nullable(),
  inspectedHeadSha: z.string().nullable(),
  drift: repositoryDriftSchema.nullable(),
  environments: z.array(environmentViewSchema),
  projectId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RepositoryView = z.infer<typeof repositoryViewSchema>;

export const projectFactViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: factKindSchema,
  content: z.string(),
  evidence: z.array(evidenceSchema),
  status: factStatusSchema,
  source: factSourceSchema,
  claudeRunId: z.string().nullable(),
  supersedesId: z.string().nullable(),
  headSha: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type ProjectFactView = z.infer<typeof projectFactViewSchema>;

export const milestoneInputSchema = z.object({
  name: z.string().min(1).max(120),
  targetDate: isoDateSchema,
  environmentId: z.string().nullable().optional(),
  status: milestoneStatusSchema.default("planned"),
  notes: z.string().max(1000).optional(),
});
export type MilestoneInput = z.infer<typeof milestoneInputSchema>;

export const milestoneViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  targetDate: z.string(),
  environmentId: z.string().nullable(),
  environmentName: z.string().nullable(),
  status: milestoneStatusSchema,
  notes: z.string().nullable(),
  overdue: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MilestoneView = z.infer<typeof milestoneViewSchema>;

export const projectViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string().nullable(),
  repositoryIds: z.array(z.string()),
  factsNeedingReview: z.number().int(),
  nextMilestone: milestoneViewSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectView = z.infer<typeof projectViewSchema>;

export const projectDetailSchema = projectViewSchema.extend({
  repositories: z.array(repositoryViewSchema),
  facts: z.array(projectFactViewSchema),
  milestones: z.array(milestoneViewSchema),
  jira: z.object({
    byAttention: z.record(jiraAttentionSchema, z.number().int()),
    top: z.array(
      z.object({ key: z.string(), summary: z.string(), attention: jiraAttentionSchema }),
    ),
  }),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

/** C6 limits. */
export const INSPECTION_MAX_FACTS = 40;
export const INSPECTION_MAX_UNKNOWNS = 10;
export const INSPECTION_MAX_CONTENT = 400;

/** The structured output of `brain.inspect_repository`. Code verifies the evidence afterwards. */
export const inspectionOutputSchema = z.object({
  facts: z
    .array(
      z.object({
        kind: factKindSchema,
        content: z.string().min(1).max(INSPECTION_MAX_CONTENT),
        evidence: z.array(evidenceSchema).min(1).max(5),
      }),
    )
    .max(INSPECTION_MAX_FACTS),
  unknowns: z.array(z.string().max(400)).max(INSPECTION_MAX_UNKNOWNS),
});
export type InspectionOutput = z.infer<typeof inspectionOutputSchema>;

/** `POST /api/repos/inspect` body. */
export const repositoryInspectInputSchema = z.object({ path: safePathSchema });
export type RepositoryInspectInput = z.infer<typeof repositoryInspectInputSchema>;
