import { Hono } from "hono";
import type { Container } from "../container";

export function healthRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/health/live", (ctx) => ctx.json({ ok: true }));
  app.get("/health/ready", async (ctx) => {
    const report = await c.health.report();
    return ctx.json(report, report.status === "down" ? 503 : 200);
  });
  return app;
}
