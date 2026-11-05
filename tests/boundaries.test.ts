import { expect, test } from "bun:test";
import { Glob } from "bun";

test("modules never import integrations or infrastructure", async () => {
  const offenders: string[] = [];
  for await (const file of new Glob("apps/api/src/modules/**/*.ts").scan(".")) {
    const src = await Bun.file(file).text();
    if (/from\s+["'][^"']*\/(integrations|infrastructure)\//.test(src)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("workspace packages resolve", async () => {
  expect((await import("@synapse/shared")).systemClock).toBeDefined();
});
