import type { AIExecutionRequest } from "@synapse/contracts";
import { BUILTIN_NETWORK, BUILTIN_WRITE, classifyTool, connectorServerOf } from "./tool-catalog";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): ValidationResult => ({ ok: false, reason });

export function validateRequest(req: AIExecutionRequest, knownServers: string[]): ValidationResult {
  const allowed = req.allowedTools;
  const hasUntrusted = req.promptParts.some((p) => p.provenance === "untrusted");

  // Rule 0: profile capability matrix.
  if (req.workerProfile !== "engineering") {
    const bad = allowed.find((t) => BUILTIN_WRITE.includes(t) || BUILTIN_NETWORK.includes(t));
    if (bad) return fail(`profile ${req.workerProfile} may not use ${bad}`);
  }

  // Rule 1
  if (hasUntrusted) {
    const bad = allowed.find((t) => {
      const c = classifyTool(t);
      return c === "write" || c === "builtin_write" || BUILTIN_NETWORK.includes(t);
    });
    if (bad) return fail(`untrusted content with write-capable tool ${bad}`);
  }

  // Rule 2
  if (hasUntrusted && req.workerProfile === "engineering") {
    return fail("engineering run with untrusted content");
  }

  // Rule 3
  if (allowed.some((t) => t.startsWith("mcp__")) && !allowed.includes("ToolSearch")) {
    return fail("ToolSearch required for connector tools");
  }

  // Rule 4
  const used = new Set<string>();
  for (const t of allowed) {
    const s = connectorServerOf(t);
    if (s) used.add(s);
  }
  for (const s of knownServers) {
    if (!used.has(s) && !req.disallowedTools.includes(s)) return fail(`denylist missing ${s}`);
  }

  // Rule 5: a send run is exactly one allowed write connector tool.
  const writeConnectors = allowed.filter(
    (t) => t.startsWith("mcp__") && classifyTool(t) === "write",
  );
  const promptHasUntrusted = hasUntrusted || /<<<UNTRUSTED /.test(req.prompt);
  if (writeConnectors.length === 1 && promptHasUntrusted) {
    return fail("send run with untrusted content");
  }

  // Rule 6: boundaries are recovered from the assembled prompt itself.
  const boundaries = new Set<string>();
  for (const m of req.prompt.matchAll(/<<<UNTRUSTED (\S+) source=/g)) {
    if (m[1]) boundaries.add(m[1]);
  }
  for (const p of req.promptParts) {
    if (p.provenance !== "untrusted") continue;
    for (const b of boundaries) if (p.content.includes(b)) return fail("boundary collision");
  }

  return { ok: true };
}
