# Slack connector fixtures

Synthetic fixtures reproducing the exact output format of the claude.ai Slack connector
(`slack_search_public_and_private` with `response_format: "detailed"`, and `slack_read_thread`),
observed against the real connector through Claude Code CLI 2.1.318 on 2026-11-05.

Every name, email, ID, link, timestamp and message text here is invented. No real Slack data.

Format facts these fixtures encode:
- Search envelope: `{"results": "<markdown>", "pagination_info": "For the next page of results use cursor `<c>`\n"}`.
- Body: `# Search Results for: <query>`, blank line, `## Messages (N results)`, then blocks `### Result i of N`.
- Block lines, in order: `Channel: <label> (ID: <id>)` (label is `DM`, `Group DM` or `#name`),
  optional `Participants: Name (ID: U…), …` (DMs and group DMs only), `From: Name <email> (ID: U…) ` (trailing space),
  `Time: YYYY-MM-DD HH:MM:SS IST`, `Message_ts: <ts>`, optional `Reply count: N`,
  `Permalink: [link](https://<ws>.slack.com/archives/<channel>/p<digits>[?thread_ts=<ts>&cid=<channel>])`,
  `Text: ` then the message text (may span lines, may contain `---` or label-like text),
  optional `Full notes: …` (huddle notes), then a blank line, `---`, blank line.
- Thread replies carry `thread_ts` only in the permalink query.
- Last page: `pagination_info` with no cursor (assumed empty string; not yet observed).
- Thread envelope: `{"messages": "<text>", "pagination_info": "There are no more messages in this thread."}`;
  sections `=== THREAD PARENT MESSAGE ===` and `=== THREAD REPLIES (N total) ===`, replies introduced by
  `--- Reply i of N ---`; each message: `From: Name <email> (U…)`, `Time: …`, `Message TS: <ts>`, text lines,
  optional `Files: name (ID: F…, mime, size)`.
