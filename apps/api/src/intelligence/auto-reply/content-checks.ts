/**
 * Phase 6b A8: deterministic checks on the candidate text of an auto-reply, run before the tag is
 * added. Pure. Any match means hold. A false hold costs little, a false send costs trust, so where a
 * pattern is ambiguous the reading that holds more is used (noted per pattern).
 */

export type ContentIssue =
  | "content_secret"
  | "content_internal_url"
  | "content_link"
  | "content_mention"
  | "content_promise";

const SECRET_PATTERNS: RegExp[] = [
  /xox[abprs]-/,
  // No leading \b on purpose: "task-<16 chars>" also holds (conservative).
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i,
  // Env assignment, e.g. DB_PASSWORD=hunter22 (`\b` does not split DB_PASSWORD, so the rule above
  // does not catch it).
  /\b[A-Z][A-Z0-9_]{2,}=\S{6,}/,
];
const LONG_RUN = /[A-Za-z0-9+/_-]{40,}/;
// A plain URL (no query string or fragment) is not scanned for the 40+ run: ordinary paths and slugs
// would false-hold. A URL with a query or fragment is still scanned, since that is where tokens sit
// (the key=value patterns above scan the whole text either way).
const PLAIN_URL = /\b(?:https?|wss?|ftp):\/\/[^\s<>|?#]*(?=[\s<>|]|$)/gi;

const INTERNAL_HOST =
  "localhost|127(?:\\.\\d{1,3}){3}|10(?:\\.\\d{1,3}){3}|192\\.168(?:\\.\\d{1,3}){2}" +
  "|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}|\\[::1\\]|[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:local|internal)";
// A bare host or an IP anywhere in the text (also inside a URL): a version string like 10.1.2.3 holds.
const INTERNAL_BARE = new RegExp(`(?<![\\w.-])(?:${INTERNAL_HOST})(?![\\w-])`, "i");
const URL_WITH_PORT =
  /\b(https?|wss?|ftp):\/\/(?:[^\s/<>|@:]*@)?(?:\[[^\]]*\]|[^\s/<>|:?#]+):(\d+)/gi;
// host.tld:port without a scheme. Conservative: "foo.py:123" also holds.
const HOST_PORT = /(?<![\w.-])(?<!\/\/)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}:\d{2,5}\b/i;
const DEFAULT_PORT: Record<string, string> = {
  http: "80",
  ws: "80",
  https: "443",
  wss: "443",
  ftp: "21",
};

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
const PROMISE_PATTERNS: RegExp[] = [
  /\bI will\b/i,
  /\bI['’]ll\b/i,
  /\bwe will\b/i,
  /\bwe['’]ll\b/i,
  /\bI promise\b/i,
  /\bguarantee/i,
  new RegExp(`\\bby\\s+(?:today|tonight|tomorrow|eod|eow|${DAY}|next week)\\b`, "i"),
  /\bdeadline/i,
  /\bI(?:['’]ve| have)\s+(?:approved|decided)\b/i,
  /\bapproved\b/i,
  /\bgo ahead and\b/i,
  // "5 Dec", "5th December" (spec) and, conservatively, "Dec 5".
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`, "i"),
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "i"),
];

// Any link: a scheme (http, https, ftp, ws, mailto, ...) anywhere, a bare `www.` host, or a Slack
// `<http...>` / `<mailto:...>` link (raw or entity-escaped). An internal URL is checked first and
// keeps its own reason.
const LINK_PATTERNS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  /(?<![\w.-])www\.[a-z0-9-]/i,
  /(?:<|&lt;)(?:https?|mailto):/i,
  // Bare `mailto:` / `tel:` / `sms:` links (Slack autolinks them without `//`).
  /(?<![\w.-])(?:mailto|tel|sms):\S/i,
];

// Slack special mentions (raw or entity-escaped, with or without a `|label`), any user mention, and
// any bare `@name` (broader than `@here|@channel|@everyone` on purpose: it holds more). An email
// address (`ada@example.com`) is not a mention: the `@` follows a word character.
const MENTION_PATTERNS: RegExp[] = [
  /(?:<|&lt;)!(?:channel|here|everyone|subteam\^)/i,
  /(?:<|&lt;)@[UW][A-Z0-9]/i,
  /(?<![\w.@])@[A-Za-z0-9][\w.-]*/,
];

function hasSecret(text: string): boolean {
  if (SECRET_PATTERNS.some((p) => p.test(text))) return true;
  return LONG_RUN.test(text.replace(PLAIN_URL, " "));
}

function hasInternalUrl(text: string): boolean {
  if (INTERNAL_BARE.test(text) || HOST_PORT.test(text)) return true;
  for (const m of text.matchAll(URL_WITH_PORT)) {
    const scheme = (m[1] ?? "").toLowerCase();
    if (m[2] !== DEFAULT_PORT[scheme]) return true;
  }
  return false;
}

export function contentCheck(text: string): ContentIssue | null {
  if (hasSecret(text)) return "content_secret";
  if (hasInternalUrl(text)) return "content_internal_url";
  if (LINK_PATTERNS.some((p) => p.test(text))) return "content_link";
  if (MENTION_PATTERNS.some((p) => p.test(text))) return "content_mention";
  if (PROMISE_PATTERNS.some((p) => p.test(text))) return "content_promise";
  return null;
}
