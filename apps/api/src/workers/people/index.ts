import { registerAssessUnknown } from "./assess-unknown";
import { createPeopleContext } from "./context";
import { registerExpireTemporary } from "./expire-temporary";
import { registerInitialProfile } from "./initial-profile";
import type { PeopleJobDeps } from "./shared";
import { registerUpdateProfile } from "./update-profile";
import { registerUpdateSchedule } from "./update-schedule";

export { flagTarget, type PeopleJobDeps } from "./shared";

/** People Memory jobs: temporary-contact expiry, initial profile, updates, unknown assessment. */
export function registerPeopleJobs(deps: PeopleJobDeps): void {
  const c = createPeopleContext(deps);
  registerExpireTemporary(deps);
  registerInitialProfile(deps, c);
  registerUpdateSchedule(deps, c);
  registerUpdateProfile(deps, c);
  registerAssessUnknown(deps, c);
}
