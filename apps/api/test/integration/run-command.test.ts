import { expect, test } from "bun:test";
import { CommandTimeoutError, runCommand } from "../../src/infrastructure/run-command";

test("runCommand returns stdout", async () => {
  expect(await runCommand(["echo", "hi"])).toBe("hi\n");
});

test("runCommand kills a slow child at the timeout", async () => {
  const t0 = Date.now();
  await expect(runCommand(["sleep", "5"], { timeoutMs: 50 })).rejects.toBeInstanceOf(
    CommandTimeoutError,
  );
  expect(Date.now() - t0).toBeLessThan(1000);
});
