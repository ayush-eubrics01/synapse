import type { AIExecutionRequest } from "@synapse/contracts";
import { assemblePrompt } from "./prompt";
import {
  BUILTIN_NETWORK,
  BUILTIN_READ,
  BUILTIN_WRITE,
  classifyTool,
  connectorServerOf,
  normalizeTool,
} from "./tool-catalog";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): ValidationResult => ({ ok: false, reason });

/**
 * Rule order (first failing rule wins):
 *  A. boundary non-empty; prompt === assemblePrompt(instructions, promptParts, boundary) (R24)
 *  B. built-in tools: unknown (R23), network in any profile (R22), write built-ins for
 *     collector/intelligence (rule 0)
 *  C. engineering may not allow any connector tool (R20)
 *  D. untrusted content with a write-capable tool (rule 1)
 *  E. engineering with untrusted content (rule 2)
 *  F. a connector write tool must be the only tool besides ToolSearch (R21)
 *  G. ToolSearch required for connector tools (rule 3)
 *  H. denylist covers every unused known server (rule 4)
 *  I. send run with untrusted content (rule 5; subsumed by D, kept as defence in depth)
 *  J. untrusted content contains the boundary (rule 6)
 * Tool names are normalised (specifier stripped) before classification.
 */
export function validateRequest(
  req: AIExecutionRequest,
  knownServers: string[],
  assembly: { instructions: string; boundary: string },
): ValidationResult {
  const raw = req.allowedTools;
  const allowed = raw.map(normalizeTool);
  const hasUntrusted = req.promptParts.some((p) => p.provenance === "untrusted");

  // A
  if (assembly.boundary.trim() === "") return fail("empty boundary");
  if (req.prompt !== assemblePrompt(assembly.instructions, req.promptParts, assembly.boundary)) {
    return fail("prompt does not match declared parts");
  }

  // B
  for (const t of allowed) {
    if (t.startsWith("mcp__")) continue;
    const known =
      BUILTIN_READ.includes(t) || BUILTIN_WRITE.includes(t) || BUILTIN_NETWORK.includes(t);
    if (!known) return fail(`unknown built-in tool ${t}`);
    if (BUILTIN_NETWORK.includes(t)) return fail(`profile ${req.workerProfile} may not use ${t}`);
    if (req.workerProfile !== "engineering" && BUILTIN_WRITE.includes(t)) {
      return fail(`profile ${req.workerProfile} may not use ${t}`);
    }
  }

  // C
  if (req.workerProfile === "engineering") {
    const c = allowed.find((t) => t.startsWith("mcp__"));
    if (c) return fail(`profile engineering may not use connector tool ${c}`);
  }

  // D
  if (hasUntrusted) {
    const bad = allowed.find((t) => {
      const c = classifyTool(t);
      return c === "write" || c === "builtin_write";
    });
    if (bad) return fail(`untrusted content with write-capable tool ${bad}`);
  }

  // E
  if (hasUntrusted && req.workerProfile === "engineering") {
    return fail("engineering run with untrusted content");
  }

  // F
  const writeConnectors = allowed.filter(
    (t) => t.startsWith("mcp__") && classifyTool(t) === "write",
  );
  const w = writeConnectors[0];
  if (w !== undefined) {
    const onlyThat = allowed.every((t) => t === w || t === "ToolSearch");
    if (writeConnectors.length !== 1 || !onlyThat) {
      return fail(`send run may only allow ${w} and ToolSearch`);
    }
  }

  // G
  if (allowed.some((t) => t.startsWith("mcp__")) && !allowed.includes("ToolSearch")) {
    return fail("ToolSearch required for connector tools");
  }

  // H
  const used = new Set<string>();
  for (const t of allowed) {
    const s = connectorServerOf(t);
    if (s) used.add(s);
  }
  for (const s of knownServers) {
    if (!used.has(s) && !req.disallowedTools.includes(s)) return fail(`denylist missing ${s}`);
  }

  // I
  if (writeConnectors.length === 1 && hasUntrusted) return fail("send run with untrusted content");

  // J
  for (const p of req.promptParts) {
    if (p.provenance === "untrusted" && p.content.includes(assembly.boundary)) {
      return fail("boundary collision");
    }
  }

  return { ok: true };
}
