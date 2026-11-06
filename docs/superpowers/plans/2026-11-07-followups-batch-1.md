# Follow-ups Batch 1: Sandboxed Test Runs and Engineering Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Develop runs execute the repository's test command inside the Claude Code sandbox (no network, writes only inside the repository, credentials and sockets masked), and refuse to run without it. The user can edit the commit message and PR text before approving, choose a repository when a proposal is ambiguous, and re-request a PR merge after failing checks. Two code-answer safety gaps close.

**Architecture:**
- **F1 (ADR-040):**
  - `AIExecutionRequest` and `ClaudeJobRequest` carry an optional `sandbox: SandboxSpec`. Validator rule M makes it mandatory for any engineering run that grants Bash and forbids it elsewhere.
  - The develop request builder fills `sandbox` from the `engineering.sandbox.enabled` setting. The step worker owns a per-run scratch dir and removes it afterwards.
  - `ClaudeCliProvider` merges the pure `buildSandboxSettings` output into `--settings`, creates `tmpDir` (0700) and sets `TMPDIR`. It reports a sandbox that fails at startup as `details.sandboxUnavailable`, and the step runner maps that to `sandbox_unavailable`.
  - New health checks `sandbox` and `claude_settings`.
- **F2/F3:**
  - `EngineeringStepService` gains `editApprovalText` (over a new `ApprovalEngine.updatePendingPayload`) and `retryMerge`, behind two routes in `routes/engineering.ts`.
  - The web gets editable commit and push cards, a repository picker and a "Check again" button.
- **F4:**
  - `OutgoingService.autoSendBlock` gains a code-answer `autoSend` block, which returns the code-answer row to `held` through a callback.
  - `HandlerRegistration.timeoutMs` may be a function that is resolved when the job starts.
- No migration, no new npm dependency. bubblewrap and socat are system packages, recorded in ADR-040.

**Tech Stack:** Bun 1.4.4, TypeScript strict, Hono, bun:sqlite + Drizzle, Zod 4, Next.js 16 (`renderToString` tests), `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-07-followups-batch-1.md` (F1.1–F1.7, F2.1–F2.2, F3.1–F3.3, F4.1–F4.2). It is the binding authority, together with ADR-030, ADR-033, ADR-035, `docs/modules/engineering-tasks.md` and the three follow-ups files it names. The F1 sandbox profile was validated on the real CLI. Its settings JSON, masks, TMPDIR approach and rule M are copied here verbatim and must not be changed.

## Global Constraints

- **Tests never run real `claude`, `gh`, `bwrap` or `socat`.**
  - Provider tests use `apps/api/test/fixtures/fake-claude.ts`, and the e2e test uses `engineering-fake-claude.ts`.
  - Health tests inject `which`.
  - Every path a test writes comes from `mkdtempSync(join(tmpdir(), "syn-"))`.
  - Pure functions take placeholder strings such as `/home/u`, `/home/u/projects/demo` and `/home/u/.local/share/synapse`.
- **Never run `scripts/dev/develop-smoke.ts` while implementing.** The controller runs it once after Task 4, and implementers only run its unit test.
- **Placeholder data only:** repository `demo`, branches `main`/`stage`, Slack ids `U0PLACE`, the commit text `Fix add`. Audit `details`, events, logs and error bodies hold ids, counts, field names and fixed codes, and never commit or PR text, paths or stderr. Every API error body is `{ error: "<fixed_code>" }`.
- **Exact sandbox settings** (F1.2). `buildSandboxSettings` returns exactly this, where `denyRead` is the request's list followed by the three masks:
  `{ sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, excludedCommands: [], filesystem: { denyRead: [...denyRead, "/run", "/var/run", "/tmp"], allowRead: [tmpDir] }, network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true, allowAllUnixSockets: true } } }`
  The child env gets `TMPDIR=<tmpDir>`, and `tmpDir` is created with mode `0700` before the spawn.
- **Exact home deny list** (F1.3), relative to `$HOME`: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config`, `.claude`, `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`, `.cargo/credentials`, `.cargo/credentials.toml`. The Synapse data dir and the backup dir are added to it. An entry is kept only when it is not the repository and does not contain it.
- **Exact copy:**
  - rule M reason: `engineering Bash requires the sandbox`;
  - sandbox hint (task reason `sandbox_unavailable` and health hint `sandbox`): "Install bubblewrap and socat (sudo apt install bubblewrap socat), then cancel this task and propose it again.";
  - plan card when on: "Tests run in a sandbox: no network, writes only inside the repository";
  - plan card when off and task reason `sandbox_disabled`: "Develop runs are disabled: the test sandbox is turned off";
  - `claude_settings` hint: "Your ~/.claude/settings.json allows tools Synapse must control; engineering and code-answer runs are refused until those allow entries are removed and the API is restarted";
  - Needs-you button: "Check again".
- **Exact limits and codes** (F2.1, F3.2):
  - text limits: commitMessage 1–5000 characters with a first line of at most 200; prTitle 1–200 with no newline; prBody at most 20000. "Characters" means code points (`[...s].length`).
  - codes: 409 `not_pending`, 400 `invalid_text`, 409 `checks_failing`. Plan-chosen codes are listed in the tasks.
- **CLAUDE.md rules.**
  - Rule 1: the provider is only reached through the orchestrator.
  - Rule 2: the edit route changes only a `pending` payload, and the executors and revalidation are unchanged.
  - Rule 6: the web renders what the API returns. Client-side text checks only enable or disable Save, and the API decides.
  - Rule 8: no schema change, so no migration.
  - Rule 10: no new npm dependency.
- **Health statuses are `ok | degraded | down`.** A disabled feature reads `ok` with detail `"disabled"` (A8 style).
- **Checks stay green.** Each task ends with `bun run check` passing. Web tasks also pass `bun run --cwd apps/web build`.

## Review Focus

1. **A repository inside, or equal to, a would-be masked path.** Examples: a repo under `~/.docker/…`, or a data dir that contains the repo (the in-memory container's scratch, the smoke). Masking it would hide the code under test. The entry is dropped from `denyRead` and the others stay. Test in Task 1.
2. **Edited text that git or argv cannot take.** This covers a whitespace-only commit message or first line, a NUL, `\r` or other control character, and a title with a newline. Expect 400 `invalid_text` with the payload unchanged, never a commit that fails later. Test in Task 5.
3. **An edit racing a decision.** One case is Save arriving after Approve (the approval is `approved`). The other is a card left open after the task moved on. Expect 409 `not_pending` and an unchanged payload. On the web, Approve with an unsaved edit saves first, and a failed save does not approve. Tests in Tasks 5 and 6.
4. **Retry-merge after the PR changed on GitHub.** This covers a head that moved, a PR that was closed or merged by hand, and gh failing. Expect a fixed 409 (`pr_head_moved`, `state_changed`, `pr_status_failed`), the task still `needs_attention`, and no approval created. Test in Task 5.
5. **A develop run that throws, times out or is aborted.** The per-run scratch dir (`<scratch>/runs/<jobId>`) is removed anyway, so the data dir does not fill with stale `tmp` dirs. Test in Task 1.

---

### Task 1: Sandbox contract, validator rule M, the develop request and ADR-040

**Files:**
- Create:
  - `docs/decisions/ADR/ADR-040-sandboxed-test-commands.md`;
  - `apps/api/test/intelligence/develop-prompt.test.ts`.
- Modify:
  - `packages/contracts/src/ai.ts`;
  - `apps/api/src/core/orchestrator/validator.ts`;
  - `apps/api/src/core/orchestrator/orchestrator.ts` (copy `sandbox` into `execReq`);
  - `apps/api/src/intelligence/engineering/develop-prompt.ts`;
  - `apps/api/src/workers/engineering/steps.ts`;
  - `apps/api/src/core/config/settings.ts`;
  - `apps/api/src/container.ts` (move `registerStepJob` below the `backupDir` computation and pass `sandbox`);
  - `docs/decisions/README.md` (ADR-040 row).
- Test:
  - `packages/contracts/test/ai.test.ts`;
  - `apps/api/test/orchestrator/validator.test.ts`;
  - `apps/api/test/orchestrator/orchestrator.test.ts`;
  - `apps/api/test/workers/engineering-steps.test.ts`;
  - `apps/api/test/routes/settings.test.ts`.

**Interfaces:**
- Produces in `ai.ts`:
  - `interface SandboxSpec { tmpDir: string; denyRead: string[] }`;
  - `sandbox?: SandboxSpec` on both `ClaudeJobRequest` and `AIExecutionRequest`;
  - `sandboxSpecSchema = z.strictObject({ tmpDir: z.string().min(1), denyRead: z.array(z.string().min(1)).max(64) })`;
  - `claudeJobRequestSchema` gains `sandbox: sandboxSpecSchema.optional()`.
- Produces in `validator.ts`: `export const SANDBOX_REQUIRED_REASON = "engineering Bash requires the sandbox"`, plus **rule M**, run last after L:
  - engineering with any raw allowed tool whose `normalizeTool` is `Bash` and no `sandbox` → `SANDBOX_REQUIRED_REASON`;
  - a non-engineering profile carrying `sandbox` → `"sandbox is for engineering runs only"`;
  - `tmpDir` or any `denyRead` entry failing `isSafeAbsolutePath` → `"sandbox paths must be absolute paths of safe characters"`;
  - (plan addition) `tmpDir` equal to, or an ancestor of, a `denyRead` entry → `"sandbox tmpDir must not contain a masked path"`. Otherwise `allowRead` would re-expose that entry.
  Update the rule-order doc comment.
- Produces in `develop-prompt.ts`:
  - `SANDBOX_HOME_DENY: readonly string[]`, the Global Constraints list in that order;
  - `sandboxDenyRead(home: string, protectedDirs: readonly string[], repoRoot: string): string[]`. It returns `join(home, rel)` for each list entry, then `protectedDirs`. It drops an entry `e` when `repoRoot === e || repoRoot.startsWith(e + "/")`, after stripping trailing slashes, and de-duplicates in first-seen order. Pure.
  - `interface DevelopSandbox { tmpDir: string; home: string; protectedDirs: string[] }`;
  - `DevelopSettings` gains `sandbox: DevelopSandbox | null`.
  - `buildDevelopRequest` sets `sandbox: { tmpDir, denyRead: sandboxDenyRead(home, protectedDirs, root) }` when `s.sandbox` is non-null, and omits the key when it is null.
- Produces in `workers/engineering/steps.ts`: `StepJobDeps.sandbox: { scratchDir: string; home: string; protectedDirs: string[] }`. The develop `run` closure works like this:
  - `runScratch = join(scratchDir, "runs", job.id)`;
  - `tmpDir = join(runScratch, "tmp")`;
  - the sandbox is non-null only while `settings.get("engineering.sandbox.enabled")` is true;
  - `rmSync(runScratch, { recursive: true, force: true })` runs in a `finally`.
- Produces in `settings.ts`: `"engineering.sandbox.enabled": z.boolean().default(true)`, appended to `USER_EDITABLE_SETTINGS`.
- Container: `sandbox: { scratchDir, home, protectedDirs: [dataDir, backupDir] }`.

- [ ] **Step 1: Write the failing tests.**
  - Contracts:
    - `claudeJobRequestSchema` accepts `sandbox: { tmpDir: "/home/u/s/runs/j1/tmp", denyRead: ["/home/u/.ssh"] }`;
    - it rejects an extra key inside `sandbox`, `denyRead: "x"` and 65 entries.
  - Validator, with `make()` extended:
    - engineering `allowed: [...scoped file tools, "Bash(bun test:*)"]` and no sandbox → `{ ok: false, reason: SANDBOX_REQUIRED_REASON }`;
    - the same with `sandbox: { tmpDir: "/home/u/.local/share/synapse/scratch/runs/j1/tmp", denyRead: ["/home/u/.ssh", "/home/u/.local/share/synapse"] }` → ok;
    - engineering without Bash and without sandbox (an investigation) → ok;
    - a collector carrying a sandbox → "sandbox is for engineering runs only";
    - `tmpDir: "/tmp"` → the safe-paths reason;
    - `denyRead: ["/home/u/../x"]` → the safe-paths reason;
    - `tmpDir: "/home/u"` with `denyRead: ["/home/u/.ssh"]` → "sandbox tmpDir must not contain a masked path".
    - Update every existing engineering Bash case in this file to carry a valid sandbox.
  - Orchestrator:
    - a job request with `sandbox` reaches `provider.execute` with it deep-equal;
    - an engineering Bash request without it throws `JobError` `invalid_input` with message `SANDBOX_REQUIRED_REASON`, audits `claude.request_rejected`, and never calls the provider.
  - `develop-prompt.test.ts`:
    - `sandboxDenyRead("/home/u", ["/home/u/.local/share/synapse", "/home/u/.local/share/synapse-backups"], "/home/u/projects/demo")` equals the 14 home entries then the 2 dirs, in order.
    - Review Focus 1: repo `/home/u/.docker/demo` drops only `/home/u/.docker`. Repo equal to `/home/u/.local/share/synapse` drops that entry. A trailing slash on `home` gives the same result.
    - `buildDevelopRequest(..., { ...s, sandbox: null })` has no `sandbox` key.
    - With a sandbox, `sandbox.tmpDir` is the given one.
  - Worker (`engineering-steps.test.ts`, fake orchestrator):
    - the captured develop request's `sandbox.tmpDir` is `join(scratch, "runs", <job.id>, "tmp")`;
    - with `engineering.sandbox.enabled = false` the request has no `sandbox`.
    - Review Focus 5: the fake orchestrator `mkdirSync(tmpDir, { recursive: true })`s and then (a) returns, (b) throws a `JobError` `timeout`. Afterwards `existsSync(join(scratch, "runs", <job.id>))` is false in both cases.
  - Settings:
    - `GET /api/settings` includes `"engineering.sandbox.enabled": true`;
    - `PUT {"engineering.sandbox.enabled": false}` → 200;
    - `PUT {"engineering.sandbox.enabled": "no"}` → 400 `invalid_setting`.
- [ ] **Step 2: Run** `bun test packages/contracts apps/api/test/orchestrator apps/api/test/intelligence/develop-prompt.test.ts apps/api/test/workers/engineering-steps.test.ts apps/api/test/routes/settings.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
  - ADR-040 uses the ADR-039 format: Status Accepted, Date 2026-11-07, Source F1.
  - **Context:** security-model §3.1 and the spec's real-CLI findings.
  - **Decision table:** the exact settings, the masks and why each is mandatory, TMPDIR, rule M, "setting off means no develop runs, never an unsandboxed one", `sandbox_unavailable`, and the `sandbox` health check.
  - **Consequences:** bubblewrap and socat become system prerequisites for develop runs; tests that need the network cannot use develop runs; the seccomp layer is skipped (`allowAllUnixSockets`), so the masks carry the socket isolation; files outside the masks stay readable and can only leave through the diff and test output the user sees.
  - Add the README row.
- [ ] **Step 4: Run** `bun run check`. Expect PASS. The e2e test still passes, because the develop request now carries a sandbox.
- [ ] **Step 5: Commit:** `feat(engineering): sandbox contract, validator rule M and the sandboxed develop request (ADR-040)`.

### Task 2: The provider applies the sandbox

**Files:**
- Create:
  - `apps/api/src/integrations/claude-code/sandbox.ts`;
  - `apps/api/test/integrations/sandbox.test.ts`.
- Modify:
  - `apps/api/src/integrations/claude-code/cli-provider.ts`;
  - `apps/api/src/integrations/claude-code/settings-override.ts`;
  - `apps/api/src/core/orchestrator/orchestrator.ts` (`classify`);
  - `apps/api/test/fixtures/fake-claude.ts`;
  - `apps/api/test/fixtures/engineering-fake-claude.ts`.
- Test:
  - `apps/api/test/integrations/cli-provider.test.ts`;
  - `apps/api/test/integrations/settings-override.test.ts`;
  - `apps/api/test/orchestrator/orchestrator.test.ts`;
  - `apps/api/test/integration/engineering-e2e.test.ts`.

**Interfaces:**
- Consumes: `SandboxSpec` from Task 1.
- Produces in `sandbox.ts`:
  - `SANDBOX_MASKS = ["/run", "/var/run", "/tmp"] as const`;
  - `buildSandboxSettings(spec: SandboxSpec): { sandbox: Record<string, unknown> }`, which returns exactly the Global Constraints JSON and never mutates `spec`;
  - `withSandboxSettings(override: string, spec: SandboxSpec): string`. It parses the override, throws `"sandbox: settings override is not an object"` for a non-object, and returns `JSON.stringify({ ...parsed, ...buildSandboxSettings(spec) })`.
  - `SANDBOX_FAILURE_RE = /sandbox/i`.
- `ClaudeCliProvider.execute` when `r.sandbox` is set:
  - The override becomes `withSandboxSettings(<base or guarded override>, r.sandbox)`.
  - Before spawning, it runs `mkdirSync(tmpDir, { recursive: true, mode: 0o700 })` and `chmodSync(tmpDir, 0o700)`.
  - The child env adds `TMPDIR: tmpDir`. `SpawnOptions` gains `env?: Record<string, string>`, merged as `{ ...opts.env, ...o.env, ...HERMETIC_ENV }`.
  - A failure to build the override or create the dir returns `failed` with `details: { notSpawned: true }`, before any spawn. The messages are `"sandbox settings could not be built"` and `"sandbox tmp dir could not be created"`.
- `SpawnOutcome` gains `stderrHead: string`: the first 4096 bytes of stderr, kept only for matching and never returned, logged or stored.
- New classification, right after the `auth_failed` check, for sandboxed runs only. When the run failed (no result event, `result.isError`, or a non-zero exit) and `SANDBOX_FAILURE_RE` matches `stderrHead`, or matches `result.text` when `result.isError`, the error is `{ kind: "provider_error", message: "sandbox unavailable", details: { sandboxUnavailable: true, stderrBytes } }`. Update the classification-order comment.
- `orchestrator.classify` keeps `details.sandboxUnavailable: true` (a boolean, like `maxTurns`) when `e.kind === kind`.
- (plan addition, see the report) `userPermissionsWidenScope(settings)` also returns true for user-level sandbox settings that would merge into a develop run:
  - a non-empty `sandbox.excludedCommands`, `sandbox.filesystem.allowWrite`, `sandbox.filesystem.allowRead`, `sandbox.network.allowedDomains` or `sandbox.network.allowUnixSockets`;
  - `sandbox.allowUnsandboxedCommands === true`.
  Scalar keys such as `enabled` are not included, because the `--settings` flag outranks user settings for scalars. The existing guard then refuses engineering and reader runs, and Task 3's `claude_settings` check shows why.

- [ ] **Step 1: Write the failing tests.**
  - `sandbox.test.ts`:
    - `buildSandboxSettings({ tmpDir: "/home/u/s/runs/j1/tmp", denyRead: ["/home/u/.ssh"] })` `toEqual` the exact object with `denyRead: ["/home/u/.ssh", "/run", "/var/run", "/tmp"]` and `allowRead: ["/home/u/s/runs/j1/tmp"]`;
    - the input array is unchanged;
    - `withSandboxSettings(DEFAULT_SETTINGS_OVERRIDE, spec)` parses back with `enabledPlugins: {}`, `hooks: {}` and the `sandbox` object;
    - `withSandboxSettings("[]", spec)` throws.
  - `cli-provider.test.ts`. Add `FAKE_CLAUDE_MODE=sandbox_unavailable` (writes `Error: sandbox required but not available` to stderr and exits 1 with no stdout), and add `TMPDIR: e.TMPDIR ?? null` to the env file.
    - With `sandbox` (tmpDir in the test tmp), the argv `--settings` JSON has `sandbox.enabled === true`, `failIfUnavailable === true` and `network.deniedDomains` `["*"]`. The env file `TMPDIR` equals tmpDir, and `statSync(tmpDir).mode & 0o777` is `0o700`.
    - Without `sandbox`, `--settings` has no `sandbox` key and `TMPDIR` is null.
    - `sandbox_unavailable` mode with a sandbox → `status: "failed"`, `error.message: "sandbox unavailable"`, `error.details.sandboxUnavailable: true`.
    - The same mode without a sandbox → message `"claude exited without a result event"` and no `sandboxUnavailable`.
    - `success_exit1` with a sandbox, where stderr does not mention the sandbox → not `sandboxUnavailable`.
    - A tmpDir under an existing regular file → `failed`, `details.notSpawned: true`, and no argv file written.
  - `settings-override.test.ts`:
    - `{ sandbox: { excludedCommands: ["bun"] } }`, `{ sandbox: { network: { allowedDomains: ["x.test"] } } }` and `{ sandbox: { allowUnsandboxedCommands: true } }` each widen;
    - `{ sandbox: { excludedCommands: [] } }` and no `sandbox` key do not.
  - Orchestrator: a fake provider error with `details: { sandboxUnavailable: true }` → the thrown `JobError.classified.details.sandboxUnavailable === true`.
  - E2E: `engineering-fake-claude.ts` also records `tmpdir: process.env.TMPDIR ?? null`. The develop record's `--settings` has `sandbox.enabled: true`, its `tmpdir` ends with `/tmp` and contains `/runs/`, and that dir no longer exists after the step job.
- [ ] **Step 2: Run** `bun test apps/api/test/integrations apps/api/test/orchestrator apps/api/test/integration/engineering-e2e.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(claude-code): apply the develop-run sandbox in the CLI provider (F1.2)`.

### Task 3: Failure mapping and the `sandbox` and `claude_settings` health checks

**Files:**
- Modify:
  - `apps/api/src/modules/engineering-tasks/steps.ts` (`runDevelop` catch);
  - `apps/api/src/core/health/checks.ts`;
  - `apps/api/src/modules/dashboard/health-hints.ts`;
  - `apps/api/src/container.ts` (`servicePath`, `ContainerDeps.which`, the two checks).
- Test:
  - `apps/api/test/workers/engineering-steps.test.ts`;
  - `apps/api/test/core/health.test.ts`;
  - `apps/api/test/modules/dashboard.test.ts`.

**Interfaces:**
- Consumes:
  - `SANDBOX_REQUIRED_REASON` (Task 1);
  - `details.sandboxUnavailable` on the run's `JobError` (Task 2);
  - `AIProvider.userPermissionsWidenScope` and `userAllowedConnectorServers`.
- Produces in `steps.ts`:
  - `sandboxUnavailable(err: unknown): boolean`, which reads `JobError` `details.sandboxUnavailable === true`;
  - in `runDevelop`'s catch, after the defer branch:
    - `sandboxUnavailable` → `this.attention(taskId, "develop", "sandbox_unavailable", { ...fingerprints, failure: "sandbox_unavailable" }, runner.runId())`. It always goes to `needs_attention` (F1.4), even with a clean tree, and the lock is kept.
    - a `JobError` with kind `invalid_input` and message `SANDBOX_REQUIRED_REASON` → `developFailed` with code `sandbox_disabled`. With a clean tree that means `failed` and cleanup, which releases the lock.
  - `testResultFrom` is unchanged: `testsPassed` still comes only from the exit status.
- Produces in `checks.ts`:
  - `sandboxCheck(deps: { settings: Pick<SettingsService, "get">; which: (bin: string) => string | null }): HealthCheck`:
    - setting off → `{ status: "ok", detail: "disabled" }`;
    - both `bwrap` and `socat` resolve → `{ status: "ok" }`;
    - else `{ status: "degraded", detail: "missing: bwrap, socat" }` (only the missing names, in that order).
  - `claudeSettingsCheck(deps: { provider: Pick<AIProvider, "userPermissionsWidenScope" | "userAllowedConnectorServers">; knownServers: () => readonly string[] }): HealthCheck`. It returns `{ status: "degraded", detail: "unsafe_user_settings" }` exactly when the orchestrator's refusal condition holds: the widening flag, or any user-allowed connector server outside `knownServers()`. Otherwise `ok`. It reads the startup flags and spawns nothing.
- Produces in `health-hints.ts`:
  - `HEALTH_LABELS.sandbox = "Test sandbox"` and `HEALTH_LABELS.claude_settings = "Claude Code settings"`;
  - `HEALTH_HINTS.sandbox` and `HEALTH_HINTS.claude_settings`, the exact copy from Global Constraints.
- Container:
  - `const servicePath = \`${home}/.bun/bin:${home}/.local/bin:/usr/bin:/bin\`` is used by the provider env and by the check;
  - `ContainerDeps.which?: (bin: string) => string | null`, defaulting to `(b) => Bun.which(b, { PATH: servicePath })`;
  - checks `sandbox: sandboxCheck(...)` and `claude_settings: claudeSettingsCheck({ provider, knownServers: () => settings.get("orchestrator.knownServers") })`.

- [ ] **Step 1: Write the failing tests.**
  - Steps:
    - a develop runner throwing `JobError({ kind: "provider_error", message: "sandbox unavailable", details: { sandboxUnavailable: true } })` with a clean tree → task `needs_attention`, `failure` `sandbox_unavailable`, the lock still held, no commit approval;
    - a runner throwing `JobError({ kind: "invalid_input", message: SANDBOX_REQUIRED_REASON })` → task `failed` with `sandbox_disabled`, and cleanup enqueued;
    - `testResultFrom([{ toolName: "Bash", input: { command: "bun test" }, isError: false, content: "1 pass\nsandbox: network request denied" }], "bun test").testsPassed === true`.
  - Health:
    - `which` returning null for `socat` → degraded, detail `missing: socat`;
    - both found → ok;
    - setting off → ok and `disabled`;
    - `claudeSettingsCheck` with `userPermissionsWidenScope: true` → degraded;
    - with `userAllowedConnectorServers: ["mcp__other"]` and known `["mcp__claude_ai_Slack"]` → degraded;
    - both clean → ok.
  - Dashboard: the existing "every hinted check has a label" test passes, and `HEALTH_HINTS.sandbox` equals the exact copy.
- [ ] **Step 2: Run** `bun test apps/api/test/workers/engineering-steps.test.ts apps/api/test/core/health.test.ts apps/api/test/modules/dashboard.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(engineering): sandbox failure mapping and sandbox/claude_settings health checks (F1.4, F1.5, F3.3)`.

### Task 4: Extend the real-CLI develop smoke (F1.7)

**Files:**
- Modify:
  - `scripts/dev/develop-smoke.ts`;
  - `scripts/dev/test/develop-smoke.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–3 through `createContainer`, with the default `engineering.sandbox.enabled = true`.
- Produces:
  - `type ProbeResult = "blocked" | "allowed" | "unknown"`;
  - `interface SandboxSummary { outsideWrite: ProbeResult; secret: ProbeResult; network: ProbeResult }`;
  - `SmokeSummary.sandbox: SandboxSummary`;
  - `interface ProbePaths { outsideFile: string; secretFile: string; url: string }`;
  - `buildRepo(root: string, probe: ProbePaths): string`. The test file gets a second test, `"sandbox probe"`, which never fails. It tries `writeFileSync(outsideFile)`, `readFileSync(secretFile)` and `fetch(url, { signal: AbortSignal.timeout(5000) })`, catches each, and prints one line, `SANDBOX_PROBE outside_write=<allowed|blocked> secret=<allowed|blocked> network=<allowed|blocked>`. It never prints the secret.
  - `parseSandboxProbe(tail: string | null): SandboxSummary` reads the last matching line. A missing or malformed line gives `unknown` for each field.
  - `formatSummary` appends `sandbox: outside_write=<r> secret=<r> network=<r>`.
  - `smokeExitCode(s: SmokeSummary): 0 | 1` returns 1 when any sandbox field is `allowed`.
- Run layout (inside the sandbox `/tmp` is a private tmpfs, so a root under `/tmp` would make every probe inconclusive):
  - the root is `mkdtempSync(join(homedir(), ".cache", "synapse-develop-smoke-"))`, after `mkdirSync(~/.cache, { recursive: true })`;
  - the repo is `root/work`;
  - `dbPath = root/data/t.db`, so the data dir is a `denyRead` entry and does not contain the repo;
  - `secretFile = root/data/probe-secret.txt`, holding a placeholder sentinel;
  - `outsideFile = root/outside-probe.txt`;
  - `url = "https://example.com/"`.
  - `outsideWrite` is `allowed` if `existsSync(outsideFile)` after the run (ground truth on the host). Otherwise it is the probe's value.
  - `main` sets `process.exitCode = smokeExitCode(summary)`.
  - The root is deleted in `finally` and on SIGINT/SIGTERM.
  - Update the header comment: it now writes under `~/.cache`, and prints the sandbox line.

- [ ] **Step 1: Write the failing tests** (unit only, pure functions):
  - `parseSandboxProbe("…\nSANDBOX_PROBE outside_write=blocked secret=blocked network=blocked\n")` gives all `blocked`;
  - two probe lines → the last wins;
  - `null` and `"no marker"` → all `unknown`;
  - `outside_write=maybe` → that field is `unknown`;
  - `formatSummary` ends with `sandbox: outside_write=blocked secret=blocked network=blocked`;
  - `smokeExitCode` is 0 for all `blocked`, 0 for an `unknown`, and 1 when `network` is `allowed`;
  - the generated test source contains `SANDBOX_PROBE` and both probe paths, and no `console.log` of the read content.
- [ ] **Step 2: Run** `bun test scripts/dev/test/develop-smoke.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Do **not** run the script itself.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `test(smoke): develop-smoke probes the sandbox (F1.7)`. The controller then runs `bun scripts/dev/develop-smoke.ts` once and records the lines for Task 8.

### Task 5: Approval text edits and the merge re-request (API)

**Files:**
- Modify:
  - `packages/contracts/src/engineering.ts`;
  - `apps/api/src/core/approvals/approvals.ts`;
  - `apps/api/src/modules/engineering-tasks/store.ts` (error codes);
  - `apps/api/src/modules/engineering-tasks/steps.ts`;
  - `apps/api/src/routes/engineering.ts`.
- Test:
  - `packages/contracts/test/engineering.test.ts`;
  - `apps/api/test/core/approvals.test.ts`;
  - `apps/api/test/routes/engineering.test.ts`;
  - `apps/api/test/workers/engineering-steps.test.ts`.

**Interfaces:**
- Produces in `contracts/engineering.ts`:
  - `COMMIT_MESSAGE_MAX = 5000`, `COMMIT_SUBJECT_MAX = 200`, `PR_TITLE_MAX = 200`, `PR_BODY_EDIT_MAX = 20000`;
  - `type ApprovalTextField = "commitMessage" | "prTitle" | "prBody"`;
  - `approvalTextEditSchema = z.strictObject({ commitMessage: z.string().optional(), prTitle: z.string().optional(), prBody: z.string().optional() })`, with `type ApprovalTextEdit`.
  - `isValidApprovalText(field: ApprovalTextField, value: string): boolean`:
    - no character in `[\u0000-\u0008\u000B-\u001F\u007F]` (this includes `\r`);
    - commitMessage: 1–5000 code points, and a first line (up to the first `\n`) that is non-blank after trim and at most 200 code points;
    - prTitle: 1–200 code points, no `\n`, non-blank after trim;
    - prBody: at most 20000 code points.
- Produces in `ApprovalEngine`: `updatePendingPayload(tx: DbOrTx, id: string, payload: unknown): Approval | null`. It is one `UPDATE … WHERE id = ? AND status = 'pending' RETURNING`, and returns null when nothing matched. It publishes nothing; the caller audits.
- `ENGINEERING_TASK_ERROR_CODES` gains `not_pending`, `invalid_text`, `checks_failing`, `pr_head_moved`, `pr_status_failed` and `state_changed`. The route `STATUS` map gives `invalid_text` 400 and the other five 409.
- `EngineeringStepDeps.approvals` adds `"updatePendingPayload"` to its `Pick`. `pushPrPayloadSchema.prBody` becomes `.max(PR_BODY_EDIT_MAX)`.
- Produces `EngineeringStepService.editApprovalText(taskId: string, approvalId: string, edit: ApprovalTextEdit): Approval`, one immediate transaction. Checks run in this order, and the first failure throws an `EngineeringTaskError`:
  1. The task is missing, or the approval is missing, has another `targetRef`, or is not `engineering` → `not_found`.
  2. The action is not `engineering.commit` or `engineering.push_pr`, no field is given, or a field belongs to the other action → `invalid_input`. Commit takes `commitMessage` only; push takes `prTitle`/`prBody`.
  3. Any of these → `not_pending`: the approval is not `pending`; the task is not `awaiting_approval`; `currentStep` is not this step; the step row's `approvalId` is not this id.
  4. A value fails `isValidApprovalText`, or the merged payload fails `PAYLOAD_SCHEMAS[step]` → `invalid_text`.
  5. `updatePendingPayload` returns null → `not_pending`.
  It then audits `engineering.approval_edited` with `approvalId` set and `details: { taskId, fields: [...] }` (field names only), and returns the updated approval.
- Produces `EngineeringStepService.retryMerge(taskId: string): Promise<void>`:
  - A context skip gives `not_found` or `path_unavailable`, and any other skip gives `invalid_state`.
  - It requires status `needs_attention`, `failure === "checks_failing"`, `currentStep === "merge_pr"`, the lock held by this task, a non-null upstream `repoRef`, `task.prNumber`, and the push output's `pushedSha`. Otherwise `invalid_state`. A protected parent gives `protected_branch`.
  - `prStatus` throws → `pr_status_failed`.
  - `state !== "OPEN"` → `state_changed`.
  - `headSha !== pushedSha` → `pr_head_moved`.
  - `checks === "failing"`, or `checks === "pending" && mergeable !== "MERGEABLE"` → `checks_failing`.
  - Otherwise (`passing`, `none`, or pending and `MERGEABLE`), in one immediate transaction:
    - re-check the three task conditions (else `invalid_state`);
    - `requestStep(tx, taskId, "merge_pr", "engineering.merge_pr", "high", { taskId, parentBranch, prNumber, prUrl, status: { ...status, checkedAt }, pushedSha, ...this.deployNotice(task) }, { prNumber })`;
    - audit `engineering.merge_rerequested` with `{ prNumber }`.
- Routes:
  - `PUT /api/engineering/tasks/:id/approvals/:approvalId`. The body is parsed with `approvalTextEditSchema`, and a failure gives 400 `invalid_input`. It answers 200 with the updated `Approval`.
  - `POST /api/engineering/tasks/:id/retry-merge` answers 200 with `c.engineering.get(id)`.

- [ ] **Step 1: Write the failing tests.**
  - Contracts:
    - `isValidApprovalText("commitMessage", "Fix add\n\nTask: t1")` is true;
    - `"   \nbody"`, a 201-character first line, 5001 characters, `"Fix\u0000"` and `"Fix\r\nx"` are false;
    - prTitle `"a\nb"` and a 201-character title are false;
    - a prBody of 20001 characters is false and 20000 is true.
  - Approvals:
    - `updatePendingPayload` on a pending approval returns it with the new payload;
    - on an `approved` one it returns null and leaves the payload unchanged.
  - Routes, with an in-memory container and a task driven to `awaiting_approval` at `commit` (the existing fixtures):
    - `PUT {commitMessage: "Fix add\n\nTask: t1"}` → 200 and `payload.message` updated; the commit executor then calls `git.commitAll` with that message (fake git records it);
    - one audit row `engineering.approval_edited` with `details.fields` `["commitMessage"]` and no message text anywhere in `details`;
    - `PUT {prTitle: "x"}` on the commit approval → 400 `invalid_input`;
    - `PUT {}` → 400 `invalid_input`;
    - an unknown approval id → 404 `not_found`.
    - Review Focus 2: `PUT {commitMessage: "   "}` → 400 `invalid_text` with the payload unchanged.
    - Review Focus 3: after `POST /api/approvals/:id/approve`, `PUT` → 409 `not_pending` with the payload unchanged.
    - Push step: `PUT {prTitle: "Fix add", prBody: "b".repeat(20000)}` → 200, and the fake `prs.createPr` receives both.
  - Retry-merge, with the task driven to `needs_attention`/`checks_failing` at `merge_pr` through a failing revalidation (fake `prs`):
    - fake status `{ state: "OPEN", checks: "passing", headSha: pushedSha }` → 200, task `awaiting_approval` at `merge_pr`, and a new pending `engineering.merge_pr` approval whose payload `status.checks` is `passing`;
    - `pending` with `MERGEABLE` → 200;
    - still `failing` → 409 `checks_failing`, task unchanged.
    - Review Focus 4: `headSha` moved → 409 `pr_head_moved`; `state: "MERGED"` → 409 `state_changed`; `prStatus` throwing → 409 `pr_status_failed`. In each case the task stays `needs_attention` and the pending approval count is unchanged.
    - A task at any other step or reason → 400 `invalid_state`.
- [ ] **Step 2: Run** `bun test packages/contracts apps/api/test/core/approvals.test.ts apps/api/test/routes/engineering.test.ts apps/api/test/workers/engineering-steps.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(engineering): edit commit and PR text before approval, re-request merge_pr (F2.1, F3.2)`.

### Task 6: Web: editable cards, repository picker, "Check again", sandbox copy and setting

**Files:**
- Create: `apps/web/app/components/engineering/RepositoryPicker.tsx`.
- Modify:
  - `apps/web/lib/api.ts`;
  - `apps/web/lib/engineering.ts`;
  - `apps/web/lib/needs-you-actions.ts`;
  - `apps/web/app/components/triage/useNeedsYouActions.ts`;
  - `apps/web/app/components/triage/EngineeringCards.tsx`;
  - `apps/web/app/components/triage/NeedsYou.tsx`;
  - `apps/web/app/components/engineering/PlanApproval.tsx`;
  - `apps/web/app/components/engineering/EngineeringSection.tsx`;
  - `apps/web/app/components/system/ClaudeSettings.tsx`;
  - `apps/web/app/page.tsx`.
- Test:
  - `apps/web/test/engineering.test.ts`;
  - `apps/web/test/engineering-ui.test.tsx`;
  - `apps/web/test/needs-you-actions.test.ts`;
  - `apps/web/test/system.test.tsx`.

**Interfaces:**
- Consumes: Task 5's routes and contracts (`ApprovalTextEdit`, `isValidApprovalText`) and Task 1's setting key.
- Produces in `api.ts`:
  - `editEngineeringApproval(taskId: string, approvalId: string, edit: ApprovalTextEdit, fetchImpl?): Promise<Approval>` (`send("PUT", …)`);
  - `retryEngineeringMerge(taskId: string, fetchImpl?): Promise<EngineeringTaskDetail>`;
  - `ClaudeSettingsDto` gains `"engineering.sandbox.enabled": boolean`.
- Produces in `lib/engineering.ts`:
  - `REASONS` entries:
    - `sandbox_unavailable` and `sandbox_disabled`, with the exact copy;
    - `not_pending`: "This approval was already decided or replaced.";
    - `invalid_text`: "The text is empty, too long or has characters that can't be used.";
    - `checks_failing`, reworded to end "…Fix the checks, then use Check again, or cancel the task.".
  - `SANDBOX_ON_TEXT`, `SANDBOX_OFF_TEXT` (exact copy);
  - `type TaskSource = { kind: "jira"; key: string } | { kind: "slack"; messageId: string }`;
  - `repositoryChoices(repos: RepositoryView[]): Array<{ id: string; name: string }>`, sorted by name;
  - `canCheckAgain(t: Pick<EngineeringTaskView, "status" | "failure" | "currentStep">): boolean`;
  - `type ApprovalTextValues = Partial<Record<ApprovalTextField, string>>`;
  - `approvalTextValues(p: EngineeringApproval): ApprovalTextValues | null`, which gives commit → `{ commitMessage }`, push_pr → `{ prTitle, prBody }`, others null;
  - `changedText(original: ApprovalTextValues, current: ApprovalTextValues): ApprovalTextEdit`, with changed keys only;
  - `approvalTextProblem(v: ApprovalTextValues): string | null`. It returns the first failing field's sentence:
    - "A commit message needs 1 to 5000 characters and a first line of at most 200.";
    - "A PR title needs 1 to 200 characters on one line.";
    - "A PR body can have at most 20000 characters."
- Produces in `needs-you-actions.ts`:
  - `NeedsYouHandlers` gains `createTaskInRepository(source: TaskSource, repositoryId: string): void`, `retryEngineeringMerge(taskId: string): void` and `saveEngineeringApprovalText(taskId: string, approvalId: string, edit: ApprovalTextEdit): Promise<string | null>` (an error sentence, or null).
  - `createTaskFromJira` and `createTaskFromSlack` call one `propose(source, repositoryId?)`. When there is no `repositoryId`, an `ApiError` with code `ambiguous_repository` calls `deps.pickRepository?.(source)` and sets no action error. Any other error goes through `engineeringErrorText`.
  - `NeedsYouActionsDeps` and `NeedsYouActionsOptions` gain `pickRepository?: (s: TaskSource) => void`. `NeedsYouApi` adds `editEngineeringApproval` and `retryEngineeringMerge`.
  - `TOASTS.mergeRequested = "New merge approval created"` and `TOASTS.textSaved = "Saved"`.
- Components:
  - `RepositoryPicker({ source, repos, onPick, onCancel })` is a card with `role="group"`, `aria-label="Choose a repository"`, a `<select>` of names, "Create task" and "Cancel". `page.tsx` keeps `repoChoice: TaskSource | null`, renders the picker above the Needs-you list, and passes `pickRepository: setRepoChoice`.
  - `EngineeringApprovalCard` gains `onSaveText`. The commit message is a `<textarea aria-label="Commit message">`. The push card has an `<input aria-label="PR title">` and a `<textarea aria-label="PR body">`. Save is enabled only when the text changed and `approvalTextProblem` is null. Approve with unsaved changes awaits `onSaveText` first, and on an error sentence shows it and does not call `onDecide`.
  - `EngineeringAttentionCard` gains `onCheckAgain`, and renders "Check again" when `canCheckAgain(task)`.
  - `PlanApproval` gains `sandboxEnabled: boolean | null`, which renders `SANDBOX_ON_TEXT` or `SANDBOX_OFF_TEXT` (nothing for null). `EngineeringSection` passes it from `page.tsx` (`claudeSettings?.["engineering.sandbox.enabled"] ?? null`).
  - `ClaudeSettings` TOGGLES gains `{ key: "engineering.sandbox.enabled", label: "Run tests in a sandbox", hint: SANDBOX_HINT }`, where `export const SANDBOX_HINT = "Develop runs execute the repository's tests with no network and writes only inside the repository. Turning this off disables develop runs; tests never run outside the sandbox."` (C9-style sentence).

- [ ] **Step 1: Write the failing tests.**
  - `engineering.test.ts`:
    - `changedText({ commitMessage: "a" }, { commitMessage: "b" })` equals `{ commitMessage: "b" }`, and unchanged text gives `{}`;
    - `approvalTextProblem({ prTitle: "a\nb" })` is the title sentence;
    - `canCheckAgain` is true only for `needs_attention`/`checks_failing`/`merge_pr`;
    - `repositoryChoices` sorts and keeps only `id`/`name`.
  - `needs-you-actions.test.ts` (fake api):
    - `createTaskFromJira("SB-1")` rejecting with `new ApiError("x", 400, "ambiguous_repository")` calls `pickRepository({ kind: "jira", key: "SB-1" })` and sets no action error;
    - `createTaskInRepository({ kind: "slack", messageId: "m1" }, "r1")` calls `createTaskFromSlack("m1", "r1")` and toasts `taskProposed`;
    - `retryEngineeringMerge("t1")` rejecting with code `checks_failing` sets the action error to the `checks_failing` label;
    - `saveEngineeringApprovalText` resolves to the `not_pending` label on a 409.
  - `engineering-ui.test.tsx` (`renderToString`):
    - the commit card renders a textarea containing the payload message and a Save button;
    - the push card renders the title input and body textarea;
    - the attention card for `checks_failing` at `merge_pr` shows "Check again", and for `dirty_tree` does not;
    - `PlanApproval` with `sandboxEnabled` true shows `SANDBOX_ON_TEXT`, and false shows `SANDBOX_OFF_TEXT`;
    - `RepositoryPicker` lists `demo` and `api` as options.
    - Review Focus 3: a small `approveWithEdits(save, decide)` helper (exported from `EngineeringCards.tsx`) does not call `decide` when `save` resolves to an error sentence, and calls it once after `save` resolves to null.
  - `system.test.tsx`: the sandbox toggle and `SANDBOX_HINT` render.
- [ ] **Step 2: Run** `bun test apps/web/test`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** `bun run check && bun run --cwd apps/web build`. Expect PASS.
- [ ] **Step 5: Commit:** `feat(web): editable commit/PR text, repository picker, Check again and sandbox setting (F1.6, F2.2, F3.1, F3.2)`.

### Task 7: `autoSend` kill switch and the code-answer timeout read at job start

**Files:**
- Modify:
  - `apps/api/src/modules/outgoing/service.ts`;
  - `apps/api/src/modules/code-answers/service.ts`;
  - `apps/api/src/core/jobs/worker.ts`;
  - `apps/api/src/workers/code-answer/generate.ts`;
  - `apps/api/src/container.ts` (wire `codeAnswerHeld`).
- Test:
  - `apps/api/test/modules/outgoing-auto.test.ts`;
  - `apps/api/test/modules/code-answer-away.test.ts`;
  - `apps/api/test/core/worker.test.ts`;
  - `apps/api/test/workers/code-answer-generate.test.ts`.

**Interfaces:**
- Produces in `outgoing/service.ts`:
  - `AutoSendBlock` gains `"code_answer_autosend_off"`. `autoSendBlock` returns it after the policy-gate check and before the stale check, when `ar.kind === "code_answer" && !settings.get("codeAnswer.away.autoSend")`.
  - `failureOf(block: AutoSendBlock): SendFailure` maps the new block to `"cancelled_policy_disabled"` and the rest to `` `cancelled_${block}` ``.
  - `holdReasonOf(block: AutoSendBlock): HoldReason` maps the new block to `"code_answer_review"` and the rest to `block`.
  - Every place that builds `` `cancelled_${block}` `` uses `failureOf`: the claim's `cancel`, the pre-spawn catch in `#send`, and `holdAutoSend`. `holdAutoSend` writes `reason: holdReasonOf(block)`. When the hold transitions a row of the new block, it calls `deps.codeAnswerHeld?.(tx, ar.id)` in the same transaction.
  - `OutgoingServiceDeps.codeAnswerHeld?: (tx: DbOrTx, autoReplyId: string) => void`.
- Produces `CodeAnswerService.returnToHeld(tx: DbOrTx, autoReplyId: string): void`. A row with this `autoReplyId` and status `sent` becomes `held` and publishes its status change. Any other row is left alone. The user then approves through the existing `requestSend` path, because `cancelled_policy_disabled` is already in `RESENDABLE_FAILURES`.
- Container: `codeAnswerHeld: (tx, id) => codeAnswers.returnToHeld(tx, id)`. This closure is invoked only after construction.
- Produces in `worker.ts`: `HandlerRegistration.timeoutMs: number | ((job: Job) => number)`, resolved once when the job starts, in both the timer and the timeout message. `generate.ts` registers `timeoutMs: () => (settings.get("codeAnswer.timeoutMinutes") + 5) * 60_000`.

- [ ] **Step 1: Write the failing tests.**
  - `outgoing-auto.test.ts`, using a code-answer auto-send recorded while `codeAnswer.away.autoSend` is true, then set false:
    - executed through the claim → outgoing `failed` with `cancelled_policy_disabled`; the auto_reply is `held` with reason `code_answer_review` and `text` null; the code answer status is `held`; the sink is never called;
    - the setting flipped false inside the existing slot-waiting fake sink before `beforeSpawn` → the same outcome, and the sink never spawns;
    - `codeAnswers.requestSend(<id>, <text>, false)` then creates one pending `slack.send` approval;
    - a `followup_question` auto-send with `codeAnswer.away.autoSend` false still sends.
  - `worker.test.ts`: a registration `timeoutMs: () => current` with `current` changed from 10 000 to 50 after registration, and a hanging handler → the job times out, and the error message names `50ms`.
  - `code-answer-generate.test.ts`: after `settings.set("codeAnswer.timeoutMinutes", 12)`, `(reg.timeoutMs as (j: Job) => number)(job)` equals `17 * 60_000`.
- [ ] **Step 2: Run** `bun test apps/api/test/modules/outgoing-auto.test.ts apps/api/test/modules/code-answer-away.test.ts apps/api/test/core/worker.test.ts apps/api/test/workers/code-answer-generate.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** `bun run check`. Expect PASS.
- [ ] **Step 5: Commit:** `fix(code-answers): autoSend is an immediate kill switch; handler timeout read at job start (F4.1, F4.2)`.

### Task 8: Docs and follow-ups

**Files:**
- Modify:
  - `docs/architecture/security-model.md`;
  - `docs/architecture/integration-contracts.md`;
  - `docs/modules/engineering-tasks.md`;
  - `docs/modules/claude-orchestrator.md`;
  - `docs/modules/auto-reply.md`;
  - `docs/modules/code-answers.md`;
  - `CLAUDE.md`;
  - `docs/superpowers/plans/2026-11-06-phase-10-followups.md`;
  - `docs/superpowers/plans/2026-11-06-phase-10b-followups.md`;
  - `docs/superpowers/plans/2026-11-06-phase-6b-followups.md`.

- [ ] **Step 1: Security model §3.1.**
  - Add a "Sandboxed test command (ADR-040)" bullet: the profile, the masks and why, TMPDIR, rule M, and "off means no develop runs".
  - Rewrite the threat-model paragraph. The test command now runs with no network and with writes only in the repository and its private tmp. The residuals are:
    - files outside the masks are readable, but can leave only through the diff or test output the user reviews;
    - the seccomp layer is skipped;
    - Read and Edit are scoped by rule L, not by bwrap;
    - user-level sandbox settings are refused at startup.
- [ ] **Step 2: Module docs.**
  - `engineering-tasks.md`:
    - the develop run's sandbox and the setting;
    - reason codes `sandbox_unavailable` and `sandbox_disabled`;
    - the two routes with their codes;
    - text edits and their limits;
    - remove the batch-1 items from Deferred.
  - `claude-orchestrator.md`:
    - rule M in the rule list;
    - the `sandbox` field and the provider merge;
    - TMPDIR;
    - the `sandboxUnavailable` classification;
    - the widening flag's sandbox keys;
    - the `claude_settings` health check.
  - `integration-contracts.md`: `sandbox?: SandboxSpec` on both request shapes.
  - `auto-reply.md` and `code-answers.md`: the `autoSend` kill switch (`cancelled_policy_disabled`, back to `held`/`code_answer_review`), and the timeout read at job start.
- [ ] **Step 3: CLAUDE.md.**
  - Extend the `develop-smoke.ts` line: it runs under `~/.cache`, also prints `sandbox: outside_write=… secret=… network=…`, and exits 1 on any `allowed`.
  - Add one invocation-profile bullet: develop runs merge a `sandbox` block into `$OVERRIDE` and set `TMPDIR` (ADR-040).
- [ ] **Step 4: Follow-ups.**
  - Mark as done in Batch 1:
    - phase-10: the sandbox, the repository picker, re-requesting `merge_pr`, editing the commit and PR text;
    - phase-10b: the handler timeout, the `autoSend` re-check, the UI hint for a `Read` allow entry;
    - phase-6b: note that `codeAnswer.away.autoSend` is now an immediate kill switch for code answers.
  - Record the controller's smoke result: date, CLI version, the printed lines.
  - Add these new items:
    - network-enabled sandboxes (repos whose tests need the network cannot use develop runs);
    - a retry action for the develop step after `sandbox_unavailable` (today: cancel and re-propose);
    - repositories registered under `/tmp` are unverified with the `/tmp` mask;
    - the skipped seccomp layer on hosts with `apparmor_restrict_unprivileged_userns`;
    - files outside the mask list (other `~/.local/share` apps, browser profiles) stay readable to tests.
- [ ] **Step 5: Run** `bun run check`. Expect PASS. **Commit:** `docs: follow-ups batch 1 (ADR-040 sandbox, approval edits, kill switch)`.
