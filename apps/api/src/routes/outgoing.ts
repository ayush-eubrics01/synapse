import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import {
  OutgoingNotFound,
  ResolveNotAllowed,
  SendAlreadyPending,
} from "../modules/outgoing/service";

const param = z.object({ id: z.string().min(1) });
const body = z.object({ decision: z.enum(["mark_sent", "resend", "discard"]) });

export function outgoingRoutes(c: Container): Hono {
  const app = new Hono();
  // The user's decision on a send whose delivery is unknown or was blocked. Ids and statuses only.
  app.post(
    "/api/outgoing/:id/resolve",
    zValidator("param", param),
    zValidator("json", body),
    (ctx) => {
      try {
        return ctx.json(
          c.outgoing.resolveNeedsAttention(
            ctx.req.valid("param").id,
            ctx.req.valid("json").decision,
          ),
        );
      } catch (e) {
        if (e instanceof OutgoingNotFound)
          return ctx.json({ error: "outgoing message not found" }, 404);
        if (e instanceof ResolveNotAllowed || e instanceof SendAlreadyPending) {
          return ctx.json({ error: "this message cannot be resolved that way" }, 409);
        }
        throw e;
      }
    },
  );
  return app;
}
