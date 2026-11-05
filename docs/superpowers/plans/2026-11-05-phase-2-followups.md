# Phase 2 — Follow-ups and Phase 3 Entry Gate

Phase 2 (Claude Orchestrator) passed per-task reviews, a final whole-branch review, one final fix wave, and controller smoke runs against the real Claude Code CLI 2.1.318. This file keeps what was deliberately deferred, so it survives after the review workspace is deleted.

## Smoke results (2026-11-05, real CLI)

- `--no-tools`: succeeded. Structured output was validated. Quota was read: five-hour 0.43, seven-day 0.13.
- `--deny-check`: **PASS**. The Gmail connector was `connected`, and with the server-level deny zero Gmail tools were listed.
- **Discovered:** `--setting-sources ""` no longer loads any claude.ai connector on 2.1.318. It was replaced by `--setting-sources user --settings {"enabledPlugins":{…false},"hooks":{}}` (Ruling R34), which loads connectors with no hooks and about 25k context tokens.

## Phase 3 entry gate (fix before or during the Slack collector)

| # | Item | Why it matters for Phase 3 |
|---|---|---|
| P1 | **Auth pause (ADR-037 §4).** After `auth_failed`, block all Claude runs until the credentials expiry changes or a probe succeeds. Raise one notification and one NEEDS_ATTENTION item. Call `auth.record()` once at startup | The collector runs every 10 minutes. Without this, every run spawns claude and creates its own NEEDS_ATTENTION item |
| P2 | Cap `resetsAt` at `observedAt + 8 days` | A malformed far-future reset (e.g. ms instead of s) would stop all work, with no way to recover except manual repair |
| P3 | Narrow the text-based quota regex (`usage limit|rate limit|quota (exceeded|exhausted|reached)`), or cap consecutive text-only quota deferrals | Deferrals don't consume attempts, so a false positive re-spawns every 15 min forever |
| P4 | When `rate_limit_info.unifiedWindows` is missing, map the top-level `status`/`resetsAt`/`rateLimitType` onto the matching window | Otherwise a rejection reported only at top level is missed |
| P5 | Cache `claude --version` health with a TTL | Every dashboard refresh spawns a process |
| P6 | Sweep `claude_runs` rows left `running` at startup | A crash leaves orphan rows |
| P7 | Lint/boundary rule: only `core/orchestrator` may call `Container.provider.execute` | Prevents bypassing the validator |
| P8 | Rebuild the plugin override when plugins change (or document "restart after installing plugins") | Plugins installed after API start aren't disabled |

## Before the first send-run phase

- External-write uncertainty is implemented (`details.uncertain`, with the worker parking the job). Refinement: don't mark uncertain when no send `tool_use` was observed.
- The tool-name grammar rejects hyphens (e.g. Canva's `comment-on-design`). Widen it when such connectors are needed.

## Deferred minors (polish)

- **Queue/worker:** G1 test fakes the reaper; G7 suppressed-failure count not reported; tests use `?.leaseOwner ?? ""` instead of `must()`.
- **Contracts:** no drift guard between the TS types and Zod schemas; `instructions` accepts an empty string.
- **Parser:** array content joined with `""`; `finalText` has no separator; O(n²) buffering.
- **Validator:** a stray test field; an escaped-paren allow entry fails closed in the CLI; an unknown-server single connector tool is treated as a send run (fails closed).
- **Provider:**
  - an ENOENT from a bad `workingDirectory` is reported as a missing binary (partly addressed by error codes);
  - setsid grandchildren outside the process group survive a run;
  - the hard-deadline timer is effectively untested.
- **Quota/auth:**
  - `authCheck` hardcodes 48 h/2 h while the warning reads a setting;
  - a read error is checked before the last known expiry;
  - the dedupe setting is written after the transaction;
  - every rejected window gets an `observedAt + 1h` floor, so up to ~55 min of extra deferral.
- **Orchestrator:** correlation id per event; provider throw class name not recorded; legacy-row quota fallback untested.
- **Wiring:** the panel shows nothing for `slides` false/null; `AppConfig` could carry the resolved `home` instead of recomputing it.
- **Smoke:** `summarize` is called without `runId`; the Gmail prefix match lacks a `__` boundary.
- **Docs:** the plan's Task 4 text (line ~184) still shows the old `--setting-sources ""` argv; concept.md mentions the old flag (historical).

## Controller rulings made during execution (Phase 2)

| ID | Ruling |
|---|---|
| R17 | `StreamParser.end(now)` |
| R18 | Orchestrator has an `audit` dependency |
| R19 | Validator rule 0: collector/intelligence can't use write/network built-ins; deterministic denylist; source attribute sanitised |
| R20 | Engineering may not use any `mcp__` tool |
| R21 | A send run allows only its write tool plus ToolSearch |
| R22 | Network built-ins rejected in every profile and always denied |
| R23 | Tool-name normalisation; MultiEdit/Monitor are write, Task is network; unknown built-ins are rejected |
| R24 | The validator checks that the prompt equals `assemblePrompt(instructions, parts, boundary)`; empty boundary rejected |
| R25 | Known-server list extended; `listJiraIssueComments` is read |
| R26 | Strict allowlist tool-name grammar; denylist must contain the network/write built-ins |
| R27 | Strict denylist entry grammar; empty allowlist rejected; `mcp__workspace` known |
| R28 | CLI provider classification precedence |
| R29 | Success requires exit code 0; first cause wins between abort and timeout |
| R30 | Per-window quota status columns |
| R31 | Learned connector names validated |
| R32 | `availableTools` (init tool names) on results; deny-check verdict |
| R33 | Final fix wave scope (I1–I4, I6 + small items; auth pause deferred to P1) |
| R34 | Invocation uses `--setting-sources user --settings <plugins/hooks off>` |
