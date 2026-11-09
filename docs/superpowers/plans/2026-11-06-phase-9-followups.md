# Phase 9: Follow-ups

Phase 9 delivered the Engineering Brain (`docs/modules/engineering-brain.md`, spec `docs/superpowers/specs/2026-11-06-phase-9-engineering-brain.md`). This file records what was deliberately deferred and the real-CLI smoke results.

## Deferred

- **`code_answer` for away mode (Phase 10).** Answering a Slack question from the code mixes untrusted Slack text with code read access. It needs its own security design (no write or send tool in the same run, provenance of every part, an output that goes through `AutoReplyPolicy`) before it is built.
- **AI milestone extraction.** Propose milestones and go-live dates from Slack or Jira text ("we go live on the 20th", fix versions, due dates), as recommendations the user accepts. Conflicting dates for one milestone become a conflict recommendation, never a silent overwrite. Needs an intelligence prompt and schema, and the untrusted-content rules.
- **Slack-to-project links.** Associate conversations and messages with projects (rules first, AI only when ambiguous), visible and reversible.
- **CLAUDE.md and memory hints.** Read the user's CLAUDE.md files and Claude Code memory as hints for inspection, never as facts. The method is still an open question.
- **Repository auto-discovery.** An approved scan of a folder such as `~/projects` that proposes repositories. Explicit registration stays the default.
- ~~**A repository remove button in the UI.**~~ **Done in follow-ups batch 3.** The Projects section has a remove button. Original note: `DELETE /api/repos/:id` exists; the Projects section has no button for it.
- ~~**Gate the project Jira summary on `jira.enabled`.**~~ **Done in follow-ups batch 3.** The summary respects `jira.enabled`. Original note: The summary reads in-scope `jira_issues` whatever the setting says.
- ~~**Surface permission denials on inspection runs.**~~ **Done in follow-ups batch 3.** Denials raise a visible warning. Original note: Denials are audited (tool names, in `brain.inspected`) but not shown. A denial means the run tried to step outside its scope, so it should raise a visible warning.
- **Fact text is untrusted.** Inspection facts are repository-derived content written by other people, reviewed but not authored by the user. Any future use of fact text in a prompt (a code answer, a summary, an engineering task) must tag it `untrusted`, with everything that implies under ADR-032. ADR-034 records why the inspection schema has no `suspectedInjection` field; adding it is open.
- **Relinked-project hint (M7).** When registration relinks an orphan project of the same name, the confirm form could say so before the user confirms.
- **`--tools "Read,Grep,Glob"` for engineering runs (M10).** Restricting the built-in tool set itself for engineering runs (no connectors are allowed there anyway) would be a second layer under the allow and deny lists. CLAUDE.md forbids `--tools` because it hides connector tools, so this needs an ADR; Phase 10.
- **Extra project GETs.** The web refresh fetches each project's detail separately (N requests per refresh). A list endpoint with details, or fetching only open cards, would cut that.
- **Smaller items.** Project decisions, dependencies, blockers and knowledge-recommendation tables from the original module design.

## Final review: the path scope form

The final review found that the single-slash scope `Read(/abs/repo/**)`, used by rule L, the inspection and `scope-smoke`, is not an absolute path on the CLI. The controller verified it on the real CLI on 2026-11-06, at provider level with the cwd in a **third** temp dir:

- `Read(/abs/inside/**)` (single slash): the inside read was **denied**, and so was the outside one. The single-slash form is cwd-relative and grants nothing.
- `Read(//abs/inside/**)` (double slash): the inside read **succeeded**, the outside read was **denied**, and nothing leaked.

The earlier `scope-smoke` result below passed only because its cwd was the scoped directory (the CLI allows reads under the cwd by default). Rule L, the inspection request and `scope-smoke` now use the double-slash form; `scope-smoke` keeps the cwd in a third directory and runs the single-slash form as a negative control. Its new output is `double: inside=… outside=…`, `single(control): inside=…`, `scope-smoke: blocked|LEAKED|inconclusive`. The controller reruns `scope-smoke` and `inspect-smoke` on the real CLI after this fix wave.

Also fixed in the final review: validator rule H2 now requires an engineering run to deny each write and filesystem-read built-in it does not allow (the earlier follow-up), and `docs/architecture/database-design.md` describes the tables migration 0016 built.

## Real-CLI smoke

Run by the controller on 2026-11-06 against the real CLI. Temp dirs only; counts recorded, nothing kept.

- **`scope-smoke` (superseded, see above).** `inside: ok`, `outside: blocked`, `permissionDenials: 1`, `scope-smoke: blocked`. This run used the single-slash form with the cwd equal to the scoped directory, so the inside read was allowed by the cwd default, not by the rule.
- **`inspect-smoke`, first run.** It failed with `FOREIGN KEY constraint failed`. The script passed a made-up `jobId`, and `claude_runs.job_id` references `jobs`. The smoke now drops `jobId`. This was a script bug only; the worker always runs with a real job id.
- **`inspect-smoke`, after the fix.** Model haiku, a throwaway 3-file repo: `turns: 8`, `permissionDenials: 0`, `proposed: 9`, `inserted: 8`, `dropped: sensitive_path=1`. The run stayed inside the repo, evidence verification held, and the sensitive-path filter fired.

### Rerun after the final-review fixes (controller, 2026-11-06)

- **`scope-smoke`** (provider level, cwd in a third directory): `double: inside=ok outside=blocked`, `single(control): inside=denied`, `scope-smoke: blocked`. The `//` rule itself grants the read; the cwd default doesn't.
- **`inspect-smoke`** (with `--permission-mode default`, auto memory off, and CLAUDE.md loading off): `turns: 8`, `permissionDenials: 0`, `proposed: 9`, `inserted: 8`, `dropped: sensitive_path=1`. `not_read` dropped nothing it shouldn't.
- Evidence 'observed' check accepts a path that appears in Grep/Glob output, not only files actually Read. It is weaker than 'read', but the file must still exist inside the repo and not be sensitive, and facts stay needs_review. Consider requiring a Read for evidence later.
