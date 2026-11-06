import { zValidator } from "@hono/zod-validator";
import { commitmentFilterSchema, followupStatusSchema } from "@synapse/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import {
  FollowupNotDiscardable,
  FollowupNotSendable,
  InvalidManualDraft,
} from "../modules/commitments/followups";
import {
  InvalidCommitmentEdit,
  InvalidCommitmentTransition,
  InvalidProposal,
  InvalidReview,
  UnknownCommitment,
  UnknownProposal,
} from "../modules/commitments/lifecycle";
import {
  FollowupNotFound,
  InvalidOutgoingText,
  SendAlreadyPending,
} from "../modules/outgoing/service";

const id = z.string().min(1).max(64);
const param = z.object({ id });
const listQuery = z.object({
  filter: commitmentFilterSchema.default("all"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const slackId = z.string().regex(/^[UW][A-Z0-9]+$/);
const reviewBody = z
  .object({
    decision: z.enum(["accept", "reject"]),
    edits: z
      .object({
        description: z.string().min(1).max(500).optional(),
        dueAt: z.string().max(40).nullable().optional(),
        owner: slackId.optional(),
        counterparty: slackId.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const statusBody = z
  .object({
    status: z.enum(["open", "in_progress", "blocked", "completed", "cancelled"]),
    reason: z.string().max(500).optional(),
  })
  .strict();
const proposalBody = z.object({ accept: z.boolean() }).strict();
const followupsQuery = z.object({
  status: z.union([followupStatusSchema, z.literal("active")]).default("active"),
});
const sendBody = z.object({ text: z.string().min(1).max(10_000) }).strict();

/** Commitments, their review and status lifecycle, and follow-up drafts. Ids and enums only in errors. */
export function commitmentRoutes(c: Container): Hono {
  const app = new Hono();
  app.get("/api/commitments", zValidator("query", listQuery), (ctx) => {
    const { filter, limit } = ctx.req.valid("query");
    return ctx.json(c.commitmentLifecycle.listViews(filter, limit));
  });
  app.post(
    "/api/commitments/proposals/:id",
    zValidator("param", param),
    zValidator("json", proposalBody),
    (ctx) => {
      try {
        c.commitmentLifecycle.confirmProposal(
          ctx.req.valid("param").id,
          ctx.req.valid("json").accept,
        );
        return ctx.json({ ok: true });
      } catch (e) {
        if (e instanceof UnknownProposal) return ctx.json({ error: "proposal not found" }, 404);
        if (e instanceof InvalidProposal) return ctx.json({ error: "not a pending proposal" }, 409);
        throw e;
      }
    },
  );
  app.post(
    "/api/commitments/:id/review",
    zValidator("param", param),
    zValidator("json", reviewBody),
    (ctx) => {
      const { decision, edits } = ctx.req.valid("json");
      try {
        c.commitmentLifecycle.review(ctx.req.valid("param").id, decision, edits);
        return ctx.json({ ok: true });
      } catch (e) {
        return commitmentError(ctx, e);
      }
    },
  );
  app.post(
    "/api/commitments/:id/status",
    zValidator("param", param),
    zValidator("json", statusBody),
    (ctx) => {
      const { status, reason } = ctx.req.valid("json");
      try {
        c.commitmentLifecycle.setStatus(ctx.req.valid("param").id, status, reason);
        return ctx.json({ ok: true });
      } catch (e) {
        return commitmentError(ctx, e);
      }
    },
  );
  app.post("/api/commitments/:id/draft-followup", zValidator("param", param), (ctx) => {
    try {
      return ctx.json(c.followups.requestManualDraft(ctx.req.valid("param").id), 202);
    } catch (e) {
      return commitmentError(ctx, e);
    }
  });

  app.get("/api/followups", zValidator("query", followupsQuery), (ctx) =>
    ctx.json(c.followups.listViews(ctx.req.valid("query").status)),
  );
  // The text appears only in this request body and the list response; the sink is called only
  // after the user approves it in the approval engine.
  app.post(
    "/api/followups/:id/send",
    zValidator("param", param),
    zValidator("json", sendBody),
    (ctx) => {
      try {
        return ctx.json(c.followups.send(ctx.req.valid("param").id, ctx.req.valid("json").text));
      } catch (e) {
        if (e instanceof FollowupNotFound) return ctx.json({ error: "follow-up not found" }, 404);
        if (e instanceof InvalidOutgoingText) {
          return ctx.json({ error: "text must be 1..4000 characters" }, 400);
        }
        if (e instanceof FollowupNotSendable) {
          return ctx.json({ error: "follow-up cannot be sent now" }, 409);
        }
        if (e instanceof SendAlreadyPending) {
          return ctx.json({ error: "a send is already pending" }, 409);
        }
        throw e;
      }
    },
  );
  app.post("/api/followups/:id/discard", zValidator("param", param), (ctx) => {
    try {
      c.followups.discard(ctx.req.valid("param").id);
      return ctx.json({ ok: true });
    } catch (e) {
      if (e instanceof FollowupNotFound) return ctx.json({ error: "follow-up not found" }, 404);
      if (e instanceof FollowupNotDiscardable) {
        return ctx.json({ error: "follow-up cannot be discarded now" }, 409);
      }
      throw e;
    }
  });
  return app;
}

function commitmentError(ctx: { json: (b: unknown, s: 404 | 409) => Response }, e: unknown) {
  if (e instanceof UnknownCommitment) return ctx.json({ error: "commitment not found" }, 404);
  if (
    e instanceof InvalidReview ||
    e instanceof InvalidCommitmentTransition ||
    e instanceof InvalidCommitmentEdit ||
    e instanceof InvalidManualDraft
  ) {
    return ctx.json({ error: "operation not allowed for this commitment" }, 409);
  }
  throw e;
}
