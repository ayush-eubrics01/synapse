import { zValidator } from "@hono/zod-validator";
import {
  approveDescriptionInputSchema,
  engineeringTaskCreateInputSchema,
  engineeringTaskStatusSchema,
} from "@synapse/contracts";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Container } from "../container";
import {
  EngineeringTaskError,
  type EngineeringTaskErrorCode,
} from "../modules/engineering-tasks/store";

/**
 * Spec E19. Errors are fixed codes: task text, branch names and paths never reach a response.
 * 404 unknown ids; 409 a state that moved under the call (the repository path went away);
 * everything else is a refusal of the request itself (400). `repository_required` is reported to
 * clients as `ambiguous_repository`.
 */
const STATUS: Record<
  Exclude<EngineeringTaskErrorCode, `registry_error:${string}`>,
  ContentfulStatusCode
> = {
  not_found: 404,
  path_unavailable: 409,
  invalid_input: 400,
  invalid_state: 400,
  repository_required: 400,
  no_content: 400,
  unknown_branch: 400,
  unknown_environment: 400,
  protected_branch: 400,
  unsafe_test_command: 400,
};

export function engineeringErrorResponse(e: EngineeringTaskError): {
  error: string;
  status: ContentfulStatusCode;
} {
  const error = e.code === "repository_required" ? "ambiguous_repository" : e.code;
  if (e.code.startsWith("registry_error:")) return { error, status: 400 };
  return { error, status: STATUS[e.code as keyof typeof STATUS] ?? 400 };
}

const listQuery = z.object({ status: engineeringTaskStatusSchema.optional() });
const fromJiraBody = z.object({
  key: z.string().min(1),
  repositoryId: z.string().min(1).optional(),
});
const fromSlackBody = z.object({
  messageId: z.string().min(1),
  repositoryId: z.string().min(1).optional(),
});

export function engineeringRoutes(c: Container): Hono {
  const app = new Hono();

  app.onError((err, ctx) => {
    if (err instanceof EngineeringTaskError) {
      const { error, status } = engineeringErrorResponse(err);
      return ctx.json({ error }, status);
    }
    throw err;
  });

  // Invalid bodies are one fixed code (the validator's issue text could echo input).
  const invalid = (r: { success: boolean }, ctx: { json: (b: unknown, s: 400) => Response }) =>
    r.success ? undefined : ctx.json({ error: "invalid_input" }, 400);

  // The list never carries description, plan or step output; GET :id is the only place for them.
  app.get("/api/engineering/tasks", zValidator("query", listQuery, invalid), (ctx) =>
    ctx.json(c.engineering.list(ctx.req.valid("query").status)),
  );
  app.post(
    "/api/engineering/tasks",
    zValidator("json", engineeringTaskCreateInputSchema, invalid),
    (ctx) => ctx.json(c.engineering.create(ctx.req.valid("json")), 201),
  );
  app.post("/api/engineering/tasks/from-jira", zValidator("json", fromJiraBody, invalid), (ctx) => {
    const { key, repositoryId } = ctx.req.valid("json");
    return ctx.json(c.engineering.createFromJira(key, repositoryId), 201);
  });
  app.post(
    "/api/engineering/tasks/from-slack",
    zValidator("json", fromSlackBody, invalid),
    (ctx) => {
      const { messageId, repositoryId } = ctx.req.valid("json");
      return ctx.json(c.engineering.createFromSlack(messageId, repositoryId), 201);
    },
  );
  app.get("/api/engineering/tasks/:id", (ctx) => {
    const t = c.engineering.get(ctx.req.param("id"));
    return t ? ctx.json(t) : ctx.json({ error: "not_found" }, 404);
  });
  app.post(
    "/api/engineering/tasks/:id/approve-description",
    zValidator("json", approveDescriptionInputSchema, invalid),
    (ctx) =>
      ctx.json(
        c.engineering.approveDescription(ctx.req.param("id"), ctx.req.valid("json").description),
      ),
  );
  // The service validates the body itself (field-specific codes: unsafe_test_command, ...).
  app.post("/api/engineering/tasks/:id/approve-plan", async (ctx) => {
    const body = await ctx.req.json().catch(() => null);
    return ctx.json(await c.engineering.approvePlan(ctx.req.param("id"), body as never));
  });
  app.post("/api/engineering/tasks/:id/cancel", (ctx) =>
    ctx.json(c.engineering.cancel(ctx.req.param("id"))),
  );
  app.get("/api/engineering/lock", (ctx) => ctx.json(c.engineeringLock.view()));
  return app;
}
