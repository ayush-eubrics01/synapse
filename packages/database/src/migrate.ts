import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Db } from "./types";

const migrationsFolder = join(import.meta.dir, "../migrations");

/** `folder` is a test seam (an older copy of the migrations); production always uses the default. */
export function runMigrations(db: Db, folder: string = migrationsFolder): void {
  migrate(db, { migrationsFolder: folder });
}

/** sha256 of each journal entry: the same hashes `__drizzle_migrations` stores. */
export function knownMigrationHashes(): Set<string> {
  return new Set(readMigrationFiles({ migrationsFolder }).map((m) => m.hash));
}
