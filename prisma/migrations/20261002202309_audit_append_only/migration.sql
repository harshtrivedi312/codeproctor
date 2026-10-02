-- audit_append_only: app_user, grants and the append-only audit log (ADR 0006 section 7, D-35).
-- No password in any migration. The password is set outside migrations (ADR 0006 section 7.4).

-- 1. app_user is created once per cluster, and skipped when it already exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
    BEGIN
      CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION
      WHEN duplicate_object THEN
        NULL; -- created by a concurrent run, for example a shadow database
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION 'app_user does not exist and role % cannot create roles. Create app_user at provisioning (ADR 0006 section 7.5), then rerun prisma migrate deploy.', current_user;
    END;
  END IF;
END
$$;

-- 2. Grants on what exists now. USAGE is explicit because a reset recreates schema public
--    without PUBLIC's default USAGE (ADR 0009 section 5, P12).
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- 3. Defaults for tables and sequences that later migrations create. No FOR ROLE: they apply to
--    the role running this migration, which runs every migration (MIGRATION_DATABASE_URL).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- 4. Append-only audit log, and no access to Prisma's migration history.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_user;
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE public._prisma_migrations FROM app_user;
  END IF;
END
$$;
