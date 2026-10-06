-- app_user_no_temp: app_user cannot create temporary tables, nor create in the database
-- (ADR 0006 section 8.8, DL-26). PostgreSQL grants TEMPORARY on every new database to PUBLIC, so
-- app_user had it through PUBLIC. pg_temp is searched first for relations, so a temporary table
-- would shadow an unqualified table name in raw SQL (for example `INSERT INTO refresh_tokens`) for
-- the rest of a pooled connection, across requests and orgs. The database name differs per
-- environment (local, Testcontainers, staging, pilot), so the statements are built from
-- current_database().
DO $$
DECLARE
  owner_role name := (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database());
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  -- A direct grant (for example a provisioning GRANT ALL ON DATABASE) would survive the line above.
  EXECUTE format('REVOKE TEMPORARY, CREATE ON DATABASE %I FROM app_user', current_database());
  -- Belt and braces: the REVOKE above already leaves the owner's own entry (owner=CTc). The backup
  -- re-application and the restore drill create temporary tables as the owner (infra/backup).
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I', current_database(), owner_role);
  -- REVOKE only warns when the running role cannot revoke (it does not own the database), so
  -- check the result instead of trusting it.
  IF has_database_privilege('app_user', current_database(), 'TEMPORARY')
     OR has_database_privilege('app_user', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'app_user still has TEMPORARY or CREATE on database %: role % could not revoke it. The database owner (%) runs this migration, or runs the REVOKE statements above and then `prisma migrate resolve --rolled-back 20261006001500_app_user_no_temp` before deploying again (ADR 0006 section 8.8).', current_database(), current_user, owner_role;
  END IF;
END
$$;
