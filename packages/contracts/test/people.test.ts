import { expect, test } from "bun:test";
import {
  initialProfileOutputSchema,
  observationSchema,
  parseEventPayload,
  profileContentSchema,
  profileUpdateOutputSchema,
  unknownAssessmentOutputSchema,
} from "../src/index.ts";

const obs = {
  key: "prefers.async",
  text: "Prefers async updates",
  evidence: ["m1"],
  confidence: "high",
};
const content = { professionalContext: [obs], communication: [], responseGuidelines: [] };
const noInjection = { detected: false, severity: "info", quote: "", reason: "" };

test("profileContentSchema rejects a priority key at root and inside an observation", () => {
  expect(profileContentSchema.safeParse(content).success).toBe(true);
  expect(profileContentSchema.safeParse({ ...content, priority: "high" }).success).toBe(false);
  expect(
    profileContentSchema.safeParse({
      ...content,
      communication: [{ ...obs, priority: "high" }],
    }).success,
  ).toBe(false);
});

test("observationSchema requires evidence and a valid key", () => {
  expect(observationSchema.safeParse({ ...obs, evidence: [] }).success).toBe(false);
  expect(observationSchema.safeParse({ ...obs, key: "Bad Key" }).success).toBe(false);
});

test("output schemas are strict and carry suspectedInjection", () => {
  expect(
    initialProfileOutputSchema.safeParse({ profile: content, suspectedInjection: noInjection })
      .success,
  ).toBe(true);
  expect(
    initialProfileOutputSchema.safeParse({
      profile: content,
      suspectedInjection: noInjection,
      priority: "high",
    }).success,
  ).toBe(false);
  expect(
    profileUpdateOutputSchema.safeParse({
      add: [{ ...obs, section: "communication" }],
      remove: [{ section: "communication", key: "old", evidence: ["m2"] }],
      suspectedInjection: noInjection,
    }).success,
  ).toBe(true);
  expect(
    unknownAssessmentOutputSchema.safeParse({
      assessments: [{ slackUserId: "U1", worthProfile: true, reason: "frequent" }],
      suspectedInjection: noInjection,
    }).success,
  ).toBe(true);
  expect(
    unknownAssessmentOutputSchema.safeParse({ assessments: [], suspectedInjection: noInjection })
      .success,
  ).toBe(false);
});

test("people event payloads parse", () => {
  expect(parseEventPayload("person.discovered", { slackUserId: "U1" })).toBeDefined();
  expect(
    parseEventPayload("person.profile_recommendation_created", {
      recommendationId: "r",
      personId: "p",
      kind: "initial",
    }),
  ).toBeDefined();
  expect(parseEventPayload("person.profile_approved", { personId: "p", version: 1 })).toBeDefined();
  expect(
    parseEventPayload("person.recommendation_decided", {
      recommendationId: "r",
      status: "applied",
    }),
  ).toBeDefined();
  expect(() => parseEventPayload("person.discovered", {})).toThrow();
});
