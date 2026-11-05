import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { Db } from "./types";

const migrationsFolder = join(import.meta.dir, "../migrations");

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder });
}
