import { zValidator } from "@hono/zod-validator";
import { JOB_STATUSES } from "@synapse/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";

const query = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function jobRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/jobs", zValidator("query", query), (ctx) => {
    const { status, limit } = ctx.req.valid("query");
    return ctx.json(c.queue.list({ status, limit, order: "newest" }));
  });
  return app;
}
