import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "../src/index.ts";

function setup() {
  const { db, sqlite } = openDatabase(join(mkdtempSync(join(tmpdir(), "syn-")), "synapse.db"));
  runMigrations(db);
  return sqlite;
}
const LAYOUT = JSON.stringify({
  version: 1,
  sections: [{ id: "triage", visible: true, collapsed: false, width: "half" }],
});
const ins = (sqlite: ReturnType<typeof setup>, id: string, name: string, active: number) =>
  sqlite.run(
    "insert into dashboard_layouts (id, name, is_active, layout, created_at, updated_at) values (?,?,?,?,?,?)",
    [id, name, active, LAYOUT, "t", "t"],
  );

test("0021 applies on a fresh database", () => {
  const sqlite = setup();
  const cols = sqlite.query("pragma table_info(dashboard_layouts)").all() as { name: string }[];
  expect(cols.map((c) => c.name).sort()).toEqual(
    ["created_at", "id", "is_active", "layout", "name", "updated_at"].sort(),
  );
});

test("only one active layout; inactive rows coexist", () => {
  const sqlite = setup();
  ins(sqlite, "l1", "Default", 1);
  expect(() => ins(sqlite, "l2", "Focus", 1)).toThrow();
  ins(sqlite, "l3", "Focus", 0);
  ins(sqlite, "l4", "Review", 0);
});

test("layout names are unique case-insensitively", () => {
  const sqlite = setup();
  ins(sqlite, "l1", "Focus", 0);
  expect(() => ins(sqlite, "l2", "focus", 0)).toThrow();
});

test("the layout json column round-trips", () => {
  const sqlite = setup();
  ins(sqlite, "l1", "Default", 1);
  const row = sqlite.query("select layout from dashboard_layouts where id = 'l1'").get() as {
    layout: string;
  };
  expect(JSON.parse(row.layout).sections[0].id).toBe("triage");
});
