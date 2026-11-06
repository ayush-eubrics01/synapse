import { newId } from "@synapse/shared";
import { Hono } from "hono";
import type { Container } from "../container";
import { backupJobLive, OPS_BACKUP_JOB } from "../workers/ops";

export function systemRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/system/runtime", async (ctx) => ctx.json(await c.runtime.view()));
  app.get("/api/system/backups", (ctx) => ctx.json(c.backup.list()));
  app.post("/api/system/backups", (ctx) => {
    if (backupJobLive(c.db)) return ctx.json({ error: "already_running" }, 409);
    const { id } = c.queue.enqueue(c.db, {
      type: OPS_BACKUP_JOB,
      input: { manual: true },
      idempotencyKey: `ops.backup.manual:${newId()}`,
    });
    return ctx.json({ jobId: id }, 202);
  });
  return app;
}
