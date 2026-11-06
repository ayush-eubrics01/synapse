-- R15: followups.conversation_id is the internal slack_conversations.id. Urgent-reply follow-ups
-- written before this stored the external id; rewrite those rows (a data fix only, no schema change).
UPDATE `followups`
SET `conversation_id` = (
  SELECT `slack_conversations`.`id` FROM `slack_conversations`
  WHERE `slack_conversations`.`external_id` = `followups`.`conversation_id`
)
WHERE `origin` = 'urgent_reply'
  AND EXISTS (
    SELECT 1 FROM `slack_conversations`
    WHERE `slack_conversations`.`external_id` = `followups`.`conversation_id`
  );
