import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema/platform";
import type { Db } from "./types";

export function openDatabase(path: string): { sqlite: Database; db: Db } {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  // busy_timeout first: switching to WAL needs a lock and must wait, not fail, under contention.
  sqlite.run("PRAGMA busy_timeout = 5000");
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
