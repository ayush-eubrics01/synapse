import { expect, test } from "bun:test";
import { eventCatalog } from "@synapse/contracts";
import { LIVE_EVENT_TYPES } from "../lib/live-events";

test("dashboard listens to every published live type", () => {
  // system.heartbeat is in the catalog but never published (the heartbeat job writes a setting).
  const published = Object.keys(eventCatalog).filter((t) => t !== "system.heartbeat");
  expect([...LIVE_EVENT_TYPES].sort() as string[]).toEqual(
    [...published, "job.updated", "notification"].sort(),
  );
});
