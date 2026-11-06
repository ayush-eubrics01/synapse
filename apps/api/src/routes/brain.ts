import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Container } from "../container";
import { RegistryError } from "../modules/engineering-brain/registry";
import { BrainError } from "../modules/engineering-brain/service";

const REGISTRY_CONFLICTS = new Set([
  "already_registered",
  "duplicate_name",
  "path_unavailable",
  "repo_has_active_task",
]);

/**
 * Spec C12. Errors are fixed codes: paths, remote URLs, branch names and fact text never reach a
 * response. `not_found` from the registry is a missing id on id routes (404) but a missing path
 * on register (400, one of the path reasons), hence `idRoute`.
 */
function registryStatus(e: RegistryError, idRoute: boolean): ContentfulStatusCode {
  if (e.code === "not_found" && idRoute) return 404;
  if (REGISTRY_CONFLICTS.has(e.code)) return 409;
  return 400;
}

const BRAIN_STATUS: Record<BrainError["code"], ContentfulStatusCode> = {
  not_found: 404,
  invalid_input: 400,
  invalid_environment: 400,
  duplicate_name: 409,
  invalid_state: 409,
};

async function jsonBody(req: Request, optional = false): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return optional ? {} : null;
  }
}

export function brainRoutes(c: Container): Hono {
  const app = new Hono();

  // Registry and brain errors become fixed codes; anything else falls through to onError.
  app.onError((err, ctx) => {
    if (err instanceof RegistryError) {
      const idRoute = ctx.req.method !== "POST" || ctx.req.path !== "/api/repos";
      return ctx.json({ error: err.code }, registryStatus(err, idRoute));
    }
    if (err instanceof BrainError) return ctx.json({ error: err.code }, BRAIN_STATUS[err.code]);
    throw err;
  });

  // ---- repositories ----
  app.get("/api/repos", (ctx) => ctx.json(c.repositories.list()));
  app.get("/api/repos/:id", (ctx) => {
    const repo = c.repositories.get(ctx.req.param("id"));
    return repo ? ctx.json(repo) : ctx.json({ error: "not_found" }, 404);
  });
  app.post("/api/repos/inspect", async (ctx) => {
    const body = (await jsonBody(ctx.req.raw)) as { path?: unknown } | null;
    const r = await c.repositories.propose(body?.path as string);
    return r.ok ? ctx.json(r.proposal) : ctx.json({ error: r.reason, reason: r.reason }, 400);
  });
  app.post("/api/repos", async (ctx) =>
    ctx.json(await c.repositories.register((await jsonBody(ctx.req.raw)) as never), 201),
  );
  app.put("/api/repos/:id", async (ctx) =>
    ctx.json(
      await c.repositories.update(ctx.req.param("id"), (await jsonBody(ctx.req.raw)) as never),
    ),
  );
  app.delete("/api/repos/:id", (ctx) => {
    c.repositories.unregister(ctx.req.param("id"));
    return ctx.body(null, 204);
  });
  app.post("/api/repos/:id/accept-remotes", async (ctx) =>
    ctx.json(await c.repositories.acceptCurrentRemotes(ctx.req.param("id"))),
  );
  app.post("/api/repos/:id/inspect", (ctx) => {
    const r = c.brain.requestInspection(ctx.req.param("id"));
    if (r.status === "not_found") return ctx.json({ error: "not_found" }, 404);
    if (r.status === "already_queued") {
      return ctx.json({ error: "already_queued", jobId: r.jobId }, 409);
    }
    return ctx.json({ jobId: r.jobId }, 202);
  });

  // ---- projects, facts, milestones ----
  app.get("/api/projects", (ctx) => ctx.json(c.brain.listProjects()));
  app.get("/api/projects/:id", (ctx) => {
    const p = c.brain.getProject(ctx.req.param("id"));
    return p ? ctx.json(p) : ctx.json({ error: "not_found" }, 404);
  });
  app.put("/api/projects/:id", async (ctx) =>
    ctx.json(c.brain.updateProject(ctx.req.param("id"), (await jsonBody(ctx.req.raw)) as never)),
  );
  app.post("/api/projects/:id/facts", async (ctx) =>
    ctx.json(c.brain.addFact(ctx.req.param("id"), (await jsonBody(ctx.req.raw)) as never), 201),
  );
  app.post("/api/brain/facts/:id/accept", async (ctx) =>
    ctx.json(c.brain.acceptFact(ctx.req.param("id"), (await jsonBody(ctx.req.raw, true)) as never)),
  );
  app.post("/api/brain/facts/:id/reject", (ctx) =>
    ctx.json(c.brain.rejectFact(ctx.req.param("id"))),
  );
  app.get("/api/projects/:id/milestones", (ctx) =>
    ctx.json(c.brain.listMilestones(ctx.req.param("id"))),
  );
  app.post("/api/projects/:id/milestones", async (ctx) =>
    ctx.json(
      c.brain.createMilestone(ctx.req.param("id"), (await jsonBody(ctx.req.raw)) as never),
      201,
    ),
  );
  app.put("/api/projects/:id/milestones/:mid", async (ctx) =>
    ctx.json(
      c.brain.updateMilestone(
        ctx.req.param("id"),
        ctx.req.param("mid"),
        (await jsonBody(ctx.req.raw)) as never,
      ),
    ),
  );
  app.delete("/api/projects/:id/milestones/:mid", (ctx) => {
    c.brain.deleteMilestone(ctx.req.param("id"), ctx.req.param("mid"));
    return ctx.body(null, 204);
  });
  app.get("/api/brain/upcoming", (ctx) => ctx.json(c.brain.upcoming()));
  return app;
}
