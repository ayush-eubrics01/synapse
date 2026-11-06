import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import { CodeAnswerError, type CodeAnswerErrorCode } from "../modules/code-answers/service";

const id = z.object({ id: z.string().min(1) });
const trigger = z.object({ repositoryId: z.string().min(1) });
const send = z.object({ text: z.string(), useAnyway: z.boolean().optional() });

const STATUS: Record<CodeAnswerErrorCode, 400 | 404 | 409> = {
  not_found: 404,
  invalid_repository: 400,
  invalid_text: 400,
  already_running: 409,
  already_answered: 409,
  invalid_state: 409,
  injection_unacknowledged: 409,
};

/** C5: the user's code-answer trigger, list, dismiss and approval-gated send. Ids and codes only. */
export function codeAnswerRoutes(c: Container): Hono {
  const app = new Hono();
  // The service's errors carry fixed codes; the body never echoes message or answer text.
  app.onError((err, ctx) => {
    if (err instanceof CodeAnswerError) {
      return ctx.json({ error: err.code }, STATUS[err.code]);
    }
    throw err;
  });
  app.post(
    "/api/inbox/messages/:id/code-answer",
    zValidator("param", id),
    zValidator("json", trigger),
    (ctx) =>
      ctx.json(
        c.codeAnswers.requestUser(ctx.req.valid("param").id, ctx.req.valid("json").repositoryId),
        202,
      ),
  );
  app.get("/api/inbox/messages/:id/code-answers", zValidator("param", id), (ctx) =>
    ctx.json(c.codeAnswers.listForMessage(ctx.req.valid("param").id)),
  );
  app.post("/api/code-answers/:id/dismiss", zValidator("param", id), (ctx) => {
    c.codeAnswers.dismiss(ctx.req.valid("param").id);
    return ctx.body(null, 204);
  });
  app.post(
    "/api/code-answers/:id/send",
    zValidator("param", id),
    zValidator("json", send),
    (ctx) => {
      const { text, useAnyway } = ctx.req.valid("json");
      return ctx.json(
        c.codeAnswers.requestSend(ctx.req.valid("param").id, text, useAnyway ?? false),
      );
    },
  );
  return app;
}
