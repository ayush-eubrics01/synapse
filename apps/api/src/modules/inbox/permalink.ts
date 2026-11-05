/** Only http(s) links are ever returned to the UI; anything else (javascript:, data:) becomes null. */
export function safePermalink(p: string | null): string | null {
  return p !== null && /^https?:\/\//.test(p) ? p : null;
}
