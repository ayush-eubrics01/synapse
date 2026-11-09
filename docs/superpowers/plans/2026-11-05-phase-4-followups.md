# Phase 4: Follow-ups and Phase 5 Entry Gate

Phase 4 (Urgency Engine and Inbox) passed per-task reviews, a final whole-branch review, one final fix wave and a controller smoke run. This file keeps the controller rulings and the items deliberately deferred, so they survive after the review workspace is deleted.

## Smoke result

Run on 2026-11-06: `bun scripts/dev/urgency-smoke.ts --pages 1`. It used the real CLI and Slack connector on a temp DB, which was deleted afterwards. Desktop popups were off (no-op notifier), and the output was counts only.

| Messages | Screened | Candidates | Flags | Assessed | Fallback | Run |
|---|---|---|---|---|---|---|
| 20 | 20 | 2 | 1 warning | 1 high, 1 medium | 0 | collect ok, assess ok |

This confirmed real-format end-to-end behaviour:
- screening ran without AI;
- one batched haiku assessment passed the real validator;
- the output was parsed and validated, with no fallback needed.

## Product decisions made during the phase (user may revisit)

- **Thread coalescing (R17).** In an active incident thread, only the first urgent message notifies and gets a draft. Later urgent replies still show in the Urgent Inbox, tagged as follow-ups. A new alert fires only after the earlier item is resolved or dismissed.
- **No identity, no alerts (R18.7).** Until the user confirms their Slack identity on the dashboard, candidates are assessed and listed, but no notifications and no drafts are produced. This avoids alerting the user about their own messages.
- **Desktop notifications (R14, R15).**
  - Delivered through `notify-send`, title only, never message text.
  - At most 5 popups per minute; further popups are collapsed into one summary.
  - Old (backfilled) messages never notify.
- **Deferred to later phases:**
  - Sending drafts and away-mode auto-replies (ADR-033): Phase 6.
  - Jira and Engineering Brain urgency signals: Phases 7 and 8.

## Phase 5 entry gate (People Memory)

| # | Item | Why it matters for Phase 5 |
|---|---|---|
| G1 | **DONE (Phase 5)** **Move the urgent-item and flag DTOs into `packages/contracts`.** They are currently duplicated in modules and `apps/web/lib/api.ts` (CLAUDE.md rule 7) _How: DTOs now live in `packages/contracts` and the web app imports them._ | People pages will reuse them |
| G2 | **DONE (Phase 5)** **Refresh `people.name`/`email` from `slack_users`.** `ensurePerson` currently inserts once and never updates _How: `ensurePerson` refreshes name and email from `slack_users` on every call._ | People Memory profiles key on `people` |
| G3 | **DONE (Phase 5)** **Clarify `setPriority` semantics.** It replaces every field, so omitted fields reset. Either make it a patch or document it at the API _How: `setPriority` is a patch (omitted fields keep their value, `rationale: null` clears it), documented in `people-memory.md`._ | The People UI will edit priority alongside profiles |
| G4 | **Review the remaining borderline high-severity flag patterns** with real data: sentence-initial `Edit(`/`Write(`, "change the system prompt wording", "act as an assistant" in chatbot context, and `hidden.unicode` at `high` | Per-person flag history becomes part of the person page |
| G5 | **DONE (Phase 5)** **Version bump path for starter flag rules.** The seeded rules are a snapshot, so any `STARTER_RULES` change needs a new version _How: `STARTER_RULES_VERSION` plus `init()` inserts and activates a higher starter version, custom higher versions stay active._ | Rule tuning will start once real data flows |

## Deferred minors (polish)

- **Security flags:**
  - The surrogate split at the excerpt window was fixed; still open are the untested `notify-send` timeout kill path and the leftover non-active `init()` edge case (v1 deleted while v2 active).
  - Runtime flags attribute to every sender in a batch (spec-mandated).
- **People:** the self-identity suggestion tests don't discriminate the distinct-count or `im` filter. `ensurePerson` for a missing Slack user is untested.
- **Screening:** the error path emits no `message.screened` event (by design). A malformed `sentAt` routes to `too_old`, which fails safe.
- **Assessment and suggestions:**
  - Missing tests: suggest retry-success, a discarded draft not regenerated, and the e2e context part count.
  - Context for a non-threaded message includes replies from other threads in the conversation.
- **Routes and web:** no pagination on the urgent list. The identity GET loads all people. No render test for the skip button.
- **Recovery and limits:**
  - ~~`skipStale` scans every old row on each assess run~~ **Done in follow-ups batch 3.** `skipStale` is bounded to a recent range. Original note: `skipStale` scans every old row on each assess run. Bound it to a recent range.
  - The recover job is limited to one per clock hour (controller fix), so a deterministic crash loop costs at most 3 runs an hour.
  - `error_max_turns` is classified for every profile. That is unchanged in practice, because the CLI already sets `is_error`.
- **Slack:** searches are not counted when `orchestrator.run` itself throws (Q2 covers failures after a result).

## Controller rulings made during execution (Phase 4)

| ID | Ruling |
|---|---|
| R1 | `DEFAULT_KEYWORDS` is created in Task 1 so the settings default can import it |
| R2 | "Health warning" means a `degraded` health check (`security-rules`, `screening-rules`) |
| R3 | `listByPerson` for per-person flag history |
| R4 | The `exfil.secrets` regex is fixed so it matches ".env" after a space |
| R5 | ReDoS: the comment rule is linear, scanning is capped, and timing tests use 40 KB adversarial corpora |
| R6 | Flag events fire on create and every raise. Notifications fire at or above `notifyOnSeverity`, with the flag's own severity |
| R7 | Every stored excerpt is rendered visible and code-point-capped. The hidden-character class is extended |
| R8 | False-positive tightening: `caseSensitive` rules and the new `exfil.secrets_generic` warning |
| R9 | Slack-unescaped scan, rule caching, seeding in `init()` |
| R10 | `message.screened.candidate` carries the raw candidate value |
| R11 | `urgency.assess` jobs share concurrency group `urgency.assess` |
| R12 | `run` then `parseStructured`, so runtime flags survive invalid output |
| R13 | Assessment text is capped by UTF-8 bytes per part. `batchMax` ≤ 10 |
| R14 | Desktop notifier adapter (`notify-send`, argv only, title only, `--` before the title) |
| R15 | No notifications for old messages. Desktop popups are rate-limited |
| R16 | Runtime flags are also recorded from failed runs (denials, max_turns) |
| R17 | Thread coalescing of notifications and drafts |
| R18 | Recovery sweep, age re-check at assess time, deferral levels gate, red-flag title, single screening per reply, manual identity pick, null-identity suppression, no drafts for fallbacks, docs drift |
