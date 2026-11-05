# ADR-036: Observe Interactive Claude Code Sessions (Metadata Only)

- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** Resolves OQ-5 (requirement 7: "admin cum operations manager of my Claude Code"); user asked for the option that best fits the use case

## Context

Requirement 7 asks Synapse to act as admin and operations manager of the user's Claude Code, to keep development moving. Synapse already controls the runs it launches itself. The user's own interactive sessions matter too:

- They use the **same five-hour/seven-day quota**. Heavy background jobs while the user is working can lock the user out.
- They hold **work in progress**: which repo and branch the user is working on, and which PRs were opened from a session.

Claude Code stores each session as a JSONL file under `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Inspection on 2026-11-05 (field names only) found metadata such as `cwd`, `gitBranch`, `sessionId`, `timestamp`, `version`, `entrypoint`, `ai-title` lines (session title) and `pr-link` lines (`prUrl`, `prNumber`, `prRepository`). The format is internal and undocumented.

Options:

1. Only manage Synapse-launched jobs. Misses quota contention and work in progress.
2. Read and summarize session content. Costs quota, copies sensitive content, and is intrusive.
3. **Observe metadata only.** Free (no AI), low risk, and covers both needs.

## Decision

Synapse **observes, but never reads content from or controls**, interactive Claude Code sessions.

### What is read

From session files whose `cwd` is inside a **registered repository** (ADR-035), only:

| Field | Use |
|---|---|
| `sessionId`, `cwd` → repository | Group sessions by repo/project |
| `gitBranch` | Branch the user is working on |
| `timestamp` (first/last), file modified time | Started, last active, "active now" |
| `ai-title` | Human-readable session title |
| `pr-link` (`prUrl`, `prNumber`, `prRepository`) | PRs opened from the session |
| `version`, `entrypoint` | Diagnostics |

Message content, tool inputs/outputs, thinking, attachments and prompts are **never read into Synapse or stored**. The parser skips those line types without decoding them further.

### What it's used for

1. **Yield to the user.** If any interactive session was active within the last `activeWindowMinutes` (default 10), the orchestrator treats the quota as if it were at the `soft` level: only urgent assessment, incremental collection and approved/auto-reply sends run. Heavy analysis and engineering steps wait until the user has been idle (ADR-029).
2. **Claude Code activity widget.** Per repository: recent sessions (title, branch, last active), sessions active now, and PRs opened from sessions.
3. **Keep development moving.**
   - Link session PRs to Engineering Brain projects, engineering tasks and Jira issues where the branch or PR matches.
   - Remind the user about work in progress: a branch with session activity but no PR after N days, or a session PR still open after N days.
   - Reminders go to the user only. Nothing is sent to anyone else.

### Rules

- Read-only file access. No AI calls. Incremental parsing by file offset.
- Only registered repositories. Sessions in other folders are ignored entirely.
- Synapse never resumes, writes to, or injects into a user session.
- Synapse's own runs use `--no-session-persistence`, so they never appear as sessions. (Phase 0 runs made without it did leave transcripts; they were deleted.)
- The format is undocumented. The parser is tolerant: unknown line types are skipped. If no known fields can be read, observation is disabled with a health warning, and the rest of Synapse is unaffected.

## Consequences

- **Positive:** background work stops competing with the user's own Claude use. The user sees work in progress and session PRs in one place, at zero quota cost.
- **Positive:** no session content is copied into Synapse.
- **Negative:** depends on an undocumented file format that may change with Claude Code updates. Contract tests use small synthetic fixtures; failures degrade gracefully.
- **Deferred:** content summaries of sessions. They would need explicit opt-in and a new ADR.

## Configuration

| Key | Default |
|---|---|
| `claudeActivity.enabled` | `true` |
| `claudeActivity.scanIntervalSeconds` | `120` |
| `claudeActivity.activeWindowMinutes` | `10` |
| `claudeActivity.yieldWhenActive` | `true` |
| `claudeActivity.staleBranchDays` | `3` (proposal) |
| `claudeActivity.openPrReminderDays` | `3` (proposal) |

## Related

- [ADR-029](ADR-029-quota-gate-on-rate-limit-event.md), [ADR-031](ADR-031-collector-worker-profile.md), [ADR-035](ADR-035-repository-branch-registry.md), [ADR-016](ADR-016-central-engineering-brain.md)
- [claude-orchestrator.md](../../modules/claude-orchestrator.md), [open-questions.md](../../product/open-questions.md)
