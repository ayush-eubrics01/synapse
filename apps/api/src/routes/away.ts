import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";

const body = z.object({ on: z.boolean() });
const param = z.object({ sessionId: z.string().min(1) });

/** Away mode (ADR-033): the switch, its status and the post-away digest. Ids and counts only. */
export function awayRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/away", (ctx) => ctx.json(c.autoReply.status()));
  app.put("/api/away", zValidator("json", body), (ctx) =>
    ctx.json(c.autoReply.setAway(ctx.req.valid("json").on)),
  );
  app.get("/api/away/digest", (ctx) => ctx.json(c.autoReply.digest()));
  app.post("/api/away/digest/:sessionId/dismiss", zValidator("param", param), (ctx) => {
    if (!c.autoReply.dismissDigest(ctx.req.valid("param").sessionId)) {
      return ctx.json({ error: "away session not found" }, 404);
    }
    return ctx.body(null, 204);
  });
  return app;
}
