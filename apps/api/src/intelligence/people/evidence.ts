import { createHash } from "node:crypto";
import type {
  Confidence,
  Observation,
  ProfileContent,
  ProfileSection,
  ProfileUpdateOutput,
} from "@synapse/contracts";

const SECTIONS: ProfileSection[] = ["professionalContext", "communication", "responseGuidelines"];
const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * Keeps only what the provided history supports. Cited ids outside `providedIds` are removed (a
 * forged or hallucinated citation never counts); an observation left with no id, or below
 * `minConfidence`, is dropped; a repeated key within a section keeps its first occurrence.
 * `dropped` counts removed observations.
 */
export function validateEvidence(
  content: ProfileContent,
  providedIds: Set<string>,
  minConfidence: Confidence,
): { content: ProfileContent; dropped: number } {
  let dropped = 0;
  const out = {
    professionalContext: [],
    communication: [],
    responseGuidelines: [],
  } as ProfileContent;
  for (const section of SECTIONS) {
    const keys = new Set<string>();
    for (const o of content[section]) {
      const evidence = [...new Set(o.evidence.filter((id) => providedIds.has(id)))];
      if (evidence.length === 0 || RANK[o.confidence] < RANK[minConfidence] || keys.has(o.key)) {
        dropped++;
        continue;
      }
      keys.add(o.key);
      out[section].push({ ...o, evidence } satisfies Observation);
    }
  }
  return { content: out, dropped };
}

export const observationCount = (c: ProfileContent): number =>
  SECTIONS.reduce((n, s) => n + c[s].length, 0);

/** sha256 hex of the sorted `section:key:text` lines. Identifies an observation set, not its evidence. */
export function observationHash(c: ProfileContent): string {
  const lines = SECTIONS.flatMap((s) => c[s].map((o) => `${s}:${o.key}:${o.text}`)).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export type UpdateAdd = ProfileUpdateOutput["add"][number];
export type UpdateRemove = ProfileUpdateOutput["remove"][number];

/**
 * Validates a model-proposed diff against the current approved content. Every add keeps only
 * provided evidence ids (same rules as validateEvidence). A remove must cite at least one provided
 * id and name a key that exists in the current content, else it is dropped. `added` is the kept adds
 * as profile content (for evidence rows).
 */
export function validateUpdate(
  current: ProfileContent,
  output: Pick<ProfileUpdateOutput, "add" | "remove">,
  providedIds: Set<string>,
  minConfidence: Confidence,
): { add: UpdateAdd[]; remove: UpdateRemove[]; added: ProfileContent } {
  const asContent = {
    professionalContext: [],
    communication: [],
    responseGuidelines: [],
  } as ProfileContent;
  for (const { section, ...o } of output.add) asContent[section].push(o);
  const { content: added } = validateEvidence(asContent, providedIds, minConfidence);
  const add = SECTIONS.flatMap((section) => added[section].map((o) => ({ section, ...o })));
  const seen = new Set<string>();
  const remove: UpdateRemove[] = [];
  for (const r of output.remove) {
    const evidence = [...new Set(r.evidence.filter((id) => providedIds.has(id)))];
    const id = `${r.section}.${r.key}`;
    if (evidence.length === 0 || seen.has(id)) continue;
    if (!current[r.section].some((o) => o.key === r.key)) continue;
    seen.add(id);
    remove.push({ section: r.section, key: r.key, evidence });
  }
  return { add, remove, added };
}
