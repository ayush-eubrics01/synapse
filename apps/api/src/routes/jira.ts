import { zValidator } from "@hono/zod-validator";
import { jiraIssueViewKindSchema } from "@synapse/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import { JiraDisabled } from "../modules/jira-tracking/service";

const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

/** Spec B11. Errors are fixed strings: Jira text never reaches a response or a log. */
const settingsBody = z
  .object({
    enabled: z.boolean(),
    scopeJql: z
      .string()
      .min(1)
      .max(500)
      .refine((v) => !/[\r\n]/.test(v), "no newlines")
      // The code wraps the scope in parentheses and appends its own ordering.
      .refine((v) => !/\border\s+by\b/i.test(v), "no ORDER BY"),
    excludedProjects: z.array(z.string().regex(PROJECT_KEY)),
  })
  .partial()
  .strict();

export function jiraRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/jira/status", (ctx) => ctx.json(c.jira.status()));
  app.get(
    "/api/jira/issues",
    zValidator("query", z.object({ view: jiraIssueViewKindSchema.default("all") })),
    (ctx) => ctx.json(c.jira.list(ctx.req.valid("query").view)),
  );
  app.get("/api/jira/issues/:key", (ctx) => {
    const issue = c.jira.get(ctx.req.param("key"));
    return issue ? ctx.json(issue) : ctx.json({ error: "issue not found" }, 404);
  });
  app.post("/api/jira/sync", (ctx) => {
    try {
      return ctx.json(c.jira.requestSync());
    } catch (e) {
      if (e instanceof JiraDisabled) return ctx.json({ error: "jira is disabled" }, 409);
      throw e;
    }
  });
  app.put("/api/jira/settings", zValidator("json", settingsBody), (ctx) =>
    ctx.json(c.jira.updateSettings(ctx.req.valid("json"))),
  );
  return app;
}
