import { zValidator } from "@hono/zod-validator";
import { urgencyStatusSchema } from "@synapse/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import { InvalidUrgencyTransition } from "../modules/inbox/urgent";
import { InvalidOutgoingText, SendAlreadyPending } from "../modules/outgoing/service";
import { ExpiredSource, UrgentMessageNotFound } from "../modules/outgoing/urgent-reply";

const query = z.object({ status: z.enum(["open", "all"]).default("open") });
const param = z.object({ messageId: z.string().min(1) });
const body = z.object({ status: urgencyStatusSchema });
const replyBody = z.object({
  text: z.string().min(1).max(4000),
  allowNoThread: z.boolean().optional(),
});

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
  // The reply text appears only in the request body and the approvals response (H4).
  app.post(
    "/api/urgent/:messageId/reply",
    zValidator("param", param),
    zValidator("json", replyBody),
    (ctx) => {
      const { messageId } = ctx.req.valid("param");
      const { text, allowNoThread } = ctx.req.valid("json");
      try {
        const r = c.urgentReplies.requestUrgentReply(messageId, text, { allowNoThread });
        return ctx.json({ followupId: r.followupId, approvalId: r.approvalId });
      } catch (e) {
        if (e instanceof UrgentMessageNotFound)
          return ctx.json({ error: "urgent message not found" }, 404);
        if (e instanceof InvalidOutgoingText)
          return ctx.json({ error: "text must be 1..4000 characters" }, 400);
        if (e instanceof ExpiredSource) return ctx.json({ error: "message content expired" }, 409);
        if (e instanceof SendAlreadyPending)
          return ctx.json({ error: "a reply is already pending" }, 409);
        throw e;
      }
    },
  );
  return app;
}
