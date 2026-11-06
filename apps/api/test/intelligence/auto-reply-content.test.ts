import { expect, test } from "bun:test";
import { codeBlockCheck, contentCheck } from "../../src/intelligence/auto-reply/content-checks";
import { ACK_TEXT } from "../../src/modules/auto-reply/policy";

test.each([
  "here: xoxb-1234567890-abcdef",
  "key AKIA0123456789ABCDEF here",
  "DB_PASSWORD=hunter22",
  "password: hunter2",
  "api-key = abc123",
  "sk-abcdefghijklmnop1234",
  "ghp_abcdefghijklmnopqrstuvwx",
  "-----BEGIN RSA PRIVATE KEY-----",
  "blob aGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29y end",
  "https://example.com/x?sig=aGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29y",
])("secret: %s", (t) => expect(contentCheck(t)).toBe("content_secret"));

test.each([
  "http://localhost:3000/x",
  "https://api.internal/x",
  "http://10.1.2.3",
  "see 192.168.1.5 please",
  "http://172.16.0.1/a",
  "http://172.31.9.9/a",
  "https://box.local/a",
  "https://example.com:8443/a",
  "example.com:9000",
  "http://127.0.0.1/x",
])("internal url: %s", (t) => expect(contentCheck(t)).toBe("content_internal_url"));

test.each([
  "I'll have it ready by Friday",
  "I’ll check",
  "deadline is 5 Dec",
  "I have approved it",
  "we will ship",
  "I will do it",
  "I promise",
  "I guarantee it",
  "Please send by tomorrow",
  "ready by next week",
  "go ahead and merge",
  "on 3rd March",
  "I've decided to skip",
  "due Dec 5",
])("promise: %s", (t) => expect(contentCheck(t)).toBe("content_promise"));

test.each([
  "Docs are at https://example.com/docs/getting-started/overview/the-long-page-name-here-ok",
  "Port 80 default: http://example.com:80/x and https://example.com:443/y",
  "see <https://example.com/a|the doc>",
  "see &lt;https://example.com/a&gt;",
  "go to www.example.com",
  "HTTP://EXAMPLE.COM",
  "ftp://example.com/file",
  "mail <mailto:ada@example.com|Ada>",
  "write to mailto:ada@example.com",
  "call tel:+15555550100",
])("link: %s", (t) => expect(contentCheck(t)).toBe("content_link"));

test.each([
  "<!channel> any update?",
  "<!here> any update?",
  "<!everyone> please look",
  "<!here|here> please look",
  "&lt;!channel&gt; any update?",
  "<!subteam^S0123456|@eng> can someone look",
  "@here any update?",
  "@Channel please",
  "hey @everyone",
  "can <@U0123ABC> take it?",
  "can <@W0123ABC|grace> take it?",
  "can &lt;@U0123ABC&gt; take it?",
  "ask @grace about it",
])("mention: %s", (t) => expect(contentCheck(t)).toBe("content_mention"));

test.each([
  "Could you share the CSV you uploaded?",
  "Is the login issue still happening on stage?",
  "Any update on the scoring fix?",
  "See the market 5 times",
  "Is 172.32.0.1 reachable?",
  "Email ada@example.com about it",
  ACK_TEXT,
])("clean: %s", (t) => expect(contentCheck(t)).toBeNull());

test("172.16-31 boundaries", () => {
  // Not internal, but still a link.
  expect(contentCheck("http://172.15.0.1/")).toBe("content_link");
  expect(contentCheck("http://172.16.0.1/")).toBe("content_internal_url");
});

test("first match wins: secret, internal url, link, mention, promise", () => {
  expect(contentCheck("I'll use http://localhost:3000 with xoxb-abc <!here>")).toBe(
    "content_secret",
  );
  // An internal URL is a link too, but keeps its more specific reason.
  expect(contentCheck("I'll use http://localhost:3000 <!here>")).toBe("content_internal_url");
  expect(contentCheck("I'll check https://example.com/a with <!here>")).toBe("content_link");
  expect(contentCheck("I'll ask <@U0123ABC>")).toBe("content_mention");
  expect(contentCheck("I'll ask")).toBe("content_promise");
});

// Phase 10b C7: a code answer with a code block is held (separate from contentCheck).
test.each([
  "```ts\nx\n```",
  "Look:\n```\nretry(3)\n```",
  "  ```\nindented fence\n```",
  "Lines:\n    a\n    b\n    c\n    d",
  "Lines:\n\ta\n\tb\n\tc\n\td",
  "Mixed:\n    a\n\tb\n    c\n\td\nend",
  "Windows:\r\n    a\r\n    b\r\n    c\r\n    d",
])("codeBlockCheck holds %p", (text) => {
  expect(codeBlockCheck(text)).toBe("content_code_block");
});

test.each([
  "The worker retries three times.",
  "Lines:\n    a\n    b\n    c",
  "Broken:\n    a\n    b\n\n    c\n    d",
  "Three spaces:\n   a\n   b\n   c\n   d",
  "Use `retry()` in src/a.ts.",
])("codeBlockCheck passes %p", (text) => {
  expect(codeBlockCheck(text)).toBeNull();
});

test("codeBlockCheck does not change contentCheck", () => {
  expect(contentCheck("```ts\nx\n```")).toBeNull();
});
