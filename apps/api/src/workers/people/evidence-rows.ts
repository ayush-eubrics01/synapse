import type { ProfileContent, ProfileSection } from "@synapse/contracts";
import { type EvidenceRow, removalEvidenceKey } from "../../modules/people/recommendations";

/**
 * R7 M-3: a removal's citations, stored on the recommendation under `remove:<section>.<key>` so the
 * review shows why; never copied to a version. Confidence is that of the observation removed.
 */
export function removalEvidenceRows(
  current: ProfileContent,
  remove: { section: ProfileSection; key: string; evidence: string[] }[],
  byId: Map<string, { sentAt: string; sourceRef: string }>,
): EvidenceRow[] {
  return remove.flatMap((r) => {
    const confidence = current[r.section].find((o) => o.key === r.key)?.confidence ?? "low";
    return r.evidence.flatMap((id) => {
      const m = byId.get(id);
      if (!m) return []; // unreachable after validateUpdate
      return [
        {
          observationKey: removalEvidenceKey(r.section, r.key),
          messageId: id,
          sourceExternalRef: m.sourceRef,
          confidence,
          observedAt: m.sentAt,
        },
      ];
    });
  });
}

export function evidenceRows(
  content: ProfileContent,
  byId: Map<string, { sentAt: string; sourceRef: string }>,
) {
  const rows = [];
  for (const section of ["professionalContext", "communication", "responseGuidelines"] as const) {
    for (const o of content[section]) {
      for (const id of o.evidence) {
        const m = byId.get(id);
        if (!m) continue; // unreachable after validateEvidence
        rows.push({
          observationKey: `${section}.${o.key}`,
          messageId: id,
          sourceExternalRef: m.sourceRef,
          confidence: o.confidence,
          observedAt: m.sentAt,
        });
      }
    }
  }
  return rows;
}
