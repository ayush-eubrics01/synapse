/**
 * Plain patterns with no runtime dependency, so client code can import them through
 * `@synapse/contracts/patterns` without bundling zod. Re-exported from the package root.
 */

/** A Jira project key (`DEMO`, `OPS_2`): the one rule for the API schemas and the web forms. */
export const JIRA_PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]+$/;
