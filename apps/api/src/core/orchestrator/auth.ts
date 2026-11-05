import { readFileSync } from "node:fs";
import { type Db, schema } from "@synapse/database";
import { type Clock, isoNow, newId } from "@synapse/shared";
import { asc, desc, sql } from "drizzle-orm";
import type { SettingsService } from "../config/settings";
import type { EventPublisher } from "../events/publisher";

const HOUR_MS = 3_600_000;
const WARN_DEDUPE_MS = 24 * HOUR_MS;

export type AuthExpiry = { accessExpiresAt: string; refreshExpiresAt: string };

function toIso(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Reads ONLY claudeAiOauth.expiresAt and claudeAiOauth.refreshTokenExpiresAt (ms epoch).
 * Errors are generic: never any file content, never a parser message (it can quote input).
 */
export function readAuthExpiry(path: string): AuthExpiry | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { error: "credentials file unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "credentials file malformed" };
  }
  const oauth =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
      : undefined;
  if (typeof oauth !== "object" || oauth === null) {
    return { error: "credentials expiry fields missing" };
  }
  const o = oauth as { expiresAt?: unknown; refreshTokenExpiresAt?: unknown };
  const accessExpiresAt = toIso(o.expiresAt);
  const refreshExpiresAt = toIso(o.refreshTokenExpiresAt);
  if (accessExpiresAt === null || refreshExpiresAt === null) {
    return { error: "credentials expiry fields missing" };
  }
  return { accessExpiresAt, refreshExpiresAt };
}

export interface AuthStatus {
  refreshExpiresAt: string | null;
  slides: boolean | null;
  /** Generic message from the most recent unreadable record(), else null. */
  readError: string | null;
}

export class AuthMonitor {
  private readError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly events: EventPublisher,
    private readonly credentialsPath: string,
  ) {}

  record(claudeRunId?: string): void {
    const exp = readAuthExpiry(this.credentialsPath);
    if ("error" in exp) {
      this.readError = exp.error;
      return;
    }
    this.readError = null;
    const now = this.clock.now();
    const nowIso = isoNow(this.clock);
    const warnWithinMs = this.settings.get("health.authExpiryWarningHours") * HOUR_MS;
    const last = this.settings.get("auth.lastExpiryWarningAt");
    const due =
      Date.parse(exp.refreshExpiresAt) - now.getTime() < warnWithinMs &&
      (last === null || now.getTime() - Date.parse(last) >= WARN_DEDUPE_MS);

    this.db.transaction(
      (tx) => {
        tx.insert(schema.authSnapshots)
          .values({
            id: newId(),
            observedAt: nowIso,
            accessExpiresAt: exp.accessExpiresAt,
            refreshExpiresAt: exp.refreshExpiresAt,
            claudeRunId: claudeRunId ?? null,
          })
          .run();
        if (due) {
          this.events.publish(tx, {
            type: "auth.expiry_warning",
            aggregateType: "auth",
            aggregateId: "claude",
            correlationId: newId(),
            payload: { refreshExpiresAt: exp.refreshExpiresAt },
          });
        }
      },
      { behavior: "immediate" },
    );
    if (due) this.settings.set("auth.lastExpiryWarningAt", nowIso, { emit: false });
  }

  status(): AuthStatus {
    const latest = this.db
      .select({ refresh: schema.authSnapshots.refreshExpiresAt })
      .from(schema.authSnapshots)
      .orderBy(desc(schema.authSnapshots.observedAt), sql`rowid desc`)
      .limit(1)
      .get();
    const all = this.db
      .select({ refresh: schema.authSnapshots.refreshExpiresAt })
      .from(schema.authSnapshots)
      .orderBy(asc(schema.authSnapshots.observedAt), sql`rowid asc`)
      .all();
    let slides: boolean | null = null;
    const first = all[0]?.refresh;
    if (first && all.length > 1) {
      slides = all.some((r) => r.refresh !== null && Date.parse(r.refresh) > Date.parse(first));
    }
    return { refreshExpiresAt: latest?.refresh ?? null, slides, readError: this.readError };
  }
}
