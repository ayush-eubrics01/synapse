import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";

const flagsQuery = z.object({
  includeReviewed: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
const userParam = z.object({ slackUserId: z.string().regex(/^[UW][A-Z0-9]+$/) });
const idParam = z.object({ id: z.string().min(1) });
const reviewBody = z.object({ status: z.enum(["acknowledged", "contacted", "dismissed"]) });

export function securityRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/security/flags", zValidator("query", flagsQuery), (ctx) =>
    ctx.json(
      c.securityFlags.listGroupedByPerson({
        minSeverity: c.settings.get("security.flags.widgetMinSeverity"),
        includeReviewed: ctx.req.valid("query").includeReviewed,
      }),
    ),
  );
  // Full history for one person, including info-level flags.
  app.get("/api/security/flags/person/:slackUserId", zValidator("param", userParam), (ctx) =>
    ctx.json(c.securityFlags.listByPerson(ctx.req.valid("param").slackUserId)),
  );
  app.post(
    "/api/security/flags/:id/review",
    zValidator("param", idParam),
    zValidator("json", reviewBody),
    (ctx) => {
      const { id } = ctx.req.valid("param");
      const { status } = ctx.req.valid("json");
      try {
        c.securityFlags.review(id, status);
      } catch (e) {
        if (e instanceof Error && e.message === "unknown flag") {
          return ctx.json({ error: "flag not found" }, 404);
        }
        throw e;
      }
      return ctx.json({ id, status });
    },
  );
  return app;
}
