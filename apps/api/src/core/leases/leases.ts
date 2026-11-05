import { type Db, schema } from "@synapse/database";
import type { Clock } from "@synapse/shared";
import { and, eq, lte, sql } from "drizzle-orm";

export interface Lease {
  name: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

const { leases } = schema;

export class LeaseService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Succeeds if there is no row, the holder is the same, or the row is expired (takeover). */
  acquire(name: string, holder: string, ttlMs: number): boolean {
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + ttlMs).toISOString();
    const rows = this.db
      .insert(leases)
      .values({ name, holder, acquiredAt: now, expiresAt, heartbeatAt: now })
      .onConflictDoUpdate({
        target: leases.name,
        set: {
          holder,
          acquiredAt: sql`CASE WHEN ${leases.holder} = ${holder} THEN ${leases.acquiredAt} ELSE ${now} END`,
          expiresAt,
          heartbeatAt: now,
        },
        setWhere: sql`${leases.holder} = ${holder} OR ${leases.expiresAt} <= ${now}`,
      })
      .returning({ name: leases.name })
      .all();
    return rows.length > 0;
  }

  /** Only the current holder may renew, and only while the lease has not expired. */
  renew(name: string, holder: string, ttlMs: number): boolean {
    const nowDate = this.clock.now();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + ttlMs).toISOString();
    const rows = this.db
      .update(leases)
      .set({ expiresAt, heartbeatAt: now })
      .where(
        and(eq(leases.name, name), eq(leases.holder, holder), sql`${leases.expiresAt} > ${now}`),
      )
      .returning({ name: leases.name })
      .all();
    return rows.length > 0;
  }

  release(name: string, holder: string): boolean {
    const rows = this.db
      .delete(leases)
      .where(and(eq(leases.name, name), eq(leases.holder, holder)))
      .returning({ name: leases.name })
      .all();
    return rows.length > 0;
  }

  get(name: string): Lease | null {
    return this.db.select().from(leases).where(eq(leases.name, name)).get() ?? null;
  }

  listExpired(): Lease[] {
    const now = this.clock.now().toISOString();
    return this.db.select().from(leases).where(lte(leases.expiresAt, now)).all();
  }
}
