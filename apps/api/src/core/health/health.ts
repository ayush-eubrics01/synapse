import type { HealthReport, HealthStatus } from "@synapse/contracts";

export type HealthCheck = () => Promise<{ status: HealthStatus; detail?: string }>;

const RANK: Record<HealthStatus, number> = { ok: 0, degraded: 1, down: 2 };

export class HealthService {
  constructor(private readonly checks: Record<string, HealthCheck>) {}

  async report(): Promise<HealthReport> {
    const entries = await Promise.all(
      Object.entries(this.checks).map(async ([name, check]) => {
        try {
          return [name, await check()] as const;
        } catch (e) {
          return [
            name,
            { status: "down", detail: e instanceof Error ? e.message : String(e) },
          ] as const;
        }
      }),
    );
    const checks: HealthReport["checks"] = Object.fromEntries(entries);
    let status: HealthStatus = "ok";
    for (const c of Object.values(checks)) if (RANK[c.status] > RANK[status]) status = c.status;
    return { status, checks };
  }
}
