import { expect, test } from "bun:test";
import type { CommitmentFilter } from "@synapse/contracts";
import { renderToString } from "react-dom/server";
import { Commitments, reviewCount } from "../app/components/commitments/Commitments";
import type { CommitmentViewDto } from "../lib/api";

const text = (html: string) => html.replace(/<!-- -->/g, "");

const commitment = (o: Partial<CommitmentViewDto> = {}): CommitmentViewDto => ({
  id: "c1",
  description: "ship <b>report</b>",
  ownerSlackUserId: "U1",
  ownerName: "Ada",
  counterpartySlackUserId: "U2",
  counterpartyName: null,
  direction: "theirs",
  status: "open",
  reviewStatus: "accepted",
  dueAt: null,
  nextAction: null,
  completionEvidence: null,
  stalledAt: null,
  lastFollowupAt: null,
  closedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  sources: [],
  proposals: [],
  followups: [],
  actions: ["start", "block", "complete", "cancel", "draft_followup"],
  ...o,
});
const renderCommitments = (
  items: CommitmentViewDto[],
  queue: CommitmentViewDto[] = [],
  filter: CommitmentFilter = "all",
) =>
  text(
    renderToString(
      <Commitments
        queue={queue}
        items={items}
        filter={filter}
        onFilter={() => {}}
        onStatus={() => {}}
        onProposal={() => {}}
        onDraftFollowup={() => {}}
        onGoToReview={() => {}}
      />,
    ),
  );

test("Commitments header, filter tabs, status buttons from the server's actions, text as text", () => {
  const html = renderCommitments([commitment()]);
  expect(html).toContain("Commitments");
  expect(html).toContain("Promises made by you and to you, confirmed by you.");
  for (const l of ["All", "Mine", "Theirs", "Overdue", "Due soon", "Blocked", "Closed"]) {
    expect(html).toContain(l);
  }
  expect(html).toContain('aria-selected="true"');
  for (const l of ["Start", "Block", "Complete", "Cancel", "Draft follow-up"]) {
    expect(html).toContain(l);
  }
  expect(html).not.toContain("Unblock");
  expect(html).toContain("ship &lt;b&gt;report&lt;/b&gt;");
  expect(html).not.toContain("Accept");
  const closed = renderCommitments([commitment({ status: "completed", actions: [] })]);
  expect(closed).not.toContain(">Start<");
  expect(closed).not.toContain("Draft follow-up");
  expect(renderCommitments([])).toContain("No commitments.");
});

test("cards carry a direction chip and the other person", () => {
  const owed = renderCommitments([commitment()]);
  expect(owed).toContain("Owed to you");
  expect(owed).toContain("syn-chip--blue");
  expect(owed).toContain("Ada");
  const owe = renderCommitments([
    commitment({ direction: "mine", counterpartyName: "Grace", dueAt: "2026-02-01T00:00:00.000Z" }),
  ]);
  expect(owe).toContain("You owe");
  expect(owe).toContain("syn-chip--amber");
  expect(owe).toContain("Grace");
  expect(owe).toContain("due ");
  expect(renderCommitments([commitment({ stalledAt: "2026-01-05T00:00:00.000Z" })])).toContain(
    "stalled",
  );
});

test("the review queue is decided in Needs you: a quiet line, no Accept/Reject here", () => {
  const queued = commitment({
    reviewStatus: "pending_review",
    actions: ["accept", "reject", "edit"],
  });
  const html = renderCommitments([], [queued, queued]);
  expect(html).toContain("2 waiting for your review in Needs you");
  expect(html).not.toContain("Review queue");
  for (const l of [">Accept<", ">Edit<", ">Reject<"]) expect(html).not.toContain(l);
  // The server computed no review actions: nothing to review.
  expect(renderCommitments([], [commitment()])).not.toContain("waiting for your review");
  expect(reviewCount([queued, commitment()])).toBe(1);
});

test("expired and live sources render", () => {
  const html = renderCommitments([
    commitment({
      sources: [
        { sourceExternalRef: "C1:1", messageAvailable: false, permalink: null },
        { sourceExternalRef: "C1:2", messageAvailable: true, permalink: "https://x.slack.com/a" },
      ],
    }),
  ]);
  expect(html).toContain("original message no longer available locally");
  expect(html).toContain('href="https://x.slack.com/a"');
});

test("proposal confirm and reject only with confirm_proposal", () => {
  const p = { updateId: "u1", sourceExternalRef: "C1:1", proposedAt: "2026-01-01T00:00:00.000Z" };
  const html = renderCommitments([
    commitment({ proposals: [p], actions: ["start", "confirm_proposal"] }),
  ]);
  expect(html).toContain("Confirm completed");
  expect(html).toContain("Reject proposal");
  expect(renderCommitments([commitment({ proposals: [p], actions: ["start"] })])).not.toContain(
    "Confirm completed",
  );
});
