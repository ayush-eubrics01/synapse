import { zValidator } from "@hono/zod-validator";
import { urgencyStatusSchema } from "@synapse/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import { InvalidUrgencyTransition } from "../modules/inbox/urgent";

const query = z.object({ status: z.enum(["open", "all"]).default("open") });
const param = z.object({ messageId: z.string().min(1) });
const body = z.object({ status: urgencyStatusSchema });

export function urgentRoutes(c: Container): Hono {
  const app = new Hono();
  // Message and draft text appear only in this response; never in logs, audit rows or events.
  app.get("/api/urgent", zValidator("query", query), (ctx) =>
    ctx.json(c.urgent.listUrgent(ctx.req.valid("query"))),
  );
  app.post(
    "/api/urgent/:messageId/status",
    zValidator("param", param),
    zValidator("json", body),
    (ctx) => {
      const { messageId } = ctx.req.valid("param");
      const { status } = ctx.req.valid("json");
      try {
        c.urgent.setUrgencyStatus(messageId, status);
      } catch (e) {
        if (e instanceof InvalidUrgencyTransition) {
          if (e.from === "missing") return ctx.json({ error: "urgent message not found" }, 404);
          return ctx.json({ error: "invalid status transition" }, 409);
        }
        throw e;
      }
      return ctx.json({ messageId, status });
    },
  );
  return app;
}
