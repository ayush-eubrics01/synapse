import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import { UnknownSlackUserError } from "../modules/people/service";

const param = z.object({ slackUserId: z.string().regex(/^[UW][A-Z0-9]+$/) });
// PeopleService.setPriority replaces: omitted rationale/extraAttention reset.
const body = z.object({
  priority: z.enum(["normal", "high", "critical"]),
  rationale: z.string().max(500).optional(),
  extraAttention: z.boolean().optional(),
});

export function peopleRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/people", (ctx) => ctx.json(c.people.listPeople()));
  app.put(
    "/api/people/:slackUserId/priority",
    zValidator("param", param),
    zValidator("json", body),
    (ctx) => {
      const { slackUserId } = ctx.req.valid("param");
      try {
        c.people.setPriority(slackUserId, ctx.req.valid("json"));
      } catch (e) {
        if (e instanceof UnknownSlackUserError) {
          return ctx.json({ error: "unknown slack user" }, 404);
        }
        throw e;
      }
      return ctx.json({ slackUserId, ...c.people.getPriorityBySlackUser(slackUserId) });
    },
  );
  return app;
}
