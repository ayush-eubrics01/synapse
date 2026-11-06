import { Hono } from "hono";
import type { Container } from "../container";

/** A11: recent interactive Claude Code sessions per registered repository (metadata only, ADR-036). */
export function claudeActivityRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/claude/activity", (ctx) => ctx.json(c.claudeActivity.view()));
  return app;
}
