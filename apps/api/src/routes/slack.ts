import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import type { SyncState } from "../modules/inbox/sync-state";
import { UnknownSlackUserError } from "../modules/people/service";

export function slackRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/slack/status", (ctx) => {
    const incremental = c.sync.get("slack.messages");
    const backfill = c.sync.get("slack.backfill");
    const today = c.clock.now().toISOString().slice(0, 10);
    const searches = (s: SyncState) => (s.searchCountDate === today ? s.searchCount : 0);
    return ctx.json({
      incremental,
      backfill: { ...backfill, resumable: c.slack.backfillResumable() },
      searchesToday: searches(incremental) + searches(backfill),
    });
  });
  app.get("/api/slack/identity", (ctx) => {
    const suggestion = c.people.suggestSelfUserId();
    const suggestionName = suggestion
      ? (c.people.listPeople().find((p) => p.slackUserId === suggestion)?.name ?? null)
      : null;
    return ctx.json({
      selfUserId: c.settings.get("slack.selfUserId"),
      suggestion,
      suggestionName,
    });
  });
  app.put(
    "/api/slack/identity",
    zValidator("json", z.object({ selfUserId: z.string().regex(/^[UW][A-Z0-9]+$/) })),
    (ctx) => {
      const { selfUserId } = ctx.req.valid("json");
      try {
        c.people.confirmSelfUserId(selfUserId);
      } catch (e) {
        if (e instanceof UnknownSlackUserError) {
          return ctx.json({ error: "unknown slack user" }, 400);
        }
        throw e;
      }
      return ctx.json({ selfUserId });
    },
  );
  app.post("/api/slack/backfill", (ctx) => ctx.json(c.slack.startBackfill()));
  return app;
}
