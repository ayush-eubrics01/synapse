# ADR-037: Keep the Claude Code Login Alive Without Repeated Re-Login

- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** Resolves OQ-4 (user: "I would not want to login again and again"; decision delegated to Claude)

## Context

Synapse runs Claude Code headless under the user's claude.ai login. Connectors (Slack, Jira) need this OAuth login. `--bare` and API keys can't reach them (Phase 0).

Credentials metadata (`~/.claude/.credentials.json`, read for expiry only):

- The access token lasts a few hours. Claude Code refreshes it automatically using the refresh token.
- On 2026-11-05 the refresh token expiry was 2026-11-12 23:59, about 7 days out. Still unknown: whether each refresh pushes that date forward (sliding) or it's fixed.
- `claude setup-token` creates a long-lived (reportedly 1-year) token. A public Claude Code issue reports that claude.ai connectors didn't sync when authenticating with that token (`CLAUDE_CODE_OAUTH_TOKEN`). The issue is closed, with no confirmed resolution. Not proven to work for Synapse.

The user's goal is to log in as rarely as possible, ideally never again.

## Decision

1. **Synapse never touches tokens.** It doesn't refresh, copy, store or log them. Claude Code's own automatic refresh stays the only mechanism. This avoids racing with the user's interactive sessions over a rotating refresh token.
2. **Synapse keeps the login warm.** Its regular collection runs (every 10 minutes) call Claude Code often enough that access tokens are refreshed long before they lapse. If the refresh token slides, this alone means the user never has to log in again.
3. **Synapse watches the expiry and learns which case applies.** After each run, the health monitor records `expiresAt` and `refreshTokenExpiresAt` in `auth_snapshots`.
   - If `refreshTokenExpiresAt` moves forward after a refresh → **sliding confirmed**. Record it, close the question for good, keep warnings as a safety net only.
   - If it stays fixed → warn 48 h and 2 h before expiry, so the user can re-login once at a convenient time (`claude` → `/login`), then evaluate step 5.
4. **Auth failure is handled calmly.** On `auth_failed`, all Claude jobs pause: one notification, one `NEEDS_ATTENTION` item, no retry storm. Jobs resume automatically after a successful health check following re-login.
5. **Fallback, only if the expiry turns out to be fixed:** test a `claude setup-token` long-lived token in a throwaway run, and check the `system/init` event for `claude.ai Slack` / `claude.ai Atlassian` connected (the same check as Phase 0 Test 2). Adopt it, through the OS credential store per the security model, only if the connectors load. Otherwise accept a periodic re-login with advance warning.

## Consequences

- **Positive:** the most likely outcome is no re-login at all. Synapse has no credential-handling code. Failures are visible and quiet.
- **Negative:** if the expiry is fixed and `setup-token` doesn't support connectors, a re-login about once a week remains. It's announced 48 h ahead.
- **Follow-up:** the first refresh after 2026-11-05 18:42 shows whether the expiry slides. Synapse's health monitor records it automatically once running. Until then it can be checked by hand.

## Related

- [ADR-029](ADR-029-quota-gate-on-rate-limit-event.md), [ADR-031](ADR-031-collector-worker-profile.md), [ADR-036](ADR-036-interactive-session-observation.md)
- [runtime-design.md](../../architecture/runtime-design.md), [security-model.md](../../architecture/security-model.md), [open-questions.md](../../product/open-questions.md)
