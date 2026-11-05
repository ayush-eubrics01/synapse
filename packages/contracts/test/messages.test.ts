import { expect, test } from "bun:test";
import { sourceMessageSchema } from "../src/index.ts";

const valid = {
  externalId: "C0123ABC:1793872884.123456",
  conversationId: "C0123ABC",
  conversationType: "channel",
  ts: "1793872884.123456",
  senderId: "U0123ABC",
  text: "hello",
  sentAt: "2026-11-05T10:00:00.000Z",
};

test("sourceMessageSchema accepts a valid message", () => {
  expect(sourceMessageSchema.parse(valid).externalId).toBe(valid.externalId);
});

test("sourceMessageSchema rejects bad sender, ts, conversation id, externalId", () => {
  expect(sourceMessageSchema.safeParse({ ...valid, senderId: "B0123" }).success).toBe(false);
  expect(sourceMessageSchema.safeParse({ ...valid, ts: "1793872884" }).success).toBe(false);
  expect(sourceMessageSchema.safeParse({ ...valid, conversationId: "X0123" }).success).toBe(false);
  expect(sourceMessageSchema.safeParse({ ...valid, externalId: "C0123ABC:1" }).success).toBe(false);
});
