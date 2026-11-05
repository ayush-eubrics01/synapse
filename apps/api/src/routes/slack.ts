import { Hono } from "hono";
import type { Container } from "../container";
import type { SyncState } from "../modules/inbox/sync-state";

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
  app.post("/api/slack/backfill", (ctx) => ctx.json(c.slack.startBackfill()));
  return app;
}
