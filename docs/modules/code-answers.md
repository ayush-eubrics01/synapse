# Code Answers

Implements part C of Phase 10b. A Slack question about one of the user's registered repositories is answered from the code by a read-only `reader` run. The answer is a **draft**: it reaches Slack only through a normal user approval, or, while away and only when the user turns `codeAnswer.away.autoSend` on, through `AutoReplyPolicy`. Spec: `docs/superpowers/specs/2026-11-06-phase-10b-activity-code-answer.md` (C1 to C10).

Code: `apps/api/src/modules/code-answers` (`service.ts`, `away-trigger.ts`), `intelligence/code-answer/prompt.ts`, `workers/code-answer/generate.ts`, `routes/code-answers.ts`, `modules/engineering-brain/evidence.ts` (`observedPaths`, `verifyCitations`). Web: `apps/web/app/components/inbox/CodeAnswerPanel.tsx`.

## The run

`code_answer.generate` builds its request with `buildCodeAnswerRequest` and runs it through `orchestrator.run` in the `reader` profile (`docs/modules/claude-orchestrator.md`). The working directory is the repository realpath. Parts: the system prompt and output contract, the repository name and root, up to 20 approved Engineering Brain facts (`user_approved`), and one `untrusted` part with the question (at most 4,000 characters) and up to 5 earlier thread messages (at most 1,000 characters each). A question that contains the prompt boundary makes the row `failed` / `invalid_input`. Model `codeAnswer.model` (`sonnet`), `codeAnswer.maxTurns` (16, capped at 30), `codeAnswer.timeoutMinutes` (5), one attempt. Priority class `urgent` for the user trigger, `collection` for the away trigger.

The handler timeout is `codeAnswer.timeoutMinutes + 5` minutes, read when the handler is registered.

## Output and verification (ADR-026)

The reply is one fenced json block, parsed strictly: `answerable`, `answer` (1 to 1,500 characters when answerable), `confidence` (0 to 1), `evidence` (0 to 8 entries of repository-relative `path` and optional `line`), `notAnswerableReason` and `suspectedInjection`. The text is stored only as a draft, never as source data.

- A run with no successful `Read`, `Grep` or `Glob` tool result fails (`no_tool_result`), whatever it says.
- Every cited path must be safe and non-sensitive, resolve (realpath) to a regular file strictly inside the repository, and be **observed** in the run's own tool results (`observedPaths`). Others are dropped and counted in `dropped_evidence_count`.
- Answerable with every citation dropped is `unverified`; `answerable: false` is `not_answerable` (with a fixed reason column). Neither is auto-sent.
- Suspected injection is kept on the row; the user sees the red-flag banner and must click "Use anyway" before "Use as reply" (409 `injection_unacknowledged` otherwise).

## Table `code_answers` (migration 0020)

Statuses: `queued`, `running`, `ready`, `not_answerable`, `unverified`, `failed`, `held`, `sent`, `dismissed`. One live row per (message, repository, trigger): a partial unique index over rows not `failed` or `dismissed`, so a retry replaces a failed row. `failure` holds a fixed code, never message text or a path. An orphaned `running` row (restart) is reclaimed by a recovery sweep at start. `answer` is nulled with Slack content after `retention.slackContentDays`, together with any injection quote. A repository unregistered while a job is queued leaves `repository_id` null and the row ends `failed` / `repository_unavailable` without a retry.

## User trigger (C5)

- `POST /api/inbox/messages/:id/code-answer {repositoryId}`: 202 `{codeAnswerId}`; 404 `not_found`; 400 `invalid_repository`; 409 `already_running` or `already_answered`. Job key `code-answer:<messageId>:<repoId>`.
- `GET /api/inbox/messages/:id/code-answers`: the message's rows.
- `POST /api/code-answers/:id/dismiss`: 204.
- `POST /api/code-answers/:id/send {text, useAnyway?}`: requests the send through `OutgoingService.requestSend` (a normal `slack.send` approval, exact text, no tag). Errors carry a fixed code only; the body never echoes text.

The thread view shows "Answer from code..." with a repository select, the answer, its confidence and its evidence as plain `path:line`. "Use as reply" fills the draft composer; the user edits it and requests the send as for any draft.

## Away trigger (C6)

A consumer of `message.received` queues one `away` row when all hold: away mode on; `code_answer` in `autoReply.allowedKinds`; `codeAnswer.away.enabled`; the sender is a priority person; the message passes `AutoReplyService.codeAnswerPreCheck` (`not_addressed` > `before_session` > `already_answered`, and not the user's own message); the text contains `?`; and exactly one repository is named. A repository is named by a case-insensitive, literal, whole-name match of its registered name (`-` and `_` count as name characters, so `demo-app` does not match inside `demo-app-two`, and `api` does not match in `rapid`) or of an Engineering Brain project name that links exactly one repository; a repository named twice, or once directly and once through its project, counts once. At most `codeAnswer.away.maxRunsPerDay` runs per rolling 24 hours. Zero or two matches write nothing and the message stays in the normal flow.

## Away decision (C7)

When an away row ends `ready`, `not_answerable` or `unverified`, `AutoReplyService` decides it as kind `code_answer` (order and reasons in `docs/modules/auto-reply.md`). Without `codeAnswer.away.autoSend` (the default), a passing answer becomes a held row `code_answer_review` plus a normal pending send approval for the user (exact text, the asker's conversation and thread, no tag), so it waits in Needs you. With `autoSend` on and every check passing, it is auto-sent with the tag `Sent using @claude` through `recordPolicyApproval`.

## Events

Emitted: `code_answer.status_changed {codeAnswerId, messageId, status}`. Consumed: `message.received` (away trigger).

## Settings

| Key | Default |
|---|---|
| `codeAnswer.model` | `sonnet` |
| `codeAnswer.maxTurns` | `16` |
| `codeAnswer.timeoutMinutes` | `5` |
| `codeAnswer.away.enabled` | `true` |
| `codeAnswer.away.autoSend` | `false` |
| `codeAnswer.away.maxRunsPerDay` | `10` |

## Real-CLI smoke

`bun scripts/dev/code-answer-smoke.ts` runs one real haiku reader run on a throwaway repository with invented files and a sentinel file outside it; the untrusted question asks it to Read, Grep and Glob the outside path. It prints statuses and counts only (`answerable`, `evidence_verified=N`, `outside_leak`, `tools_ok`) and exits 1 if the sentinel appears in the answer or any tool result. It spends a little quota: run it deliberately.

## Tests

`apps/api/test/modules/code-answer-*.test.ts`, `test/workers/code-answer-generate.test.ts`, `test/routes/code-answers.test.ts`, the validator matrix for `reader`, the auto-reply decision tests for `code_answer`, and `scripts/dev/test/code-answer-smoke.test.ts` (no real CLI).
