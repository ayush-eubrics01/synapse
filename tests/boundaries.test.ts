import { expect, test } from "bun:test";
import { Glob } from "bun";
import { providerBoundaryViolations } from "./provider-boundary";

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

test("provider boundary scanner flags a planted violation and allows the orchestrator", () => {
  const exec = "const r = await this.provider.execute(req);";
  const imp = 'import { ClaudeCliProvider } from "../integrations/claude-code/cli-provider";';
  expect(providerBoundaryViolations("apps/api/src/modules/x/y.ts", exec)).toHaveLength(1);
  expect(providerBoundaryViolations("apps/api/src/workers/z.ts", imp)).toHaveLength(1);
  expect(providerBoundaryViolations("apps/api/src/core/orchestrator/o.ts", exec)).toEqual([]);
  expect(providerBoundaryViolations("apps/api/src/container.ts", imp)).toEqual([]);
  expect(providerBoundaryViolations("apps/api/src/workers/z.ts", "const a = 1;")).toEqual([]);
  expect(providerBoundaryViolations("apps\\api\\src\\core\\orchestrator\\o.ts", exec)).toEqual([]);
});

test.each([
  ["multi-line call", "this.provider\n  .execute(r)"],
  ["optional chaining", "this.provider?.execute(r)"],
  ["space before dot", "x.provider .execute(r)"],
  ["destructured", "const { provider } = d; provider.execute(r)"],
  ["export-from", 'export { ClaudeCliProvider } from "../integrations/claude-code/cli-provider";'],
  ["namespace import", 'import * as p from "../integrations/claude-code/cli-provider";'],
  ["dynamic import", 'const m = await import("../integrations/claude-code/cli-provider");'],
])("provider boundary scanner flags %s", (_name, src) => {
  expect(providerBoundaryViolations("apps/api/src/workers/z.ts", src).length).toBeGreaterThan(0);
});

test("provider boundary scanner covers scripts/", () => {
  expect(providerBoundaryViolations("scripts/dev/x.ts", "a.provider.execute(r)")).toHaveLength(1);
});

test("the scope smoke is the only script excepted, by its exact path", () => {
  const exec = "await provider.execute(r)";
  expect(providerBoundaryViolations("scripts/dev/scope-smoke.ts", exec)).toEqual([]);
  expect(providerBoundaryViolations("scripts/dev/scope-smoke.ts.bak", exec)).toHaveLength(1);
  expect(providerBoundaryViolations("scripts/dev/inspect-smoke.ts", exec)).toHaveLength(1);
  expect(providerBoundaryViolations("apps/api/src/scripts/dev/scope-smoke.ts", exec)).toHaveLength(
    1,
  );
});

test("only the orchestrator and container touch the AI provider", async () => {
  const offenders: string[] = [];
  for (const pattern of ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts", "scripts/**/*.ts"]) {
    for await (const file of new Glob(pattern).scan(".")) {
      const src = await Bun.file(file).text();
      if (providerBoundaryViolations(file, src).length > 0) offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
