import { openDatabase } from "@synapse/database";

// Holds the write lock briefly, then commits: simulates another connection writing mid-transaction.
const [dbPath] = process.argv.slice(2);
if (!dbPath) throw new Error("usage: hold-lock.ts <dbPath>");
const { sqlite } = openDatabase(dbPath);
sqlite.run("BEGIN IMMEDIATE");
sqlite.run(
  "INSERT INTO app_settings (key, value, updated_at) VALUES ('x', '1', '2026-01-01T00:00:00.000Z')",
);
console.log("locked");
await Bun.sleep(300);
sqlite.run("COMMIT");
