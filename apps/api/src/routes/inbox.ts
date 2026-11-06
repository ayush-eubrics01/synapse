import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z
    .string()
    .datetime({ offset: true })
    .transform((v) => new Date(v).toISOString())
    .optional(),
  conversationId: z
    .string()
    .regex(/^[CDG][A-Z0-9]+$/)
    .optional(),
});

export function inboxRoutes(c: Container): Hono {
  const app = new Hono();
  // `text` is null once its content expired. Message text is never logged.
  app.get("/api/inbox/messages", zValidator("query", query), (ctx) => {
    const { limit, before, conversationId } = ctx.req.valid("query");
    return ctx.json(c.inbox.listMessages({ limit, beforeSentAt: before, conversationId }));
  });
  app.get(
    "/api/inbox/conversations",
    zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) })),
    (ctx) => ctx.json(c.conversations.list(ctx.req.valid("query").limit)),
  );
  app.get(
    "/api/inbox/conversations/:id/thread",
    zValidator("param", z.object({ id: z.string().regex(/^[CDG][A-Z0-9]+$/) })),
    zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) })),
    (ctx) => {
      const t = c.conversations.thread(ctx.req.valid("param").id, ctx.req.valid("query").limit);
      return t ? ctx.json(t) : ctx.json({ error: "conversation not found" }, 404);
    },
  );
  return app;
}
