import type { Database } from "bun:sqlite";
import { type Clock, isoNow } from "@synapse/shared";

/** `PRAGMA quick_check` with the last result remembered for the `database` health check. */
export class DatabaseIntegrity {
  private latest: { result: "ok" | "failed"; at: string } | null = null;

  constructor(
    private readonly sqlite: Database,
    private readonly clock: Clock,
  ) {}

  /** `ok` only when quick_check returns exactly one row, `ok`. Never throws. */
  check(): "ok" | "failed" {
    let result: "ok" | "failed";
    try {
      const rows = this.sqlite.query("pragma quick_check").all() as { quick_check: string }[];
      result = rows.length === 1 && rows[0]?.quick_check === "ok" ? "ok" : "failed";
    } catch {
      result = "failed";
    }
    this.latest = { result, at: isoNow(this.clock) };
    return result;
  }

  last(): { result: "ok" | "failed"; at: string } | null {
    return this.latest;
  }
}
