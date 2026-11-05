import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import {
  RecommendationNotFound,
  RetryNotAllowed,
  SuggestionNotAcceptable,
} from "../modules/people/recommendations";
import { UnknownSlackUserError } from "../modules/people/service";

const param = z.object({ slackUserId: z.string().regex(/^[UW][A-Z0-9]+$/) });
// PeopleService.setPriority patches: omitted fields keep their value; rationale null clears it.
const body = z.object({
  priority: z.enum(["normal", "high", "critical"]),
  rationale: z.string().max(500).nullable().optional(),
  extraAttention: z.boolean().optional(),
});

const recParam = z.object({ id: z.string().min(1).max(64) });
const candidatesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const recommendationsQuery = z.object({
  status: z
    .enum(["pending", "approved", "rejected", "expired", "superseded", "applied"])
    .default("pending"),
});

export function peopleRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/people", (ctx) => ctx.json(c.people.listPeople()));
  app.get("/api/people/candidates", zValidator("query", candidatesQuery), (ctx) =>
    ctx.json(c.peopleViews.candidates(ctx.req.valid("query").limit)),
  );
  app.get("/api/people/recommendations", zValidator("query", recommendationsQuery), (ctx) =>
    ctx.json(c.peopleViews.listRecommendations(ctx.req.valid("query").status)),
  );
  app.post(
    "/api/people/recommendations/:id/accept-suggestion",
    zValidator("param", recParam),
    (ctx) => {
      try {
        return ctx.json(c.profiles.acceptSuggestion(ctx.req.valid("param").id));
      } catch (e) {
        if (e instanceof RecommendationNotFound) {
          return ctx.json({ error: "recommendation not found" }, 404);
        }
        if (e instanceof SuggestionNotAcceptable) {
          return ctx.json({ error: "not a pending suggestion" }, 409);
        }
        throw e;
      }
    },
  );
  app.post("/api/people/recommendations/:id/retry-apply", zValidator("param", recParam), (ctx) => {
    try {
      return ctx.json(c.profiles.retryApply(ctx.req.valid("param").id));
    } catch (e) {
      if (e instanceof RecommendationNotFound) {
        return ctx.json({ error: "recommendation not found" }, 404);
      }
      if (e instanceof RetryNotAllowed) return ctx.json({ error: "apply retry not allowed" }, 409);
      throw e;
    }
  });
  app.post("/api/people/recommendations/:id/dismiss", zValidator("param", recParam), (ctx) => {
    try {
      c.profiles.dismissSuggestion(ctx.req.valid("param").id);
      return ctx.json({ dismissed: true });
    } catch (e) {
      if (e instanceof RecommendationNotFound) {
        return ctx.json({ error: "recommendation not found" }, 404);
      }
      if (e instanceof SuggestionNotAcceptable) {
        return ctx.json({ error: "not a pending suggestion" }, 409);
      }
      throw e;
    }
  });
  app.get("/api/people/:slackUserId/profile", zValidator("param", param), (ctx) => {
    const detail = c.peopleViews.personDetail(ctx.req.valid("param").slackUserId);
    return detail ? ctx.json(detail) : ctx.json({ error: "unknown slack user" }, 404);
  });
  app.post("/api/people/:slackUserId/evaluate", zValidator("param", param), (ctx) => {
    const { slackUserId } = ctx.req.valid("param");
    if (!c.peopleViews.slackUserExists(slackUserId)) {
      return ctx.json({ error: "unknown slack user" }, 404);
    }
    return ctx.json(c.profiles.requestInitialProfile(slackUserId), 202);
  });
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
