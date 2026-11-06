# ADR-040: Sandboxed Test Commands in Develop Runs

- **Status:** Accepted
- **Date:** 2026-11-07
- **Source:** F1 of `docs/superpowers/specs/2026-11-07-followups-batch-1.md` (follow-ups batch 1)

## Context

The develop run (Phase 10, `docs/modules/engineering-tasks.md`) executes the repository's confirmed test command through one `Bash(<testCommand>:*)` grant. Validator rule L limits that grant to a safe test-runner prefix, but the tests themselves are repository code, possibly edited by the model in the same run. Before this decision they ran as the user, with network access and write access everywhere the user can write (`docs/architecture/security-model.md` §3.1, threat model).

Real-CLI findings (2026-11-07, Claude Code 2.1.319, Ubuntu with `kernel.apparmor_restrict_unprivileged_userns=1`, bubblewrap 0.11.1, socat present). Throwaway probes covered writes inside and outside the repository and to `/tmp`, reading a planted secret, child processes, `fetch`, a Docker socket `_ping`, the SSH agent, X11, the runtime directory, `~/.ssh`, `~/.claude`, the Synapse data directory and `/tmp/claude-<uid>`:

- The Claude Code sandbox's seccomp layer fails on this kernel ("nested userns is capability-restricted") unless `network.allowAllUnixSockets: true` is set, which skips that layer. Neither `allowNestedUserNamespaces` nor `enableWeakerNestedSandbox` helps.
- With unix sockets allowed and nothing masked, a test reached the Docker daemon (root-equivalent: the user is in the `docker` group) and saw the SSH agent. Masking with `denyRead` is therefore mandatory. Masking `/run`, `/var/run` and `/tmp` hid the Docker socket, the runtime directory (SSH agent, D-Bus, Wayland) and X11, and a Docker `_ping` failed. `/tmp` became a private writable tmpfs, and masked home directories appeared empty.
- Denying writes to `/tmp` breaks Claude Code's own cwd tracking: every Bash call exits non-zero, which would turn `testsPassed` false. Masking `/tmp` instead, with `TMPDIR` pointed at a private per-run directory re-allowed through `allowRead`, works, and it also hides other Claude sessions' temp files.
- With the final profile: repository writes worked; outside writes, the secret, Docker, the SSH agent, X11 and the network were all blocked; `bun test` passed with a clean exit.

## Decision

| Concern | Choice |
|---|---|
| Contract | `ClaudeJobRequest` and `AIExecutionRequest` carry an optional `sandbox: SandboxSpec` (`{ tmpDir: string; denyRead: string[] }`, `packages/contracts/src/ai.ts`). The zod schema is strict, with at most 64 `denyRead` entries |
| Validator rule M | Runs last, after rule L. An engineering run that grants any `Bash(...)` without a `sandbox` fails with "engineering Bash requires the sandbox". A non-engineering run carrying one fails ("sandbox is for engineering runs only"). `denyRead` must not be empty (the provider appends `/run`, `/var/run` and `/tmp` to it). `tmpDir` and every `denyRead` entry must pass `isSafeAbsolutePath`. `tmpDir` must be neither equal to nor an ancestor of a `denyRead` entry or of `/run`, `/var/run` or `/tmp`, and not equal to or under `/run` or `/var/run`, because its `allowRead` would re-expose that path (for example `/run/user/<uid>` holds the SSH agent and a rootless Docker socket) |
| Exact settings | When `sandbox` is set, the provider merges exactly this into the `--settings` override: `{ sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, excludedCommands: [], filesystem: { denyRead: [...denyRead, "/run", "/var/run", "/tmp"], allowRead: [tmpDir] }, network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true, allowAllUnixSockets: true } } }`. `failIfUnavailable` means a missing sandbox fails the run instead of running unsandboxed; `autoAllowBashIfSandboxed: false` and `allowUnsandboxedCommands: false` keep the Bash grant as narrow as rule L made it; the network block denies every domain |
| Fixed masks | `/run` and `/var/run` hide the Docker socket and the runtime directory (SSH agent, D-Bus, Wayland). `/tmp` hides X11 sockets and other sessions' temp files. They are mandatory because `allowAllUnixSockets` skips the seccomp layer, so the masks carry the socket isolation |
| Home masks | Under `$HOME`, in this order: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config`, `.claude`, `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`, `.cargo/credentials`, `.cargo/credentials.toml`; then the Synapse data directory and the backup directory. Home entries are always kept. This overrides F1.3's "drop an entry that contains the repository" for home entries: dropping `~/.config` for a dotfile repository under `~/.config/nvim` would unmask every credential in it (`~/.config/gh/hosts.yml`). Such a repository is refused instead (next rows). A data or backup directory equal to the repository or containing it is dropped, because masking it would hide the code under test; entries inside the repository stay masked |
| TMPDIR | Each develop run gets `<scratch>/runs/<jobId>`, removed when the run ends (also after a throw, timeout or abort; a failed removal is logged with one fixed line and never replaces the run's result or error). Leftovers from a killed process are swept at API start. `tmpDir` is `<that>/tmp`: created with mode `0700` before the spawn, set as `TMPDIR` in the child env and re-allowed with `allowRead` |
| Repository in a masked path | The develop step refuses, before any run, with the fixed reason `repo_in_masked_path`: a repository whose realpath is at or under `/tmp`, `/run` or `/var/run` (the sandbox would hide it from its own run), and a repository whose realpath is at or inside a home mask entry such as `~/.config` or `~/.claude` (unmasking that directory would expose its credentials) |
| Setting | `engineering.sandbox.enabled` (default `true`, user-editable). Turning it off means **no develop runs, never an unsandboxed one**: the request then carries no `sandbox` and rule M refuses it |
| Failure mapping | A run that exits at startup because the sandbox is unavailable fails the develop step with the fixed reason `sandbox_unavailable`. The task goes to `needs_attention` with the hint "Install bubblewrap and socat (sudo apt install bubblewrap socat), then retry". Sandbox network violations in the tool result do not change `testsPassed`, which still comes from the exit status (ADR-026) |
| Health | New check `sandbox`: `ok` when `bwrap` and `socat` resolve on the service PATH; `degraded` with the hint above otherwise; `ok` with detail `disabled` when the setting is off |

## Consequences

- **System prerequisites:** bubblewrap and socat become system packages that develop runs need. They are not npm dependencies; the `sandbox` health check reports when they are missing.
- **No network for tests:** a repository whose tests need the network cannot use develop runs. This is recorded in the follow-ups.
- **No seccomp layer:** `allowAllUnixSockets` skips it on kernels that restrict unprivileged user namespaces, so the masks carry the socket isolation. Removing a mask would reopen the Docker socket or the SSH agent.
- **Readable outside the masks:** files outside the masks stay readable by the tests. With no network, writes only inside the repository and the private `TMPDIR`, they can leave only through the diff and the test output, which the user sees before approving the commit.
- **Repositories under `/tmp`, `/run`, `/var/run` or a home mask entry** (for example a dotfile repository under `~/.config`) cannot use develop runs (`repo_in_masked_path`).

## Related

- [ADR-026](ADR-026-raw-tool-results-only.md), [ADR-030](ADR-030-single-engineering-task-and-git-workflow.md), [ADR-032](ADR-032-untrusted-content-isolation.md)
- [security-model.md](../../architecture/security-model.md) §3.1, [engineering-tasks.md](../../modules/engineering-tasks.md), [claude-orchestrator.md](../../modules/claude-orchestrator.md)
