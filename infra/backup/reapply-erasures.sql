-- Re-applies erasures after a restore (ADR 0004 R-7 and 9.7, DB-07). restore.sh runs this in one
-- psql session after it created the temp table
--   _reapply_erasures (candidate_id uuid, erased_at timestamptz)
-- from the erasure list kept outside the backup. Idempotent: running it twice changes nothing.
--
-- It mirrors the database part of erasure (docs/database.md "Erasure on request", C-17). Objects
-- are not touched: those deleted at erasure time stay deleted. The consent record is KEPT (C-17).
-- docs/followups/db-ops.md FU-DBB-01: keep this in step with DB-06's erasure service.
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _reapply_sessions ON COMMIT DROP AS
SELECT s.id
FROM sessions s
JOIN invitations i ON i.id = s.invitation_id
JOIN _reapply_erasures e ON e.candidate_id = i.candidate_id;

DELETE FROM flag_decisions
WHERE event_id IN (SELECT id FROM proctor_events WHERE session_id IN (SELECT id FROM _reapply_sessions));
DELETE FROM proctor_events WHERE session_id IN (SELECT id FROM _reapply_sessions);
DELETE FROM proctor_event_batches WHERE session_id IN (SELECT id FROM _reapply_sessions);
DELETE FROM keystroke_batches WHERE session_id IN (SELECT id FROM _reapply_sessions);
DELETE FROM media_chunks WHERE session_id IN (SELECT id FROM _reapply_sessions);
DELETE FROM identity_checks WHERE session_id IN (SELECT id FROM _reapply_sessions);

UPDATE session_questions
SET final_code = NULL, answer = NULL, scoring_note = NULL
WHERE session_id IN (SELECT id FROM _reapply_sessions)
  AND (final_code IS NOT NULL OR answer IS NOT NULL OR scoring_note IS NOT NULL);

UPDATE submissions
SET source_code = '', results = '[]'
WHERE session_question_id IN (
        SELECT id FROM session_questions WHERE session_id IN (SELECT id FROM _reapply_sessions))
  AND (source_code <> '' OR results <> '[]'::jsonb);

UPDATE session_reviews SET notes = NULL
WHERE session_id IN (SELECT id FROM _reapply_sessions) AND notes IS NOT NULL;

UPDATE appeals SET resolution_note = NULL, reason = 'Erased'
WHERE session_review_id IN (
        SELECT id FROM session_reviews WHERE session_id IN (SELECT id FROM _reapply_sessions))
  AND (resolution_note IS NOT NULL OR reason <> 'Erased');

UPDATE sessions SET device_info = '{}'
WHERE id IN (SELECT id FROM _reapply_sessions) AND device_info <> '{}'::jsonb;

UPDATE candidates c
SET email = 'erased+' || c.id || '@invalid',
    full_name = 'Erased',
    external_ref = NULL,
    erased_at = COALESCE(c.erased_at, e.erased_at)
FROM _reapply_erasures e
WHERE c.id = e.candidate_id
  AND (c.email <> 'erased+' || c.id || '@invalid' OR c.full_name <> 'Erased'
       OR c.external_ref IS NOT NULL OR c.erased_at IS NULL);

COMMIT;
