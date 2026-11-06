import type { Tx } from "@synapse/database";
import { registerAssess } from "./assess";
import { createUrgencyContext } from "./context";
import type { UrgencyJobDeps } from "./shared";
import { registerSuggest } from "./suggest";

export { responseGuidelinesLookup } from "./guidelines";
export type { UrgencyJobDeps } from "./shared";

export function registerUrgencyJobs(deps: UrgencyJobDeps): {
  recoverySweep: (tx: Tx) => void;
} {
  const ctx = createUrgencyContext(deps);
  registerAssess(deps, ctx);
  registerSuggest(deps, ctx);
  return { recoverySweep: ctx.recoverySweep };
}
