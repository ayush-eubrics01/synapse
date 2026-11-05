# Slack MCP Integration — Tool Inventory

Findings come from the tool schemas and descriptions only. No Slack tool was called, so nothing was read, sent or changed.

- **Integration:** claude.ai Slack connector
- **Tool name prefix:** `mcp__claude_ai_Slack__` (left off the names below)
- **Total tools:** 26
- **Acting identity:** Slack user `U0XXXXXXXXX` (a user token, not a bot)

**Key:** ✅ yes · ❌ no · — doesn't apply (the tool doesn't read messages) · ❓ the schema doesn't say

---

## 1. Reading and search tools

| Tool | What it does | DMs | Group DMs | Public / private channel history | Threads & replies | Timestamp / date filters | Human vs bot |
|---|---|---|---|---|---|---|---|
| `slack_read_channel` | Reads a conversation's messages, newest first. Up to 100 per page, with a cursor for more | ✅ (pass a user ID or `D…` ID) | ✅ (`G…` ID) | ✅ / ✅ (only conversations you can access) | Partial: reports that a thread exists, not the replies | ✅ `oldest` / `latest` (Slack ts) | ❓ no bot filter; the output may show who posted |
| `slack_read_thread` | Reads a parent message and all its replies, up to 1000 | ✅ | ✅ | ✅ / ✅ | ✅ | ✅ `oldest` / `latest` | ❓ |
| `slack_search_public` | Keyword search of messages and files, **public channels only** | ❌ | ❌ | ✅ / ❌ | ✅ `is:thread` modifier | ✅ `before` / `after` (Unix ts), plus `before:` / `after:` / `on:` / `during:` in the query; sort by timestamp | ✅ `include_bots` (default **false**, so bots are left out) |
| `slack_search_public_and_private` | Keyword search of messages and files across **all** conversation types. Its description says to get user consent before using it | ✅ (`im`) | ✅ (`mpim`) | ✅ / ✅ | ✅ `is:thread` | ✅ same as above | ✅ `include_bots` (default false) |
| `slack_list_user_channels` | Lists conversations you belong to (public, private, `im`, `mpim`) | Lists them only | Lists them only | Lists them only | — | ❌ | — |
| `slack_search_channels` | Searches channels by name or description | ❌ | ❌ | Metadata only | — | ❌ | — |
| `slack_list_channel_members` | Lists the members of a channel or group DM (not 1:1 DMs) | ❌ | ✅ members | Members only | — | ❌ | ✅ `include_bots` (default false) |
| `slack_get_reactions` | Shows the emoji reactions on one message and who added them | ✅ | ✅ | ✅ | — | ❌ | ❓ |
| `slack_read_file` | Reads a file's contents by file ID (10 MB limit) | If the file is shared there | If the file is shared there | — | — | ❌ | — |
| `slack_read_canvas` | Reads a canvas as markdown, plus its comment threads | — | — | — | ✅ comment threads, via `slack_read_thread` | ❌ | — |
| `slack_read_list` | Reads a Slack List's columns and rows | — | — | — | — | ❌ | — |
| `slack_read_user_profile` | Reads a user's profile: contact details, status, timezone, role | — | — | — | — | — | ❓ probably via profile fields |
| `slack_search_users` | Searches users by name, email, department or title | — | — | — | — | — | ❓ |
| `slack_search_emojis` | Searches the workspace's custom emoji | — | — | — | — | — | — |

## 2. Writing tools

None of these read messages, so the capability columns don't apply.

| Tool | What it does |
|---|---|
| `slack_send_message` | Posts a message to a channel, DM or thread |
| `slack_send_message_draft` | Saves a draft to "Drafts & Sent" without sending it |
| `slack_schedule_message` | Schedules a message for 2 minutes to 120 days from now |
| `slack_add_reaction` | Adds an emoji reaction to a message |
| `slack_create_conversation` | Creates a channel, DM or group DM, and can invite users |
| `slack_create_canvas` | Creates a canvas |
| `slack_update_canvas` | Edits a canvas's sections |
| `slack_create_list` | Creates a Slack List |
| `slack_update_list` | Changes a List's name, description or columns |
| `slack_add_list_record` | Adds a row to a List |
| `slack_update_list_record` | Edits a row in a List |
| `slack_get_file_upload_url` | Upload step 1: returns a signed URL to send the file to |
| `slack_complete_file_upload` | Upload step 2: finalizes the file and can share it to a channel or DM |

## 3. Coverage at a glance

| Question | Answer | Tools |
|---|---|---|
| Read DMs? | ✅ | `slack_read_channel`, `slack_read_thread`, `slack_search_public_and_private` |
| Read group DMs? | ✅ | Same as above, plus `slack_list_channel_members` |
| Read public and private channel history? | ✅ (only where you have access) | `slack_read_channel`, `slack_read_thread`, both search tools (public-only for `slack_search_public`) |
| Get threads and replies? | ✅ | `slack_read_thread`; search with `is:thread` |
| Filter by timestamp or date? | ✅ | `oldest`/`latest` on the read tools; `before`/`after`/`on:`/`during:` and timestamp sorting on search |
| Tell human messages from bot messages? | ✅ for search and member lists through `include_bots`, which is off by default | For `slack_read_channel` and `slack_read_thread` the schema doesn't document any bot flag or filter |

## 4. How it authenticates

| Aspect | Finding |
|---|---|
| Connection type | A **claude.ai connector**, as the `mcp__claude_ai_` prefix shows. It's attached to your claude.ai account, not set up in a local MCP config file. |
| How you signed in | You authorized it once through Slack's OAuth consent screen on claude.ai. Claude Code reaches it through your claude.ai login. |
| Whose identity it uses | Your own Slack user (`U0XXXXXXXXX`), not a bot. It sees exactly what you can see, including your DMs and private channels, limited by the scopes you granted. |
| Where the token is kept | On Anthropic's connector service. As far as I know, Claude Code never holds the Slack token itself, so there's no local Slack credential to reuse. |
| Can you revoke it? | Yes: disconnect it in claude.ai's connector settings, or remove the app in your Slack account or workspace settings. |

## 5. Could a separate MCP client use the same endpoint without Claude Code?

| Scenario | Answer |
|---|---|
| Reuse this connection's credentials | ❌ No. The OAuth grant belongs to Anthropic's registered OAuth client and your claude.ai session, and no other client can reuse it. |
| Connect to Slack's MCP server with its own credentials | ✅ Yes, if Slack offers a public MCP server. I believe Slack offers one; it looks like the server behind this connector, but I haven't confirmed that. Another MCP client would have to go through its own OAuth flow, using its own registered Slack app or Slack's approved-client list, and your workspace's app-approval rules apply. That gives a separate grant, which you or an admin can revoke on its own. |
| How to know exactly | Your Slack admin can check the approved apps and OAuth grants in workspace settings, and Slack's developer docs list the MCP server's endpoint and which clients it allows. |
