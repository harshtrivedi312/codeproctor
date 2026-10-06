-- retention_marker_index_and_no_session_delete: ADR 0004 §9 (accepted, D-54). Prisma cannot express a
-- partial index predicate or a REVOKE, so both statements are hand-written. Nothing else differs from
-- what Prisma would generate (it generates nothing for this migration).
--   - The partial index for the retention markers (§9.2; ADR 0008 delta).
--   - REVOKE DELETE and TRUNCATE on sessions from app_user (§9.3; ADR 0006 section 7.2 grants delta).

-- ADR 0004 §9 edit: partial index for the retention job's "eligible and no marker" check (§9.2). The
-- check is a NOT EXISTS against the append-only audit_logs, matching action, entity_type = 'session'
-- and entity_id = sessions.id::text (entity_id is text). Only the three RetentionService markers are
-- indexed, so the index stays small. audit_logs.action is text.
CREATE INDEX "audit_logs_retention_marker_idx" ON "audit_logs"("action", "entity_id") WHERE "action" IN ('RETENTION_FACE_DONE', 'RETENTION_MEDIA_DONE', 'RETENTION_RESULTS_DONE');

-- ADR 0004 §9 edit: no retention, results or erasure job deletes sessions rows (§9.3). consents.session_id
-- is ON DELETE CASCADE, so deleting a session would delete the consent proof that R-9 keeps for 3 years.
-- TRUNCATE was never granted (database.md); it is revoked anyway as belt and braces. Schema teardown
-- and seed cleanup delete sessions as the migration owner, not as app_user. The DB test asserts
-- has_table_privilege('app_user', 'sessions', 'DELETE' / 'TRUNCATE') = false, because a later migration
-- that repeats the audit_append_only pattern (GRANT ... ON ALL TABLES) would silently undo this REVOKE.
REVOKE DELETE, TRUNCATE ON "sessions" FROM app_user;

-- ADR 0004 §9 edit: REVOKE removes only the grants the running role made (or the owner made) and does
-- not fail otherwise, so a grant from another grantor or a role membership (for example
-- pg_write_all_data) survives it. Check the result instead of trusting it, as app_user_no_temp does.
DO $$
BEGIN
  IF has_table_privilege('app_user', 'sessions', 'DELETE')
     OR has_table_privilege('app_user', 'sessions', 'TRUNCATE') THEN
    RAISE EXCEPTION 'app_user still has DELETE or TRUNCATE on sessions (ADR 0004 section 9.3), from another grantor or a role membership such as pg_write_all_data. Run prisma migrate resolve --rolled-back 20261006174300_retention_marker_index_and_no_session_delete, remove that grant or membership, then deploy again.';
  END IF;
END
$$;
