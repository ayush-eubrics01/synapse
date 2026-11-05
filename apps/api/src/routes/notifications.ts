import { Hono } from "hono";
import type { Container } from "../container";

export function notificationRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/notifications", (ctx) =>
    ctx.json(c.notifications.list({ unreadOnly: ctx.req.query("unread") === "true" })),
  );
  app.post("/api/notifications/:id/read", (ctx) => {
    c.notifications.markRead(ctx.req.param("id"));
    return ctx.json({ ok: true });
  });
  return app;
}
