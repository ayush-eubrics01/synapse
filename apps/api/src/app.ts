import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Container } from "./container";
import { InvalidApprovalTransition } from "./core/approvals/approvals";
import { approvalRoutes } from "./routes/approvals";
import { healthRoutes } from "./routes/health";
import { jobRoutes } from "./routes/jobs";
import { notificationRoutes } from "./routes/notifications";
import { streamRoutes } from "./routes/stream";

export function createApp(c: Container): Hono {
  const app = new Hono();
  app.route("/", healthRoutes(c));
  app.route("/", approvalRoutes(c));
  app.route("/", jobRoutes(c));
  app.route("/", notificationRoutes(c));
  app.route("/", streamRoutes(c));
  app.onError((err, ctx) => {
    if (err instanceof InvalidApprovalTransition) {
      if (err.from === "missing") return ctx.json({ error: "approval not found" }, 404);
      return ctx.json({ error: "invalid approval transition" }, 409);
    }
    if (err instanceof HTTPException && err.status < 500) {
      return ctx.json({ error: err.message }, err.status);
    }
    console.error(
      "request failed:",
      ctx.req.method,
      ctx.req.path,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    return ctx.json({ error: "internal error" }, 500);
  });
  return app;
}
