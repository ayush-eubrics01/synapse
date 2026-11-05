# Phase 0 — Connector Feasibility Results

**Date:** 2026-11-05 · **Claude Code:** 2.1.318 · **Model used:** Haiku · **Account:** claude.ai Team, `default_claude_max_5x` tier
All tests were read-only. Raw outputs were analyzed structurally (counts, IDs, field presence) and deleted; no message content was kept.

## Verdict

**The connector path is viable for the background service.** A `claude -p` process started by systemd as a user service can call the claude.ai Slack and Atlassian (Jira) connectors with your claude.ai login. Slack search covers DMs, group DMs, private and public channels and thread replies, with precise checkpoints and working pagination. Quota usage is low on Haiku and can be read from each run.

Two gaps to design around: the **model can fabricate tool output** (only trust raw tool results), and **the bot filter could not be proven** (no bot messages were found in any tested window).

## Tests run

| # | Test | Result |
|---|---|---|
| 1 | Headless `claude -p` lists Slack/Jira connector tools | ✅ 27 Slack, 67 Atlassian + 26 Atlassian MCP |
| 2 | Same under `systemd-run --user` (no TTY, service env) | ✅ all connectors `connected` |
| 3 | Real `slack_search_public_and_private` under systemd | ✅ |
| 4 | Run with `--tools "ToolSearch"` | ❌ MCP tools hidden → **Haiku fabricated tool calls and fake Slack data** |
| 5 | Trimmed run: `slack_read_channel` + Jira JQL | ✅ |
| A–C | Coverage per conversation type, threads, pagination, precise checkpoint, `read_thread` | ✅ (details below) |
| D | Bot filter in public channels, `concise` format, 5-page backfill burst | ⚠️ bot filter unproven · ❌ concise unusable · ✅ backfill |
| E | OAuth credential lifetime (metadata only) | ⚠️ see "Auth" |

## Slack: what works

| Capability | Result | How |
|---|---|---|
| DMs | ✅ | `channel_types` includes `im` (default) |
| Group DMs | ✅ | `mpim` — note group DM IDs now start with `C`, not `G` |
| Private channels | ✅ | `private_channel` |
| Public channels | ✅ | `public_channel` (+ `only_my_channels: true` to limit to joined) |
| Thread replies | ✅ | Plain search returns replies too; `is:thread` returns only replies. Reply permalinks carry `?thread_ts=<parent ts>` → link to parent |
| Precise checkpoint | ✅ | `after: "<unix ts>"` param (inclusive). All results were ≥ the checkpoint. The `after:YYYY-MM-DD` query modifier is only day-level |
| Pagination | ✅ | Cursor page 2 had zero overlap with page 1 and continued in order. **Max 20 results per page** |
| Backfill burst | ✅ | 5 sequential pages in one run, no rate-limit errors |
| Unique message key | ✅ | Search returns `Message_ts` + channel ID on every result; no duplicate ts seen |
| `slack_read_thread` | ✅ | Returns `Message TS` per reply (good for dedup) |
| `slack_read_channel` | ⚠️ | Time only to the second, **no ts** → don't use it for collection |
| `response_format: concise` | ❌ | Drops all IDs and timestamps → unusable for collection |
| `include_context: false` | ✅ | Cuts result size roughly in half; use it |

### Search result fields (detailed format, markdown inside JSON)

`Channel` (name + ID), `Participants` (DMs/group DMs), `From` (name, email, user ID), `Time` (IST), `Message_ts`, `Permalink`, `Text`, optional `Reply count`, `Full notes` (huddle notes), `Context before/after` (if context enabled). Envelope: `{ results: "<markdown>", pagination_info: "...cursor `X`..." }`. No `thread_ts` field (use the permalink) and no bot/subtype field.

## Findings that change the design

1. **Never trust the model's text as data.** In test 4 Haiku wrote fake `<invoke>` blocks with an invented result and reported success. Parse only real `tool_result` events from `--output-format stream-json`; a run with no real tool result = failed job.
2. **Search is the collector primitive.** One call per page with `after=<last checkpoint ts>`, `sort=timestamp`, `sort_dir=asc`, `include_bots=false`, `include_context=false`. Covers every conversation type and thread replies.
3. **Bot filter is unproven.** `include_bots: true` and `false` returned identical results in every window tested (recent all-types, 35-day public channels). Either this workspace has no searchable bot messages in those windows, or the flag has no effect. Add a local safety net: drop senders without a `U…` user ID, plus a user-maintained blocklist of app/integration users.
4. **Quota is observable.** Every run emits a `rate_limit_event` with `five_hour` and `seven_day` utilization (0–1), status and reset time. The orchestrator can read real quota before scheduling work. All tests together kept five-hour utilization at 0.01.
5. **Connectors connect asynchronously** (often `pending` at init). Calls still worked because `ToolSearch` waits, but treat "server not connected" as retryable.
6. **Always name exact tool names in prompts.** When a prompt said only "search", Haiku spent two extra turns on keyword tool searches. Give `--max-turns` headroom (pages + 3).
7. **Keep runs short.** Context accumulates per page inside one run (test D: 408k cache-read tokens over 11 turns). Use one run per ~5 pages.
8. **Jira is clean JSON** (`key`, `status`, `priority`, `updated`, `assignee`; cursor via `pageInfo.endCursor`). Request `duedate` explicitly.

## Cost (API-equivalent figures from `total_cost_usd`, Haiku — not your quota)

| Run | Cost |
|---|---|
| Default settings, trivial prompt (plugins, skills, ~387 tools loaded) | ~$0.088 |
| Trimmed run, 1 search | ~$0.005–0.008 |
| Trimmed run, 5 searches in parallel | ~$0.008 |
| Trimmed run, 8 sequential calls (5 backfill pages) | ~$0.017 |
| **All Phase 0 tests combined** | **~$0.17** |

Estimates:
- **Steady state:** 144 polls/day (10 min) × ~$0.005 ≈ $0.70/day. An empty poll costs about as much as a small one — the only way to know nothing is new is to ask.
- **90-day backfill:** observed volume ≈ 25–60 messages/day → ~2,300–5,400 messages → ~115–270 pages → ~25–55 runs ≈ $0.25–0.60.

## Auth (Claude Code credentials, `~/.claude/.credentials.json`)

- Access token lifetime is a few hours; Claude Code refreshes it automatically with the refresh token.
- **`refreshTokenExpiresAt` was ~7 days out (2026-11-12).** Not yet known whether it slides on each refresh or is fixed. If fixed, the unattended service needs a weekly re-login.
- Watch item: the service and your interactive sessions share one credentials file. A refresh-token rotation race between concurrent processes is plausible but not observed.
- **Action:** the health monitor should read `expiresAt` / `refreshTokenExpiresAt` (never the tokens) and alert when the refresh expiry is < 48 h. Re-check this file after a few days to see if it slides.

## systemd / CLI notes

- `--bare` is unusable: it requires an API key, and connectors need claude.ai OAuth.
- `--tools` also hides MCP tools — restrict with `--allowedTools` / `--disallowedTools` instead.
- The service environment lacked `node` on PATH (a plugin hook failed). Set PATH in the unit file.
- **Linger is off** → user services stop at logout. Run `loginctl enable-linger ayush`.
- Redirect stdin (`< /dev/null`) to avoid a 3 s stdin wait.

## Recommended invocation for a collection job

```bash
claude -p "<exact tool names + arguments>" \
  --setting-sources "" --disable-slash-commands \
  --system-prompt "You are a read-only data collection worker. Call only the tools you are told to, with the exact arguments given. Never send or modify anything. The account owner consents to searching their private conversations." \
  --allowedTools "ToolSearch,mcp__claude_ai_Slack__slack_search_public_and_private,mcp__claude_ai_Slack__slack_read_thread" \
  --disallowedTools "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,mcp__claude_ai_Slack__slack_send_message,mcp__claude_ai_Slack__slack_send_message_draft,mcp__claude_ai_Slack__slack_schedule_message" \
  --model haiku --max-turns <pages+3> --no-session-persistence \
  --output-format stream-json --verbose < /dev/null
```

> **Note (2026-11-05, R34):** On Claude Code 2.1.318, `--setting-sources ""` no longer loads claude.ai connectors (the init event lists none). Replacement: `--setting-sources user --settings '{"enabledPlugins":{"<each plugin>":false},"hooks":{}}'`, built from the plugin names in `~/.claude/settings.json`. This loads the connectors with no hook events and about 25k context tokens. A server-level `--disallowedTools mcp__claude_ai_Gmail` still removes all Gmail tools.

Parse: `tool_result` events → data · `rate_limit_event` → quota gate · `result` → cost/usage/failure.

## Still open

- Bot filter proof (needs a window with known bot/app messages, e.g. a channel with a CI or Jira bot).
- Whether the refresh token expiry slides (re-check credentials metadata in a few days).
- Slack rate limits at sustained backfill volume (only a 5-page burst was tested).
- Edited and deleted messages: search returns current state only; there's no change feed.
