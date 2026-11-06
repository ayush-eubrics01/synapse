/**
 * P7: only core/orchestrator and the container may run or construct the AI provider
 * (CLAUDE.md hard rule 1). Returns the violation descriptions for one file.
 */
const ALLOWED = [
  /^apps\/api\/src\/core\/orchestrator\//,
  /^apps\/api\/src\/container\.ts$/,
  // Defines ClaudeCliProvider itself and runs no other provider.
  /^apps\/api\/src\/integrations\/claude-code\/cli-provider\.ts$/,
  // Phase 9 final review (controller ruling): the deliberate, user-run scope proof must send the
  // single-slash negative control that validator rule L refuses, so it runs at provider level.
  // It is never imported by the API; it runs only two read-only runs with one Read tool each.
  /^scripts\/dev\/scope-smoke\.ts$/,
];
// Over-matching outside the allowed paths is acceptable (R55).
const EXECUTE = /\bprovider\s*\??\s*\.\s*execute\b/;
const NAMED_IMPORT = /\b(import|export)\b[^;]*\bClaudeCliProvider\b[^;]*\bfrom\b/;
const MODULE_PATH =
  /(\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'][^"']*cli-provider(\.[a-z]+)?["']/;

export function providerBoundaryViolations(file: string, src: string): string[] {
  const path = file.replaceAll("\\", "/");
  if (ALLOWED.some((re) => re.test(path))) return [];
  const out: string[] = [];
  if (EXECUTE.test(src)) out.push(`${path}: calls provider.execute`);
  if (NAMED_IMPORT.test(src) || MODULE_PATH.test(src)) {
    out.push(`${path}: imports ClaudeCliProvider`);
  }
  return out;
}
