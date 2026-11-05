# Product Vision

## The problem

The user is a developer whose work is scattered across Slack, Jira and several Git repositories:

- Important messages are spread over DMs, group DMs and channels, and get lost.
- Some people's messages matter much more than others, and there is no clear way to see that.
- When the user is away, delivery people and colleagues wait for answers that are often already in the code.
- Bugs and small tasks get reported in chat and are easy to miss. Small ones could be fixed before the user is back.
- Task specs are often unclear, and someone needs to ask follow-up questions.
- Conversations stall ("I'll check and let you know") and nobody tracks them.
- Release and go-live dates for the user's projects aren't tracked in one place.
- Jira tasks pile up without close monitoring.
- Claude Code usage is limited (a five-hour window), so it must not be wasted.

## The product

**Synapse** is a local, always-on Engineering Operations Manager. It runs as a background service on the user's Linux machine and acts as an operations layer over Slack, Jira, Git repositories and Claude Code.

It:

1. Collects human Slack messages (DMs, group DMs, channels; no app/bot messages) and Jira activity into one place.
2. Ranks what needs attention, using people priority, message urgency and work context.
3. Keeps approved profiles of important people, so responses fit each person.
4. Tracks commitments made by the user and by others, and reminds and follows up.
5. Maintains an Engineering Brain: projects, decisions, milestones, go-live dates.
6. Uses Claude Code to answer questions from the code, investigate bugs, and prepare small fixes on a branch for approval.
7. Acts as an admin/operations manager for Claude Code: schedules its work, protects the quota, and logs everything.
8. Shows all of this on a customizable dashboard.

## Principles

1. **The user stays in control.** Every external action (sending a message, changing Jira, changing code, committing, pushing, merging, deploying) needs approval.
2. **Local-first.** Everything runs and is stored on the user's machine.
3. **Claude is a provider, not the system.** Synapse owns state, scheduling and history. Claude Code understands and executes.
4. **Spend Claude carefully.** No Claude call per message. Batch work, use the cheapest model that works, and gate on real quota.
5. **Traceable intelligence.** Every AI recommendation links to its evidence.
6. **Replaceable parts.** Slack, Jira and AI providers sit behind ports and can be swapped.
7. **Reliability over polish.** Correct background operation and data integrity come before UI refinement.

## Out of scope (initially)

- Multi-user or team use.
- Group-level People Memory.
- Remote or cloud hosting.
- Automatic sending of any message without approval (see OQ-1 in `open-questions.md`).
- Deployment automation beyond explicit, approved steps.
