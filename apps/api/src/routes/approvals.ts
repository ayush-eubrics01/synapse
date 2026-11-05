import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";

const decisionBody = z.object({ reason: z.string().optional() });

export function approvalRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/approvals", (ctx) => {
    const status = ctx.req.query("status");
    if (status !== undefined && status !== "pending") {
      return ctx.json({ error: "only status=pending is supported" }, 400);
    }
    return ctx.json(c.approvals.listPending());
  });
  app.post("/api/approvals/:id/approve", zValidator("json", decisionBody), (ctx) =>
    ctx.json(c.approvals.approve(ctx.req.param("id"))),
  );
  app.post("/api/approvals/:id/reject", zValidator("json", decisionBody), (ctx) =>
    ctx.json(c.approvals.reject(ctx.req.param("id"), ctx.req.valid("json").reason ?? "")),
  );
  app.post("/api/approvals/:id/revoke", zValidator("json", decisionBody), (ctx) =>
    ctx.json(c.approvals.revoke(ctx.req.param("id"), ctx.req.valid("json").reason ?? "")),
  );
  return app;
}
