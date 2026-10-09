-- Re-applies erasures after a restore (ADR 0004 R-7 and 9.7, DB-07). restore.sh runs this in one
-- psql session after it created the temp table
--   _reapply_erasures (candidate_id uuid, erased_at timestamptz, completed boolean)
-- from the erasure list kept outside the backup. Idempotent, except that sessions.auth_epoch only ever increases.
--
-- It mirrors the database part of erasure (docs/database.md "Erasure on request", C-17). Objects
-- are not touched: those deleted at erasure time stay deleted. The consent record is KEPT (C-17).
-- Follows ADR 0004 9.7 and the erasure service (FU-DBB-01, FU-DBB-23): the FULL fence (every session
-- ERASED, open appeals CLOSED_ERASED, epoch bumped; the review/appeal hold is not applied on a re-application,
-- since the erasure was already requested), and the candidate row is anonymised at once only when the
-- erasure had finished (`completed`: the list's completion marker) or day 28 has passed; otherwise the
-- request is recorded (erasure_requested_at) so the daily erasure sweep resumes it (notice, day 25 alert,
-- day 28 anonymisation, completion). Known limit: the list does not record whether the candidate was
-- told, so a resumed erasure may send the notice mail again.
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

UPDATE appeals
SET resolution_note = NULL,
    reason = 'Erased',
    status = CASE WHEN status = 'OPEN' THEN 'CLOSED_ERASED'::appeal_status ELSE status END
WHERE session_review_id IN (
        SELECT id FROM session_reviews WHERE session_id IN (SELECT id FROM _reapply_sessions))
  AND (resolution_note IS NOT NULL OR reason <> 'Erased' OR status = 'OPEN');

-- Session credentials (ADR 0004 9.7 fence): a restore brings back the old epoch and HMAC key. Every
-- OTP success raises auth_epoch (ADR 0002, ADR 0013), so a token issued after the backup carries an
-- epoch higher than the restored one. A +1 bump could land on exactly that value; jumping by a
-- million puts the epoch past anything issued in the backup window. Applied on every run (harmless).
-- restore.sh raises every restored session's epoch as well, so erased sessions end up 2,000,000 higher;
-- the bump is kept here deliberately so this file is safe to run on its own.
UPDATE sessions
SET device_info = '{}',
    status = 'ERASED',
    auth_epoch = auth_epoch + 1000000,
    hmac_key_enc = NULL,
    report_key = NULL,
    retention_anchor_at = COALESCE(retention_anchor_at, (
      SELECT e.erased_at FROM _reapply_erasures e
      JOIN invitations i ON i.candidate_id = e.candidate_id
      WHERE i.id = sessions.invitation_id))
WHERE id IN (SELECT id FROM _reapply_sessions);

-- Record the request, so the erasure service finds the candidate on its next daily sweep.
UPDATE candidates c
SET erasure_requested_at = e.erased_at
FROM _reapply_erasures e
WHERE c.id = e.candidate_id AND c.erasure_requested_at IS NULL;

-- Anonymise now only if the erasure had finished or day 28 (ERASURE_ANONYMISE_DAY) has passed.
UPDATE candidates c
SET email = 'erased+' || c.id || '@invalid',
    full_name = 'Erased',
    external_ref = NULL,
    erased_at = COALESCE(c.erased_at, e.erased_at)
FROM _reapply_erasures e
WHERE c.id = e.candidate_id
  AND (e.completed OR now() >= e.erased_at + interval '28 days' OR c.erased_at IS NOT NULL)
  AND (c.email <> 'erased+' || c.id || '@invalid' OR c.full_name <> 'Erased'
       OR c.external_ref IS NOT NULL OR c.erased_at IS NULL);

COMMIT;
