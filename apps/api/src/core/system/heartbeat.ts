import { type Clock, isoNow } from "@synapse/shared";
import type { SettingsService } from "../config/settings";
import type { HandlerRegistration } from "../jobs/worker";

export const HEARTBEAT_SCHEDULE = {
  name: "system.heartbeat",
  jobType: "system.heartbeat",
  intervalSeconds: 60,
} as const;

export const heartbeatHandler = (settings: SettingsService, clock: Clock): HandlerRegistration => ({
  handler: async () => {
    settings.set("system.lastHeartbeatAt", isoNow(clock), { emit: false });
    return null;
  },
  timeoutMs: 10_000,
});
