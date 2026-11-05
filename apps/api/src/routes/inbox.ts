import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
  conversationId: z.string().min(1).optional(),
});

export function inboxRoutes(c: Container): Hono {
  const app = new Hono();
  // `text` is null once its content expired. Message text is never logged.
  app.get("/api/inbox/messages", zValidator("query", query), (ctx) => {
    const { limit, before, conversationId } = ctx.req.valid("query");
    return ctx.json(c.inbox.listMessages({ limit, beforeSentAt: before, conversationId }));
  });
  return app;
}
