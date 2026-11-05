# ADR-032: Untrusted Content Isolation
- **Status:** Proposed
- **Date:** 2026-11-05
- **Source:** Architecture review of concept.md and requirements.md

## Context
Anyone who can post in a Slack conversation the user can see, or write in a Jira issue, controls text that ends up in Claude prompts. If the same Claude run could edit repositories, run shell commands, send Slack messages or use the user's other connectors, an instruction hidden in a message (prompt injection) could trigger real actions. The concept scopes capabilities per worker but doesn't state this rule outright.

## Decision
- Raw Slack and Jira content goes only to Collector and Intelligence workers. Those workers never receive send, write, shell or file-edit tools.
- The Engineering worker never receives raw Slack or Jira text. It receives only a task description the user has approved, plus repository context.
- Every run gets an explicit `--disallowedTools` list, including all claude.ai connector tools it doesn't need.
- Drafts produced by Intelligence workers are data. They are sent only by the approval engine after user approval (ADR-013).

## Consequences
- Positive: a malicious or accidental message can't trigger code changes, sends or data exfiltration through tools.
- Negative: the engineering worker loses some original context; the approved task description must be complete enough to work from.
- Follow-up: needs user confirmation before it becomes Accepted.

## Related
- [ADR-013](ADR-013-manual-approval-for-external-writes.md), [ADR-031](ADR-031-collector-worker-profile.md), [ADR-030](ADR-030-single-engineering-task-and-git-workflow.md)
- [security-model.md](../../architecture/security-model.md), [claude-orchestrator.md](../../modules/claude-orchestrator.md)
