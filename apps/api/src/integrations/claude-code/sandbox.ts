import { SANDBOX_MASKED_ROOTS, type SandboxSpec } from "@synapse/contracts";

/** The paths every sandboxed run masks after the request's `denyRead` (F1.2). */
export const SANDBOX_MASKS = SANDBOX_MASKED_ROOTS;

/**
 * Matches the startup refusal of a sandboxed run (`failIfUnavailable`), tested against the stderr
 * head and an error result's text; only the match is used. Phrases are taken from the strings in
 * the Claude Code 2.1.319 binary, not from a run with bubblewrap removed:
 * - stderr: "sandbox.failIfUnavailable is set — refusing to start without a working sandbox."
 * - message: "Sandbox required but unavailable[: <detail>]. Set sandbox.failIfUnavailable=false …"
 * plus a generic "sandbox … unavailable / not available / failed to start|initialise" on one line.
 * A bare mention of the sandbox (a `<sandbox_violations>` notice, "denied by sandbox") does not
 * match. Wording may change between CLI versions: a miss is reported as an ordinary failure, and
 * the CLI's `startup_failure_reason` code is checked as well (SANDBOX_STARTUP_FAILURE_REASON).
 */
export const SANDBOX_FAILURE_RE =
  /sandbox\.failIfUnavailable|without a working sandbox|sandbox[^\n]{0,80}?\b(unavailable|not available|failed to (start|initiali[sz]e))/i;

/** The CLI's `startup_failure_reason` on the result event when the sandbox cannot start. */
export const SANDBOX_STARTUP_FAILURE_REASON = "sandbox_required_unavailable";

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
