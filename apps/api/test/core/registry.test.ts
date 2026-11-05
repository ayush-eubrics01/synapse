import { beforeEach, expect, test } from "bun:test";
import { openDatabase, runMigrations } from "@synapse/database";
import { ModuleRegistry } from "../../src/core/module-registry/registry";

let reg: ModuleRegistry;

beforeEach(() => {
  const { db } = openDatabase(":memory:");
  runMigrations(db);
  reg = new ModuleRegistry(db);
});

test("register persists modules and list returns them", () => {
  reg.register({ name: "b", version: "1.0.0", dependsOn: ["a"] });
  reg.register({ name: "a", version: "1.0.0", dependsOn: [] });
  reg.register({ name: "a", version: "1.1.0", dependsOn: [] });
  expect(reg.list()).toEqual([
    { name: "a", version: "1.1.0", enabled: true },
    { name: "b", version: "1.0.0", enabled: true },
  ]);
  expect(() => reg.validate()).not.toThrow();
});

test("missing dependency throws", () => {
  reg.register({ name: "a", version: "1", dependsOn: ["ghost"] });
  expect(() => reg.validate()).toThrow(/missing dependency/);
});

test("cycle throws, and re-registering replaces dependencies", () => {
  reg.register({ name: "a", version: "1", dependsOn: ["b"] });
  reg.register({ name: "b", version: "1", dependsOn: ["a"] });
  expect(() => reg.validate()).toThrow(/cycle/);
  reg.register({ name: "b", version: "1", dependsOn: [] });
  expect(() => reg.validate()).not.toThrow();
});
