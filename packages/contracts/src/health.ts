export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthReport {
  status: HealthStatus;
  checks: Record<string, { status: HealthStatus; detail?: string }>;
}
