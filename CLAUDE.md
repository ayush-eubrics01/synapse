# CLAUDE.md — Synapse (Engineering Operations Manager)

Synapse is a local-first, single-user service that runs on the user's Linux machine and acts as an operations layer over Slack, Jira, Git repositories and Claude Code. It collects messages and issues, surfaces what needs attention, tracks commitments, keeps an Engineering Brain, and runs controlled engineering work through Claude Code, with the user approving every external action.

**The central rule:** the application manages the work. Claude helps understand and execute it. The user keeps control of important decisions and external actions.

## Read before working

1. This file.
2. `docs/architecture/system-architecture.md` and `docs/architecture/module-boundaries.md`.
3. The module doc in `docs/modules/` for the area you are changing.
4. `docs/architecture/integration-contracts.md` if you touch an integration, the Claude orchestrator or any port.
5. Relevant ADRs in `docs/decisions/ADR/`. Check `docs/product/open-questions.md` before implementing anything it lists.

`pre-project-concept-document/` holds the original specification (`concept.md`), the user's raw requirements, and the Phase 0 feasibility results. It is the historical source. When it and `docs/` disagree, `docs/` wins. If you think `docs/` is wrong, say so; don't silently follow either.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Bun ≥ 1.4.4: runtime, package manager (workspaces) and test runner (ADR-039). The system Node (v16) is never used |
| Language | TypeScript everywhere (strict mode) |
| Frontend | Next.js (`apps/web`), run with `bun --bun next` |
| Backend + workers | Hono on `Bun.serve` (`apps/api`); plain composition root, no DI framework (ADR-038) |
| Database | SQLite via `bun:sqlite` (WAL, foreign keys on, busy timeout) + Drizzle ORM (`drizzle-orm/bun-sqlite`), explicit migrations |
| Validation | Zod; shared schemas in `packages/contracts` |
| Jobs | Database-backed durable queue (no Redis) |
| AI | Claude Code CLI (`claude -p`) behind the `AIProvider` port |
| API | REST + Server-Sent Events, bound to localhost |
| Process management | systemd user services |
| Tests | `bun test`: unit, contract, integration and failure-path tests |

## Repository layout

```text
apps/web/                 Next.js UI — consumes backend APIs only
apps/api/src/
  core/                   Platform: config, events/outbox, jobs, scheduler, leases,
                          permissions, approvals, audit, notifications, health,
                          orchestrator (the only path to Claude)
  modules/                Domain modules (inbox, people, commitments, jira-tracking, security-flags, claude-activity,
                          engineering-brain, engineering-tasks, dashboard, settings)
  intelligence/           Prompt builders + output schemas for AI tasks
  integrations/           Adapters implementing ports (slack, jira, repository, claude-code)
  workers/                Job handlers wiring jobs to module services
  infrastructure/         SQLite/Drizzle, process runner, credential store, notifier
packages/contracts/       Ports, DTOs, event types, Zod schemas (no runtime deps on apps)
packages/database/        Drizzle schema + migrations
packages/shared/          Pure utilities
packages/config/          Shared tsconfig/eslint
docs/                     Product, architecture, module docs, ADRs
pre-project-concept-document/  Original spec and Phase 0 results (maintained, read-only reference)
```

Architecture style: **modular monolith with ports and adapters (hexagonal).** Domain modules depend on ports in `packages/contracts`; adapters in `integrations/` and `infrastructure/` implement them. See `docs/architecture/module-boundaries.md` for allowed dependencies.

## Hard rules

1. **Never bypass the orchestrator.** Only `core/orchestrator` may run Claude Code. Feature modules and adapters submit work to it; they never spawn `claude` themselves.
2. **Never bypass permissions or approvals.** Every external write (Slack send, Jira change, code change, commit, push, PR, merge, deploy) goes through the permission manager and approval engine. The only exception is ADR-033 away-mode auto-replies to priority people, which go through the deterministic `AutoReplyPolicy` and always carry the tag `Sent using @claude`.
3. **Raw tool results are the only trusted data.** Parse source data only from `tool_result` events in Claude's `stream-json` output. Never store the model's text reply as source data. A run with no real tool result for the expected tool has failed. (ADR-026)
4. **One engineering task at a time.** A global engineering lock is held from pickup until PR merge or cleanup. (ADR-030)
5. **Untrusted content never reaches a worker that can act.** Every prompt part carries a provenance tag; the orchestrator's request validator rejects untrusted content alongside any write/send tool, and any untrusted content in engineering runs. The engineering worker receives only the user-approved task description. Suspected injection attempts become red flags (ADR-032, ADR-034).
13. **Branches come from the registry and the user.** Each engineering task uses the parent branch the user confirmed (ADR-035). Never push to `upstream`.
14. **Interactive Claude Code sessions are observed, never read or controlled.** Only metadata from `~/.claude/projects` for registered repos (ADR-036). Synapse's own runs always use `--no-session-persistence`.
6. **Business logic stays out of the frontend.** Widgets and pages call backend APIs only.
7. **Use shared contracts** at every integration boundary. Don't import adapter internals from modules.
8. **Every schema change has a migration.** Never edit an applied migration.
9. **No secrets in code, prompts or logs.** Never read or log tokens from `~/.claude/.credentials.json`; only the expiry metadata.
10. **No Redis, no microservices, no new runtime dependency** without an ADR.
11. **External systems stay authoritative.** Never overwrite Slack, Jira or Git state based only on AI interpretation.
12. **Don't invent answers.** If an assumption is unresolved, say so and check `docs/product/open-questions.md`.

## Claude Code invocation profile (validated in Phase 0)

All runs go through the orchestrator and use this shape:

```bash
claude -p "<prompt naming exact tools and arguments>" \
  --setting-sources user --settings "$OVERRIDE" --disable-slash-commands \
  --system-prompt "<short worker-specific prompt>" \
  --allowedTools "ToolSearch,<only what this job needs>" \
  --disallowedTools "<explicit denylist>" \
  --model <haiku for collection/screening> --max-turns <calls + 3> \
  --no-session-persistence --output-format stream-json --verbose < /dev/null
```

- `$OVERRIDE` is `{"enabledPlugins":{"<each plugin name from ~/.claude/settings.json>":false},"hooks":{}}`: plugin names only, read once at startup; `{"enabledPlugins":{},"hooks":{}}` if the file can't be read. Since CLI 2.1.318, `--setting-sources ""` loads no claude.ai connectors; `user` loads them, and the override drops the user's plugins and hooks (R34, 2026-11-05).
- `--bare` is unusable (API key only; connectors need claude.ai OAuth).
- Never use `--tools`; it hides MCP connector tools. Use `--allowedTools`/`--disallowedTools`.
- Always allow `ToolSearch`; connector tools are deferred.
- Read quota from the `rate_limit_event` (five-hour and seven-day utilization) and gate jobs on it. (ADR-029)

## Before implementing a feature

Produce a short plan naming: relevant modules, contracts used or changed, database changes, events, permissions, tests, docs affected. Then implement in small steps.

## Definition of done for any change

- Tests for the new workflow, including at least one failure path.
- Migrations for schema changes.
- Docs updated (module doc, contracts, ADR if a decision changed).
- Compiling is not proof of correctness. Run the tests and, where relevant, the app.

## Commands

```bash
bun install                    # install all workspaces
bun run check                  # typecheck (tsc -b) + lint (biome) + tests
bun test                       # run all tests
bun run --cwd apps/api dev     # API on 127.0.0.1:7400
bun run --cwd apps/web dev     # web on 127.0.0.1:7401
bun scripts/setup/check-env.ts # read-only env check (bun >= 1.4.4, claude on service PATH, linger)
bun scripts/dev/claude-smoke.ts [--no-tools|--deny-check]  # real Claude run on a temp DB; spends a tiny amount of Claude quota — run deliberately
```

Setup commands that change the system. **Ask the user for approval before running any of these:**

```bash
bun scripts/setup/install-services.ts   # writes ~/.config/systemd/user/synapse-{api,web}.service, prints the next commands
loginctl enable-linger "$USER"          # keep user services running after logout
systemctl --user daemon-reload && systemctl --user enable --now synapse-api synapse-web
```
