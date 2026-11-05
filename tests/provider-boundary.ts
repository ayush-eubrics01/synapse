/**
 * P7: only core/orchestrator and the container may run or construct the AI provider
 * (CLAUDE.md hard rule 1). Returns the violation descriptions for one file.
 */
const ALLOWED = [/^apps\/api\/src\/core\/orchestrator\//, /^apps\/api\/src\/container\.ts$/];
const EXECUTE = /\.provider\.execute\(/;
const IMPORT = /import\s[^;]*\bClaudeCliProvider\b[^;]*from\s/;

export function providerBoundaryViolations(file: string, src: string): string[] {
  const path = file.replaceAll("\\\\", "/");
  if (ALLOWED.some((re) => re.test(path))) return [];
  const out: string[] = [];
  if (EXECUTE.test(src)) out.push(`${path}: calls .provider.execute(`);
  if (IMPORT.test(src)) out.push(`${path}: imports ClaudeCliProvider`);
  return out;
}
