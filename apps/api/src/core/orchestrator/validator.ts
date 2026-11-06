import {
  type AIExecutionRequest,
  isSafeAbsolutePath,
  isSafeTestCommand,
  SANDBOX_MASKED_ROOTS,
} from "@synapse/contracts";
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
// A Bash grant is a command prefix, `Bash(<cmd>:*)`, and the command has spaces (`bun test`). Spaces
// are accepted inside that one form only; rule L then checks the command itself (E5).
const BASH_PREFIX_RE = /^Bash\([A-Za-z0-9 ._:/=@+-]+:\*\)$/;
const CONNECTOR_RE = /^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$/;

const DENY_BUILTIN_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const DENY_CONNECTOR_RE = /^mcp__[A-Za-z0-9_]+(__[A-Za-z0-9_]+)?$/;

const fail = (reason: string): ValidationResult => ({ ok: false, reason });

/** Rule M's reason when an engineering run grants Bash without a sandbox (ADR-040). */
export const SANDBOX_REQUIRED_REASON = "engineering Bash requires the sandbox";

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
 *     Read/Grep/Glob for collector/intelligence (rule 0; engineering and reader fs reads are
 *     path-scoped by rule L); a reader may use Read/Grep/Glob and no other built-in, so Bash in any
 *     form, every write built-in and ToolSearch fail too (C1a)
 *  C. engineering and reader may not allow any connector tool (R20, C1b)
 *  D. untrusted content with a write-capable tool (rule 1)
 *  E. engineering with untrusted content (rule 2). Not applied to reader (C1c): a reader sees the
 *     untrusted question, and rules B, C and D leave it no write, shell, network or connector tool
 *  F. a connector write tool must be the only tool besides ToolSearch (R21)
 *  G. ToolSearch required for connector tools (rule 3)
 *  H. denylist covers every unused known server (rule 4)
 *  H2. denylist contains every network built-in, and every write and filesystem-read built-in
 *     (R26, I4); an engineering or reader run must deny each of them it does not allow (final
 *     review, C1e), so a reader's denylist always holds Bash and every write built-in. A reader's
 *     denylist must also hold ToolSearch, so no deferred connector tool can be loaded
 *  I. send run with untrusted content (rule 5; subsumed by D, kept as defence in depth)
 *  J. untrusted content contains the boundary (rule 6)
 *  K. policy_approved content outside a send run (rule F's single write connector; J1, ADR-033);
 *     alongside untrusted content it already fails rule D. A send run must carry a sendGuard
 *     whose toolName is its write tool (J2), so every send is blocked by the PreToolUse hook
 *     unless its arguments are the approved ones
 *  L. every engineering and reader run's working directory must satisfy isSafeAbsolutePath (no
 *     dot or empty segments, two or more segments), and its Read/Grep/Glob must each be exactly
 *     `Tool(/<workingDirectory>/**)`: the CLI's double-slash absolute form `//abs/dir/**`. The
 *     single-slash form `/abs/dir/**` is cwd-relative on the CLI and grants nothing (final review),
 *     so it fails, as does a bare Read (C7). A reader may list each fs read tool at most once
 *     (C1d; engineering is unchanged). Write tools (engineering only: rule B already refused them
 *     for a reader): `Edit`/`Write`/`MultiEdit` must equal the same
 *     `Tool(/<wd>/**)`, and `Bash` only as exactly `Bash(<cmd>:*)` with `isSafeTestCommand(cmd)`
 *     (E5, E9); a bare Bash or any other specifier fails, and at most one Bash grant is allowed.
 *     Rule 0 admits a Bash specifier with spaces only in the `Bash(<safe chars>:*)` form. After K,
 *     so the other rules keep their order. Tools other than fs reads and writes are unaffected
 *  M. sandbox (ADR-040), after L: an engineering run that grants any Bash must carry `sandbox`
 *     (SANDBOX_REQUIRED_REASON), so its test command runs with no network, writes only inside the
 *     repository and the credentials and sockets masked. A non-engineering run must not carry one.
 *     `denyRead` must be non-empty; `tmpDir` and every `denyRead` entry must satisfy
 *     isSafeAbsolutePath; `tmpDir` must be neither equal to nor an ancestor of a `denyRead` entry
 *     or of SANDBOX_MASKED_ROOTS, nor equal to or under `/run` or `/var/run` (its `allowRead`
 *     would re-expose them). Last of all
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
    const ok = t.startsWith("mcp__")
      ? CONNECTOR_RE.test(t)
      : BUILTIN_RE.test(t) || BASH_PREFIX_RE.test(t);
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

  const profile = req.workerProfile;
  const pathScoped = profile === "engineering" || profile === "reader";

  // B
  for (const t of allowed) {
    if (t.startsWith("mcp__")) continue;
    const known =
      BUILTIN_READ.includes(t) || BUILTIN_WRITE.includes(t) || BUILTIN_NETWORK.includes(t);
    if (!known) return fail(`unknown built-in tool ${t}`);
    if (BUILTIN_NETWORK.includes(t)) return fail(`profile ${profile} may not use ${t}`);
    if (profile === "reader") {
      // Read/Grep/Glob only: no Bash, no write built-in, no ToolSearch (C1a).
      if (!BUILTIN_FS_READ.includes(t)) return fail(`profile reader may not use ${t}`);
    } else if (
      profile !== "engineering" &&
      (BUILTIN_WRITE.includes(t) || BUILTIN_FS_READ.includes(t))
    ) {
      return fail(`profile ${profile} may not use ${t}`);
    }
  }

  // C
  if (pathScoped) {
    const c = allowed.find((t) => t.startsWith("mcp__"));
    if (c) return fail(`profile ${profile} may not use connector tool ${c}`);
  }

  // D
  if (hasUntrusted) {
    const bad = allowed.find((t) => {
      const c = classifyTool(t);
      return c === "write" || c === "builtin_write";
    });
    if (bad) return fail(`untrusted content with write-capable tool ${bad}`);
  }

  // E (not reader: C1c)
  if (hasUntrusted && profile === "engineering") {
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
    ...(pathScoped
      ? [...BUILTIN_WRITE, ...BUILTIN_FS_READ].filter((t) => !allowed.includes(t))
      : [...BUILTIN_WRITE, ...BUILTIN_FS_READ]),
    ...(profile === "reader" ? ["ToolSearch"] : []),
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
  if (pathScoped) {
    if (!isSafeAbsolutePath(req.workingDirectory)) {
      return fail("working directory must be an absolute path of safe characters");
    }
    const dir = req.workingDirectory.replace(/\/+$/, "");
    const fsReads = raw.filter((t) => BUILTIN_FS_READ.includes(normalizeTool(t)));
    for (const t of fsReads) {
      // `dir` starts with "/", so this is `Tool(//abs/dir/**)`: the CLI's absolute form.
      if (t !== `${normalizeTool(t)}(/${dir}/**)`) {
        return fail("fs read tools must be scoped to the working directory");
      }
    }
    if (profile === "reader") {
      const seen = new Set<string>();
      for (const t of fsReads.map(normalizeTool)) {
        if (seen.has(t)) return fail(`duplicate fs read tool ${t}`);
        seen.add(t);
      }
    }
    const writeErr = "write tools must be scoped to the working directory";
    if (raw.filter((t) => normalizeTool(t) === "Bash").length > 1) {
      return fail("only one Bash grant is allowed");
    }
    for (const t of raw.filter((t) => BUILTIN_WRITE.includes(normalizeTool(t)))) {
      const name = normalizeTool(t);
      if (name === "Bash") {
        const m = /^Bash\((.*):\*\)$/.exec(t);
        if (!m || !isSafeTestCommand(m[1] ?? "")) return fail(writeErr);
      } else if (name === "Edit" || name === "Write" || name === "MultiEdit") {
        if (t !== `${name}(/${dir}/**)`) return fail(writeErr);
      } else {
        return fail(writeErr);
      }
    }
  }

  // M
  const sandbox = req.sandbox;
  if (sandbox === undefined) {
    if (profile === "engineering" && raw.some((t) => normalizeTool(t) === "Bash")) {
      return fail(SANDBOX_REQUIRED_REASON);
    }
  } else {
    if (profile !== "engineering") return fail("sandbox is for engineering runs only");
    if (sandbox.denyRead.length === 0) return fail("sandbox denyRead must not be empty");
    if (![sandbox.tmpDir, ...sandbox.denyRead].every(isSafeAbsolutePath)) {
      return fail("sandbox paths must be absolute paths of safe characters");
    }
    const tmp = sandbox.tmpDir.replace(/\/+$/, "");
    const masks = [...sandbox.denyRead, ...SANDBOX_MASKED_ROOTS].map((e) => e.replace(/\/+$/, ""));
    if (masks.some((e) => e === tmp || e.startsWith(`${tmp}/`))) {
      return fail("sandbox tmpDir must not contain a masked path");
    }
    // Under /run or /var/run, allowRead would re-expose sockets (SSH agent, rootless Docker).
    if (["/run", "/var/run"].some((r) => tmp === r || tmp.startsWith(`${r}/`))) {
      return fail("sandbox tmpDir must not be under /run or /var/run");
    }
  }

  return { ok: true };
}
