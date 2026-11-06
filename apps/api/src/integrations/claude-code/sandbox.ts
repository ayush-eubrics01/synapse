import { SANDBOX_MASKED_ROOTS, type SandboxSpec } from "@synapse/contracts";

/** The paths every sandboxed run masks after the request's `denyRead` (F1.2). */
export const SANDBOX_MASKS = SANDBOX_MASKED_ROOTS;

/**
 * Matches a sandboxed run that failed because the sandbox could not start (`failIfUnavailable`):
 * tested against the first stderr bytes, or an error result's text. Only the match is used.
 */
export const SANDBOX_FAILURE_RE = /sandbox/i;

/**
 * The `sandbox` settings for a develop run (ADR-040, F1.2), validated on the real CLI: no network,
 * no unsandboxed escape, `denyRead` followed by the fixed masks, only `tmpDir` re-allowed.
 * `allowAllUnixSockets` is required on Ubuntu's user-namespace restriction; the `/run`,
 * `/var/run` and `/tmp` masks are what hide the sockets. Pure: `spec` is never mutated.
 */
export function buildSandboxSettings(spec: SandboxSpec): { sandbox: Record<string, unknown> } {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        denyRead: [...spec.denyRead, ...SANDBOX_MASKS],
        allowRead: [spec.tmpDir],
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        strictAllowlist: true,
        allowAllUnixSockets: true,
      },
    },
  };
}

/**
 * `override` (a `--settings` JSON object: plugins and hooks disabled, maybe a send guard) with
 * its `sandbox` key replaced by `buildSandboxSettings(spec)`. Throws for anything that is not a
 * JSON object, so the caller can fail closed.
 */
export function withSandboxSettings(override: string, spec: SandboxSpec): string {
  const parsed: unknown = JSON.parse(override);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("sandbox: settings override is not an object");
  }
  return JSON.stringify({ ...parsed, ...buildSandboxSettings(spec) });
}
