import { dashboardLayoutInputSchema, layoutNameSchema } from "@synapse/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import { LayoutError } from "../modules/dashboard/layout";

const createBody = z.object({ name: z.unknown(), fromId: z.string().min(1).optional() });
const updateBody = z.object({ name: z.unknown().optional(), layout: z.unknown().optional() });

export function dashboardLayoutRoutes(c: Container): Hono {
  const app = new Hono();
  const svc = c.dashboardLayouts;
  const fail = (ctx: { json: (b: unknown, s: 400 | 404 | 409) => Response }, err: unknown) => {
    if (err instanceof LayoutError)
      return ctx.json({ error: err.code }, err.code === "not_found" ? 404 : 409);
    throw err;
  };
  const body = async (ctx: { req: { json: () => Promise<unknown> } }): Promise<unknown> =>
    ctx.req.json().catch(() => undefined);

  app.get("/api/dashboard/layouts", (ctx) => ctx.json(svc.list()));

  app.post("/api/dashboard/layouts", async (ctx) => {
    const b = createBody.safeParse(await body(ctx));
    const name = layoutNameSchema.safeParse(b.success ? b.data.name : undefined);
    if (!b.success || !name.success) return ctx.json({ error: "invalid_name" }, 400);
    try {
      return ctx.json(svc.create(name.data, b.data.fromId), 201);
    } catch (err) {
      return fail(ctx, err);
    }
  });

  app.put("/api/dashboard/layouts/:id", async (ctx) => {
    const b = updateBody.safeParse(await body(ctx));
    if (!b.success || (b.data.name === undefined && b.data.layout === undefined))
      return ctx.json({ error: "invalid_layout" }, 400);
    let name: string | undefined;
    if (b.data.name !== undefined) {
      const n = layoutNameSchema.safeParse(b.data.name);
      if (!n.success) return ctx.json({ error: "invalid_name" }, 400);
      name = n.data;
    }
    if (b.data.layout !== undefined && !dashboardLayoutInputSchema.safeParse(b.data.layout).success)
      return ctx.json({ error: "invalid_layout" }, 400);
    try {
      return ctx.json(svc.update(ctx.req.param("id"), { name, layout: b.data.layout }));
    } catch (err) {
      return fail(ctx, err);
    }
  });

  app.post("/api/dashboard/layouts/:id/activate", (ctx) => {
    try {
      return ctx.json(svc.activate(ctx.req.param("id")));
    } catch (err) {
      return fail(ctx, err);
    }
  });

  app.post("/api/dashboard/layouts/:id/reset", (ctx) => {
    try {
      return ctx.json(svc.reset(ctx.req.param("id")));
    } catch (err) {
      return fail(ctx, err);
    }
  });

  app.delete("/api/dashboard/layouts/:id", (ctx) => {
    try {
      svc.remove(ctx.req.param("id"));
      return ctx.body(null, 204);
    } catch (err) {
      return fail(ctx, err);
    }
  });

  return app;
}
