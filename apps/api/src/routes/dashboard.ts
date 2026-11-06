import { Hono } from "hono";
import type { Container } from "../container";

export function dashboardRoutes(c: Container): Hono {
  const app = new Hono();
  // Counts and names only; no message text.
  app.get("/api/dashboard/overview", async (ctx) => ctx.json(await c.dashboard.overview()));
  return app;
}
