import { expect, test } from "bun:test";
import { jobLabel } from "../lib/job-labels";

test("jobLabel names known job types and falls back to the raw type", () => {
  expect(jobLabel("system.heartbeat")).toBe("Heartbeat");
  expect(jobLabel("slack.collect_incremental")).toBe("Collect new Slack messages");
  expect(jobLabel("slack.backfill")).toBe("Slack backfill page");
  expect(jobLabel("commitments.check_stalled")).toBe("Check stalled commitments");
  expect(jobLabel("outgoing.verify")).toBe("Verify a sent message");
  expect(jobLabel("something.new")).toBe("something.new");
});
