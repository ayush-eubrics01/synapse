/** Plain-language names for the registered job types; presentation only. */
const LABELS: Record<string, string> = {
  "system.heartbeat": "Heartbeat",
  "slack.collect_incremental": "Collect new Slack messages",
  "slack.backfill": "Slack backfill page",
  "slack.retention_cleanup": "Delete expired messages",
  "urgency.assess": "Urgency assessment",
  "urgency.suggest_response": "Suggest a response",
  "people.generate_initial_profile": "Draft a person profile",
  "people.recommend_update": "Profile update suggestions",
  "people.update_profile": "Update a person profile",
  "people.assess_unknown": "Assess an unknown contact",
  "people.expire_temporary": "Expire temporary contacts",
  "commitments.extract_sweep": "Queue commitment extraction",
  "commitments.extract": "Find commitments",
  "commitments.check_spec_clarity": "Check task clarity",
  "commitments.check_stalled": "Check stalled commitments",
  "commitments.reminders": "Commitment reminders",
  "commitments.draft_followup": "Draft a follow-up",
  "approval.execute": "Run an approved action",
  "outgoing.verify": "Verify a sent message",
};

/** The label for a job type; an unknown type is returned as it is. */
export function jobLabel(type: string): string {
  return LABELS[type] ?? type;
}
