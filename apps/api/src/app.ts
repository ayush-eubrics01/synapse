import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Container } from "./container";
import { InvalidApprovalTransition } from "./core/approvals/approvals";
import { localOnly } from "./middleware/local-only";
import { approvalRoutes } from "./routes/approvals";
import { awayRoutes } from "./routes/away";
import { brainRoutes } from "./routes/brain";
import { claudeRoutes } from "./routes/claude";
import { claudeActivityRoutes } from "./routes/claude-activity";
import { codeAnswerRoutes } from "./routes/code-answers";
import { commitmentRoutes } from "./routes/commitments";
import { dashboardRoutes } from "./routes/dashboard";
import { engineeringRoutes } from "./routes/engineering";
import { healthRoutes } from "./routes/health";
import { inboxRoutes } from "./routes/inbox";
import { jiraRoutes } from "./routes/jira";
import { jobRoutes } from "./routes/jobs";
import { notificationRoutes } from "./routes/notifications";
import { outgoingRoutes } from "./routes/outgoing";
import { peopleRoutes } from "./routes/people";
import { securityRoutes } from "./routes/security";
import { settingsRoutes } from "./routes/settings";
import { slackRoutes } from "./routes/slack";
import { streamRoutes } from "./routes/stream";
import { urgentRoutes } from "./routes/urgent";

export function createApp(c: Container): Hono {
  const app = new Hono();
  app.use("*", localOnly({ api: c.config.api.port, web: c.config.web.port }));
  app.route("/", healthRoutes(c));
  app.route("/", approvalRoutes(c));
  app.route("/", jobRoutes(c));
  app.route("/", claudeRoutes(c));
  app.route("/", claudeActivityRoutes(c));
  app.route("/", settingsRoutes(c));
  app.route("/", notificationRoutes(c));
  app.route("/", inboxRoutes(c));
  app.route("/", codeAnswerRoutes(c));
  app.route("/", slackRoutes(c));
  app.route("/", jiraRoutes(c));
  app.route("/", urgentRoutes(c));
  app.route("/", outgoingRoutes(c));
  app.route("/", securityRoutes(c));
  app.route("/", peopleRoutes(c));
  app.route("/", commitmentRoutes(c));
  app.route("/", awayRoutes(c));
  app.route("/", brainRoutes(c));
  app.route("/", engineeringRoutes(c));
  app.route("/", dashboardRoutes(c));
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
