import { describe, expect, test } from "bun:test";
import type { CommitmentCandidate } from "@synapse/contracts";
import { type BatchMessage, validateCandidates } from "../../src/intelligence/commitments/validate";

const SELF = "USELF00001";
const PARTNER = "UPART00001";
const OTHER = "UOTHR00001";
const AT = "2026-11-05T10:00:00.000Z";

const msg = (
  id: string,
  authorRef: string,
  dmPartner: string | null,
  text = "x",
): BatchMessage => ({
  messageId: id,
  authorRef,
  sentAt: AT,
  text,
  conversationId: dmPartner ? "conv-dm" : "conv-ch",
  sourceRef: `D1:${id}`,
  dmPartner,
});

const cand = (over: Partial<CommitmentCandidate>): CommitmentCandidate => ({
  description: "Send the report",
  owner: PARTNER,
  counterparty: null,
  dueAt: null,
  evidence: ["m1"],
  kind: "promise",
  confidence: "high",
  ...over,
});

describe("validateCandidates in a 1:1 DM", () => {
  test("the partner's promise with no counterparty is owed to the user", () => {
    const { valid } = validateCandidates([cand({})], [msg("m1", PARTNER, PARTNER)], SELF);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({ owner: PARTNER, counterparty: SELF });
  });

  test("the user is an owner only when they wrote a cited message", () => {
    const { valid } = validateCandidates(
      [cand({ owner: SELF, counterparty: PARTNER })],
      [msg("m1", PARTNER, PARTNER)],
      SELF,
    );
    expect(valid).toHaveLength(0);
  });

  test("the user's promise with no counterparty is owed to the partner", () => {
    const { valid } = validateCandidates([cand({ owner: SELF })], [msg("m1", SELF, PARTNER)], SELF);
    expect(valid[0]).toMatchObject({ owner: SELF, counterparty: PARTNER });
  });

  test("the user counts as a DM participant without writing a cited message", () => {
    const { valid } = validateCandidates(
      [cand({ counterparty: SELF })],
      [msg("m1", PARTNER, PARTNER)],
      SELF,
    );
    expect(valid[0]).toMatchObject({ owner: PARTNER, counterparty: SELF });
  });

  test("a third person is still not a participant of the DM", () => {
    const { valid, dropped } = validateCandidates(
      [cand({ owner: OTHER, counterparty: SELF })],
      [msg("m1", PARTNER, PARTNER)],
      SELF,
    );
    expect(valid).toHaveLength(0);
    expect(dropped).toBe(1);
  });
});

describe("validateCandidates in a channel", () => {
  test("no counterparty is inferred, so a colleague's promise to no one is dropped", () => {
    const { valid } = validateCandidates([cand({})], [msg("m1", PARTNER, null)], SELF);
    expect(valid).toHaveLength(0);
  });

  test("the user is not a participant unless they wrote or are mentioned", () => {
    const { valid: none } = validateCandidates(
      [cand({ counterparty: SELF })],
      [msg("m1", PARTNER, null)],
      SELF,
    );
    expect(none).toHaveLength(0);
    const { valid: mentioned } = validateCandidates(
      [cand({ counterparty: SELF })],
      [msg("m1", PARTNER, null, `<@${SELF}> I will send it`)],
      SELF,
    );
    expect(mentioned).toHaveLength(1);
  });
});
