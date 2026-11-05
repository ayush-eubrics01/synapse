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
});

test("only the orchestrator and container touch the AI provider", async () => {
  const offenders: string[] = [];
  for (const pattern of ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"]) {
    for await (const file of new Glob(pattern).scan(".")) {
      const src = await Bun.file(file).text();
      if (providerBoundaryViolations(file, src).length > 0) offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
