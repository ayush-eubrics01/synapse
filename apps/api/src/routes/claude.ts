import { zValidator } from "@hono/zod-validator";
import { schema } from "@synapse/database";
import { desc, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import { quotaLevel, thresholdsFromSettings } from "../core/orchestrator/quota-gate";

const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

function errorKind(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

export function claudeRoutes(c: Container): Hono {
  const app = new Hono();

  // Only the listed metadata fields: no prompts, results or error messages.
  app.get("/api/claude/runs", zValidator("query", query), (ctx) => {
    const { limit } = ctx.req.valid("query");
    const rows = c.db
      .select()
      .from(schema.claudeRuns)
      .orderBy(desc(schema.claudeRuns.startedAt), sql`rowid desc`)
      .limit(limit)
      .all();
    return ctx.json(
      rows.map((r) => ({
        id: r.id,
        jobId: r.jobId,
        workerProfile: r.workerProfile,
        model: r.model,
        status: r.status,
        numTurns: r.numTurns,
        durationMs: r.durationMs,
        tokens: {
          input: r.inputTokens,
          output: r.outputTokens,
          cacheRead: r.cacheReadTokens,
          cacheCreation: r.cacheCreationTokens,
        },
        costUsdEquivalent: r.costUsdEquivalent,
        permissionDenialCount: Array.isArray(r.permissionDenials) ? r.permissionDenials.length : 0,
        errorKind: errorKind(r.error),
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
    );
  });

  app.get("/api/claude/status", (ctx) => {
    const snap = c.orchestrator.latestSnapshot();
    let quota = null;
    if (snap) {
      const d = quotaLevel(snap, thresholdsFromSettings(c.settings), c.clock.now());
      quota = {
        level: d.level,
        window: d.window,
        resetsAt: d.resetsAt,
        fiveHour: snap.fiveHour,
        sevenDay: snap.sevenDay,
      };
    }
    const { refreshExpiresAt, slides } = c.auth.status();
    return ctx.json({ quota, auth: { refreshExpiresAt, slides } });
  });
  return app;
}
