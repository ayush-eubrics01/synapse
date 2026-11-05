# Urgency Engine and Urgent Inbox

Covers screening and urgency logic. Rules live in `apps/api/src/intelligence/screening`, the assessment prompt and schema in `intelligence/urgency`, and the state in the `inbox` module (`slack_messages.urgency_*`).

## Purpose

Make sure the few messages that need the user now reach them immediately, without calling Claude for every message. It also gives the user a clear view of their priority people (requirement 5b).

## Responsibilities / Non-responsibilities

Responsibilities:

- Cheap rule-based screening of every new message (no AI).
- Contextual urgency assessment by Claude, for candidates only.
- Assigning Critical/High/Medium/Low with a reason.
- Urgent Inbox: notification, context, suggested response or action, acknowledgement and status tracking.
- Routing non-urgent messages to batch analysis.

Non-responsibilities:

- Sending responses or starting engineering work. Suggestions are drafts, and every external action needs approval.
- Setting people priority (People Memory, user only).

## Owned data

Fields on `slack_messages`: `screening` (JSON: matched rules, score), `urgency_level`, `urgency_reason`, `urgency_status` (new/acknowledged/in_progress/resolved/dismissed). Suggested responses are stored as drafts linked to an approval when the user chooses to send.

## Three signals

1. **People priority:** manual priority from `people_priority_settings`.
2. **Message urgency:** production incidents, explicit blockers, immediate deadlines, time-sensitive requests.
3. **Work context:** release blockers, deployment problems, delivery dependencies, work blocking a colleague (uses Engineering Brain milestones and Jira state).

People priority alone never makes a message urgent. It raises screening sensitivity and ordering only.

## Pipeline

```text
message.received
  → rule screening (no AI)
       keywords/patterns (prod, down, outage, urgent, blocker, ASAP, deadline, today, …)
       DM vs channel, mentions of the user, priority person, thread with the user,
       Jira keys of blocked/due issues, upcoming go-live projects
  → message.screened {candidate: bool, score, matchedRules}
       │
       ├─ candidate → urgency.assess (batched within a short window)
       │                → Critical / High / Medium / Low + reason
       │                → Critical/High: Urgent Inbox + notify + message.urgent_detected
       │                                 + suggested response/action (draft)
       │                → Medium/Low: normal processing
       └─ not candidate → batch analysis (commitments, people, brain)
```

## Urgency levels

| Level | Meaning | Behaviour |
|---|---|---|
| Critical | Production incident or severe immediate impact | Immediate notification |
| High | Time-sensitive request or important blocker | Immediate notification |
| Medium | Needs attention but can wait | Normal processing |
| Low | Informational or routine | Normal processing |

## Ports used / provided

- `ClaudeOrchestrator`, intelligence profile, for `urgency.assess` and drafting. Message text is untrusted input. The worker has no send or write tools (ADR-032).
- Reads `people`, `jira-tracking` and `engineering-brain` public services for signals 1 and 3.
- `NotificationService` for alerts.

## Jobs

| Job type | Trigger | Profile / model | Idempotency key | Retry |
|---|---|---|---|---|
| `urgency.assess` | candidates from screening, micro-batched (e.g. 2 min window or 10 messages) | intelligence / haiku | `urgency:<sorted message ids hash>` | 3; on final failure, fall back to rule level |
| `urgency.suggest_response` | Critical/High result | intelligence / haiku or sonnet | `urgency.suggest:<messageId>` | 3 |

Urgent assessment jobs get high queue priority. The quota gate (ADR-029) may still defer them when the five-hour window is exhausted. In that case the rule-based level is shown with "not yet assessed."

Requirement 5c (answering questions while the user is out): `urgency.suggest_response` can use the engineering profile in read-only mode to inspect the registered repository and draft a technical answer. Whether that answer may be sent without approval is OQ-1.

## Events

Emitted: `message.screened`, `message.urgent_detected`.

Consumed: `message.received`, `message.thread_updated`, `person.profile_approved` (priority refresh), `jira.issue_blocked`, `claude.job_completed` / `failed`.

## Permissions and approvals

Assess and suggest: allowed. Send a suggested response: approval required. Start engineering work from an urgent message: approval required (goes to `engineering-tasks` as a proposal).

## Failure handling

- Assessment fails or quota blocks it → keep the rule-based screening score, mark it "unassessed", and still notify if the rules indicate a likely incident.
- Invalid AI output → retry; after max attempts fall back as above.
- Notification adapter failure → in-app notification remains; health reports degraded.

## Configuration

| Key | Default |
|---|---|
| `urgency.rules.keywords` | default list, user-editable |
| `urgency.assess.batchWindowSeconds` | `120` |
| `urgency.assess.batchMax` | `10` |
| `urgency.notify.levels` | `critical,high` |
| `urgency.model` | `haiku` |

## Tests

- Priority person + routine message → not urgent.
- Non-priority person + production incident → Critical.
- Non-candidate messages never trigger a Claude run.
- Quota exhausted → rule fallback, notification still sent for likely incidents.
- Invalid assessment output → retry, then fallback.
- Suggested response never sent without approval.
- Acknowledge/resolve status transitions.

## Open questions

- **OQ-1:** auto-reply while away (requirement 5c) vs the approval rule.
- **OQ-2:** notifications and approvals while away. Desktop notifications don't reach the user when they're out, and the app is localhost-only.

See `docs/product/open-questions.md`.
