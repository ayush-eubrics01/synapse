import { type AIExecutionRequest, isSafeAbsolutePath } from "@synapse/contracts";
import { assemblePrompt } from "./prompt";
import {
  BUILTIN_FS_READ,
  BUILTIN_NETWORK,
  BUILTIN_READ,
  BUILTIN_WRITE,
  classifyTool,
  connectorServerOf,
  normalizeTool,
} from "./tool-catalog";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const BUILTIN_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^(),\s]*\))?$/;
const CONNECTOR_RE = /^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$/;

const DENY_BUILTIN_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const DENY_CONNECTOR_RE = /^mcp__[A-Za-z0-9_]+(__[A-Za-z0-9_]+)?$/;

const fail = (reason: string): ValidationResult => ({ ok: false, reason });

/** Maximum prompt size in UTF-8 bytes (one argv entry; Linux caps a single argument at 128 KiB). */
export const MAX_PROMPT_BYTES = 100 * 1024;

/**
 * Rule order (first failing rule wins):
 *  0. every allowedTools entry is a single well-formed tool name (R26); the CLI splits
 *     entries on commas/spaces, so anything else could smuggle extra tools
 *  0b. allowedTools non-empty; every disallowedTools entry is a plain tool or server name (R27),
 *     because one stray `(` would make the CLI swallow the rest of the denylist
 *  A. prompt at most 100 KiB (UTF-8) and not starting with "-" (it is an argv entry, R33);
 *     boundary non-empty; prompt === assemblePrompt(instructions, promptParts, boundary) (R24)
 *  B. built-in tools: unknown (R23), network in any profile (R22), write built-ins and
 *     Read/Grep/Glob for collector/intelligence (rule 0; engineering fs reads are path-scoped by rule L)
 *  C. engineering may not allow any connector tool (R20)
 *  D. untrusted content with a write-capable tool (rule 1)
 *  E. engineering with untrusted content (rule 2)
 *  F. a connector write tool must be the only tool besides ToolSearch (R21)
 *  G. ToolSearch required for connector tools (rule 3)
 *  H. denylist covers every unused known server (rule 4)
 *  H2. denylist contains every network built-in, and every write and filesystem-read built-in
 *     unless engineering (R26, I4); an engineering run must deny each filesystem-read built-in it
 *     does not allow (final review)
 *  I. send run with untrusted content (rule 5; subsumed by D, kept as defence in depth)
 *  J. untrusted content contains the boundary (rule 6)
 *  K. policy_approved content outside a send run (rule F's single write connector; J1, ADR-033);
 *     alongside untrusted content it already fails rule D. A send run must carry a sendGuard
 *     whose toolName is its write tool (J2), so every send is blocked by the PreToolUse hook
 *     unless its arguments are the approved ones
 *  L. every engineering run's working directory must satisfy isSafeAbsolutePath (no dot or empty
 *     segments, two or more segments), and its Read/Grep/Glob must each be exactly
 *     `Tool(/<workingDirectory>/**)`: the CLI's double-slash absolute form `//abs/dir/**`. The
 *     single-slash form `/abs/dir/**` is cwd-relative on the CLI and grants nothing (final review),
 *     so it fails, as does a bare Read (C7). Last, so the other rules keep their order. Tools
 *     other than the fs reads are unaffected
 * Tool names are normalised (specifier stripped) before classification.
 */
export function validateRequest(
  req: AIExecutionRequest,
  knownServers: string[],
  assembly: { instructions: string; boundary: string },
): ValidationResult {
  const raw = req.allowedTools;
  if (raw.length === 0) return fail("no tools allowed");
  for (const t of req.disallowedTools) {
    if (!(t.startsWith("mcp__") ? DENY_CONNECTOR_RE.test(t) : DENY_BUILTIN_RE.test(t))) {
      return fail(`malformed denylist entry ${t}`);
    }
  }
  for (const t of raw) {
    const ok = t.startsWith("mcp__") ? CONNECTOR_RE.test(t) : BUILTIN_RE.test(t);
    if (!ok) return fail(`malformed tool name ${t}`);
  }
  const allowed = raw.map(normalizeTool);
  const hasUntrusted = req.promptParts.some((p) => p.provenance === "untrusted");

  // A
  if (Buffer.byteLength(req.prompt, "utf8") > MAX_PROMPT_BYTES) return fail("prompt too large");
  if (req.prompt.startsWith("-")) return fail("prompt must not start with -");
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
    if (
      req.workerProfile !== "engineering" &&
      (BUILTIN_WRITE.includes(t) || BUILTIN_FS_READ.includes(t))
    ) {
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

  // H2
  const required = [
    ...BUILTIN_NETWORK,
    ...(req.workerProfile === "engineering"
      ? BUILTIN_FS_READ.filter((t) => !allowed.includes(t))
      : [...BUILTIN_WRITE, ...BUILTIN_FS_READ]),
  ];
  for (const t of required) {
    if (!req.disallowedTools.includes(t)) return fail(`denylist missing ${t}`);
  }

  // I
  if (writeConnectors.length === 1 && hasUntrusted) return fail("send run with untrusted content");

  // J
  for (const p of req.promptParts) {
    if (p.provenance === "untrusted" && p.content.includes(assembly.boundary)) {
      return fail("boundary collision");
    }
  }

  // K
  if (
    writeConnectors.length !== 1 &&
    req.promptParts.some((p) => p.provenance === "policy_approved")
  ) {
    return fail("policy_approved content outside a send run");
  }
  if (w !== undefined && req.sendGuard?.toolName !== w) {
    return fail("send run without a matching send guard");
  }

  // L
  if (req.workerProfile === "engineering") {
    if (!isSafeAbsolutePath(req.workingDirectory)) {
      return fail("working directory must be an absolute path of safe characters");
    }
    const dir = req.workingDirectory.replace(/\/+$/, "");
    for (const t of raw.filter((t) => BUILTIN_FS_READ.includes(normalizeTool(t)))) {
      // `dir` starts with "/", so this is `Tool(//abs/dir/**)`: the CLI's absolute form.
      if (t !== `${normalizeTool(t)}(/${dir}/**)`) {
        return fail("fs read tools must be scoped to the working directory");
      }
    }
  }

  return { ok: true };
}
