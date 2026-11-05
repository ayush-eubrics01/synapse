import { accessSync, constants, statSync } from "node:fs";
import { bunVersionCheck, lingerCheck } from "../../apps/api/src/core/health/checks";
import { servicePath } from "./install-services";

export interface EnvDeps {
  bunVersion: string;
  servicePath: string;
  isExecutable: (path: string) => boolean;
  run: (cmd: string[]) => Promise<string>;
  user: string;
}

export interface EnvResult {
  ok: boolean;
  lines: string[];
}

export async function runChecks(deps: EnvDeps): Promise<EnvResult> {
  const lines: string[] = [];
  let ok = true;
  const report = (pass: boolean, text: string) => {
    if (!pass) ok = false;
    lines.push(`${pass ? "✓" : "✗"} ${text}`);
  };

  const bun = await bunVersionCheck(deps.bunVersion)();
  report(bun.status === "ok", `bun: ${bun.detail ?? "ok"}`);

  const dir = deps.servicePath.split(":").find((d) => d && deps.isExecutable(`${d}/claude`));
  report(
    dir !== undefined,
    dir !== undefined
      ? `claude: ${dir}/claude`
      : `claude: not found on service PATH (${deps.servicePath})`,
  );

  const linger = await lingerCheck(deps.run, deps.user)();
  report(linger.status === "ok", `linger: ${linger.status === "ok" ? "enabled" : linger.detail}`);

  return { ok, lines };
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`);
  return out;
}

if (import.meta.main) {
  const home = process.env.HOME ?? "";
  const result = await runChecks({
    bunVersion: Bun.version,
    servicePath: servicePath(home),
    isExecutable: isExecutableFile,
    run,
    user: process.env.USER ?? "",
  });
  for (const l of result.lines) console.log(l);
  process.exit(result.ok ? 0 : 1);
}
