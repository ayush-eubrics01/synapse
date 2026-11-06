# Follow-ups Batch 1: Sandboxed Test Runs and Engineering Approvals — Design

**Authority:**
- New ADR-040: sandboxed test commands.
- ADR-030, ADR-033 and ADR-035.
- `docs/modules/engineering-tasks.md`.
- The follow-ups files `2026-11-06-phase-10-followups.md`, `2026-11-06-phase-10b-followups.md` and `2026-11-06-phase-6b-followups.md`.

This batch picks the follow-ups with the most user value or safety value. Batch 2 will take the dashboard and UX follow-ups.

## F1: Sandboxed develop runs (ADR-040)

**Problem.** The develop run executes the repository's test command. It is repository code, possibly edited by the model, and runs as the user with network access and write access everywhere (security-model §3.1).

**Real-CLI findings** (2026-11-07, Claude Code 2.1.319, Ubuntu with `kernel.apparmor_restrict_unprivileged_userns=1`, bubblewrap 0.11.1, socat present). Throwaway probes covered:
- writes inside and outside the repository and to `/tmp`;
- reading a planted secret;
- child processes;
- `fetch`;
- Docker socket `_ping`;
- the SSH agent, X11 and the runtime directory;
- `~/.ssh`, `~/.claude`, the Synapse data directory, and `/tmp/claude-<uid>`.

Results:
- The Claude Code sandbox's seccomp layer fails here ("nested userns is capability-restricted") unless `network.allowAllUnixSockets: true` is set, which skips that layer. Neither `allowNestedUserNamespaces` nor `enableWeakerNestedSandbox` helps.
- With unix sockets allowed and nothing masked, a test reached the Docker daemon (root-equivalent, since the user is in the `docker` group) and saw the SSH agent. Masking (`denyRead`) is therefore **mandatory**:
  - masking `/run`, `/var/run` and `/tmp` hid the Docker socket, the runtime directory (SSH agent, D-Bus, Wayland) and X11; a Docker `_ping` failed;
  - `/tmp` became a private writable tmpfs;
  - masked home directories appear empty.
- Denying writes to `/tmp` breaks Claude Code's own cwd tracking (every Bash call exits non-zero, which would turn `testsPassed` false). Masking `/tmp` instead, with `TMPDIR` pointed at a private per-run directory under the run scratch and re-allowed with `allowRead`, works. It also hides other Claude sessions' temp files.
- Final profile: repository writes ok; outside writes, the secret, Docker, the SSH agent, X11 and the network all blocked; `bun test` passes with a clean exit.

| # | Decision |
|---|---|
| F1.1 | **Contract.** `AIExecutionRequest` gains optional `sandbox?: { tmpDir: string; denyRead: string[] }`. The orchestrator validator gains **rule M**: an engineering request that grants any `Bash(...)` must carry `sandbox` (otherwise it fails with "engineering Bash requires the sandbox"). `tmpDir` and every `denyRead` entry must pass `isSafeAbsolutePath`. A non-engineering request must not carry `sandbox`. |
| F1.2 | **Provider.** When `sandbox` is set, `ClaudeCliProvider` merges into the `--settings` override:<br>`{ sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, excludedCommands: [], filesystem: { denyRead: [...denyRead, "/run", "/var/run", "/tmp"], allowRead: [tmpDir] }, network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true, allowAllUnixSockets: true } } }`<br>It sets `TMPDIR=<tmpDir>` in the child env and creates `tmpDir` (0700) before spawning. The pure builder is `buildSandboxSettings(req.sandbox)` in `integrations/claude-code/sandbox.ts`. |
| F1.3 | **Who sets it.** The develop request builder (`intelligence/engineering/develop-prompt.ts`) sets `sandbox` when `engineering.sandbox.enabled` is true (the default):<br>- `tmpDir`: `<run scratch>/tmp`.<br>- `denyRead`: the fixed home list `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config`, `~/.claude`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials`, `~/.cargo/credentials.toml`; plus the Synapse data directory and the backup directory. Entries are kept only when they are not the repository and do not contain it.<br>If the setting is off, the request carries no `sandbox`, so rule M refuses the develop run. Turning the sandbox off therefore means **no develop runs**, never an unsandboxed one. A repository whose tests need the network cannot use develop runs in this batch; this is recorded in the follow-ups. |
| F1.4 | **Failure mapping.** A run that exits at startup because the sandbox is unavailable (`failIfUnavailable`; stderr or the result names the sandbox) fails the develop step with the fixed reason `sandbox_unavailable`. The task goes to `needs_attention` with the hint "Install bubblewrap and socat (sudo apt install bubblewrap socat), then retry". Sandbox network violations in the tool result are ignored for `testsPassed`, which still comes from the exit status. |
| F1.5 | **Health.** New check `sandbox`: `ok` when `bwrap` and `socat` resolve on the service PATH (`/usr/bin` etc., found with `Bun.which` against the API's PATH); `degraded` with the F1.4 hint otherwise; `ok` with detail "disabled" when `engineering.sandbox.enabled` is false. |
| F1.6 | **UI.** The plan-approval card says "Tests run in a sandbox: no network, writes only inside the repository". When the setting is off: "Develop runs are disabled: the test sandbox is turned off". The setting is added to the settings allowlist with the C9-style sentence. |
| F1.7 | **Real-CLI smoke.** `scripts/dev/develop-smoke.ts` is extended:<br>- its test file also tries to write outside the repository, read a planted secret and fetch a URL;<br>- it prints `sandbox: outside_write=blocked secret=blocked network=blocked`;<br>- it exits 1 on any `allowed`.<br>The controller runs it once. |

## F2: Edit commit message, PR title and PR body before approval (spec E10, E13)

| # | Decision |
|---|---|
| F2.1 | **API.** `PUT /api/engineering/tasks/:id/approvals/:approvalId {commitMessage?}` for `engineering.commit`, and `{prTitle?, prBody?}` for `engineering.push_pr`.<br>- Allowed only while the approval is `pending` and belongs to the task's current step.<br>- Limits: commitMessage 1–5000 characters with a first line ≤ 200; prTitle 1–200 with no newline; prBody ≤ 20000.<br>- It updates the approval payload in one transaction and audits `engineering.approval_edited` (ids and changed field names only).<br>- Error codes: 409 `not_pending`, 400 `invalid_text`.<br>The executors already read the payload, so they use the edited text. Revalidation stays unchanged (the diff hash and SHA pins do not involve the text). |
| F2.2 | **Web.** On the commit and push cards, the message, title and body are editable textareas. Edits are saved with Save; Approve sends any unsaved edit first. A suspected-injection marker is not needed: the text is the user's. |

## F3: Engineering approval and flow gaps

| # | Decision |
|---|---|
| F3.1 | **Repository picker.** `from-jira` and `from-slack` already accept `repositoryId`. When the API answers `ambiguous_repository`, the web shows a select of registered repositories (names only) and retries with the chosen id. |
| F3.2 | **Re-request `merge_pr`.** `POST /api/engineering/tasks/:id/retry-merge` is allowed only when the task is `needs_attention` with reason `checks_failing` at step `merge_pr`. It re-reads the PR status. If checks pass or are pending-but-mergeable, it creates a fresh `engineering.merge_pr` approval and the task returns to `awaiting_approval`. If they still fail: 409 `checks_failing`. The Needs-you card gets "Check again". |
| F3.3 | **Unsafe-settings hint.** When the orchestrator refuses a run because user settings widen scope (`UNSAFE_USER_SETTINGS_MESSAGE`, including the reader case of unknown connector servers), the health check `claude_settings` turns `degraded` with "Your ~/.claude/settings.json allows tools Synapse must control; engineering and code-answer runs are refused until those allow entries are removed and the API is restarted". The check reads the provider flag already computed at startup. |

## F4: Small safety fixes

| # | Decision |
|---|---|
| F4.1 | **`autoSend` kill switch.** The auto-send `beforeSpawn` and the claim re-check also block a `code_answer` auto-send when `codeAnswer.away.autoSend` is now false. The send is cancelled as `cancelled_policy_disabled`, and the code-answer row returns to `held` with `code_answer_review`, so the user can still approve it manually. |
| F4.2 | **Code-answer handler timeout.** It is read when the job starts, not at registration (the per-job timeout override the job system supports), so a changed `codeAnswer.timeoutMinutes` applies at once. |

## Out of scope (Batch 2)

- The composer draft lost on remount, and the layout-switch races.
- The history view of cleanup outcomes.
- Non-GitHub hosts, multi-repository tasks, protected-branch override and network-enabled sandboxes.
