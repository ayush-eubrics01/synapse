import type { ZodType } from "zod";

const FENCE_RE = /```json[^\S\n]*\n([\s\S]*?)```/g;

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Last fenced ```json block, else the whole text if it parses as JSON. */
export function extractJson(text: string): unknown | undefined {
  let last: string | undefined;
  for (const m of text.matchAll(FENCE_RE)) last = m[1];
  if (last !== undefined) return tryParse(last);
  return tryParse(text.trim());
}

export type ParsedStructured<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Reasons carry paths and issue codes only, never model text. */
export function parseStructured<T>(text: string, schema: ZodType<T>): ParsedStructured<T> {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, reason: "no JSON found in output" };
  const r = schema.safeParse(json);
  if (r.success) return { ok: true, value: r.data };
  const reason = r.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`)
    .join("; ");
  return { ok: false, reason: `output does not match schema (${reason})` };
}
