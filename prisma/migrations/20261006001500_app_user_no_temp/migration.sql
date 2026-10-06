-- app_user_no_temp: app_user cannot create temporary tables (ADR 0006 section 8.8, DL-26).
-- PostgreSQL grants TEMPORARY on every new database to PUBLIC, so app_user had it through PUBLIC.
-- A temporary table sits outside the table grants and the org scope, so the role that serves
-- requests gets none. The database name differs per environment (local, Testcontainers, staging,
-- pilot), so the statements are built from current_database().
DO $$
DECLARE
  owner_role name := (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database());
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  -- The owner and the role running migrations keep it: the backup re-application and the restore
  -- drill create temporary tables as the owner (infra/backup).
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I', current_database(), owner_role);
  IF current_user <> owner_role THEN
    EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I', current_database(), current_user);
  END IF;
  -- REVOKE only warns when the running role cannot revoke (it does not own the database), so
  -- check the result instead of trusting it.
  IF has_database_privilege('app_user', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'app_user still has TEMPORARY on database %: role % could not revoke it from PUBLIC. Run this migration as the database owner (ADR 0006 section 7.5).', current_database(), current_user;
  END IF;
END
$$;
