# ADR-013: Manual Approval for External Writes
- **Status:** Accepted
- **Date:** 2026-11-05
- **Source:** concept.md §1.2, §7.4, §10.3, §18

## Context
Synapse can draft Slack messages, modify Jira, change code, commit, push, merge and deploy. Mistakes there are visible to colleagues or hard to reverse.

## Decision
Every external write needs user approval by default, enforced centrally by the permission manager and approval engine. Approvals are scoped (action, target integration, target entity, exact change, repository or conversation, risk, expiry) and revalidated just before execution. Approving one step never authorizes another: investigating ≠ modifying code ≠ committing ≠ pushing ≠ merging ≠ deploying. Deploy requires explicit approval.

## Consequences
- Positive: nothing leaves the machine without the user's consent; full audit trail.
- Negative: work waits while the user is away.
- Amended by [ADR-033](ADR-033-away-mode-auto-replies.md): in away mode, tagged auto-replies to priority people (code answers, stalled reminders, follow-up questions, acknowledgements) are sent without approval after deterministic policy checks. Every other external write still needs approval.
- Rule: modules never call write adapters directly. Only the approval engine executes approved actions.

## Related
- [ADR-033](ADR-033-away-mode-auto-replies.md), [ADR-030](ADR-030-single-engineering-task-and-git-workflow.md), [ADR-032](ADR-032-untrusted-content-isolation.md)
- [security-model.md](../../architecture/security-model.md), [open-questions.md](../../product/open-questions.md)
