-- scheduled_windows: the table that the start and stop schedules act on, with its two enum types (ADR 0017
-- section 4.7, owner decision C-53; ADR 0008 post-freeze delta). Forward-only and additive: a new table and
-- two new types, so nothing existing changes and there is no backfill.
-- The first block (CreateEnum to AddForeignKey) is what `prisma migrate diff` generated; nothing in it was
-- edited. The statements marked "C-53 edit:" at the end are SQL that Prisma cannot express, and are written
-- by hand: the two named CHECK constraints, the partial unique index, the updated_at trigger and the grant
-- check.
--
-- Foreign keys (all NO ACTION, as the other staff references and the composite organisation keys):
--   org_id                       to organizations(id).
--   (invitation_id, org_id)      to invitations(id, org_id): composite (ADR 0006 section 2 ii), so the database
--                                refuses a SLOT row whose invitation is in another organisation. It is MATCH
--                                SIMPLE, so a REVIEW row (invitation_id NULL) is not checked and keeps its org_id.
--                                Invitations are never deleted (erasure nulls their fields), so NO ACTION costs
--                                nothing; a SLOT row is deleted by retention and erasure, not nulled (the CHECK
--                                below refuses a SLOT row without an invitation).
--   requested_by                 to users(id): a RULE_I staff reference. Not org-composite: the service checks
--                                that the reviewer is in the same organisation (as created_by and reviewer_id).
-- `status` and `kind` have no default (the ADR lists none): the service names both on every insert.

-- CreateEnum
CREATE TYPE "scheduled_window_kind" AS ENUM ('SLOT', 'REVIEW');

-- CreateEnum
CREATE TYPE "scheduled_window_status" AS ENUM ('SCHEDULED', 'CANCELLED', 'DONE');

-- CreateTable
CREATE TABLE "scheduled_windows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "kind" "scheduled_window_kind" NOT NULL,
    "invitation_id" UUID,
    "requested_by" UUID,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "ceiling_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "scheduled_window_status" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_windows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_windows_org_id_starts_at_idx" ON "scheduled_windows"("org_id", "starts_at");

-- AddForeignKey
ALTER TABLE "scheduled_windows" ADD CONSTRAINT "scheduled_windows_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "scheduled_windows" ADD CONSTRAINT "scheduled_windows_invitation_id_org_id_fkey" FOREIGN KEY ("invitation_id", "org_id") REFERENCES "invitations"("id", "org_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "scheduled_windows" ADD CONSTRAINT "scheduled_windows_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- C-53 edit: the window is forward in time, and its ceiling is after its end (ADR 0017 section 4.7).
ALTER TABLE "scheduled_windows" ADD CONSTRAINT "scheduled_windows_times_check" CHECK ("ends_at" > "starts_at" AND "ceiling_at" > "ends_at");

-- C-53 edit: a SLOT row has an invitation and no reviewer, a REVIEW row has a reviewer and no invitation
-- (exactly one of the two references, by kind). It is also why retention deletes a SLOT row instead of
-- nulling invitation_id (ADR 0017 section 4.7: the null would fail this CHECK).
ALTER TABLE "scheduled_windows" ADD CONSTRAINT "scheduled_windows_kind_refs_check" CHECK (("kind" = 'SLOT') = ("invitation_id" IS NOT NULL) AND ("kind" = 'REVIEW') = ("requested_by" IS NOT NULL));

-- C-53 edit: a partial unique index, which Prisma cannot declare (it would make the unique key total). At
-- most one live window per invitation, so a reschedule race cannot leave two SCHEDULED rows and so two start
-- schedules for one invitation (ADR 0017 section 4.7). A CANCELLED or DONE row of the same invitation is not
-- in the index, and REVIEW rows (invitation_id NULL) never collide: NULLs are distinct in a unique index.
-- Prisma does not read a partial index back, so `prisma migrate diff` proposes no change for it.
CREATE UNIQUE INDEX "scheduled_windows_invitation_id_scheduled_key" ON "scheduled_windows"("invitation_id") WHERE "status" = 'SCHEDULED';

-- C-53 edit: updated_at is kept by the database, as on users (the schema has no @updatedAt; FU-DB-05, DB-03).
-- It reuses set_updated_at() from the init migration.
CREATE TRIGGER "scheduled_windows_set_updated_at"
BEFORE UPDATE ON "scheduled_windows"
FOR EACH ROW
EXECUTE FUNCTION "set_updated_at"();

-- C-53 edit: app_user gets SELECT, INSERT, UPDATE and DELETE on the new table through the default privileges
-- of the audit_append_only migration (ADR 0006 section 7.2). DELETE is needed here, unlike on sessions:
-- retention and erasure delete the SLOT rows of an invitation (ADR 0017 section 4.7, ADR 0004 9.5 and R-10).
-- Default privileges apply only to tables that the role that set them creates, so check the result instead
-- of trusting it: a deploy by another migration role would otherwise leave the app without access.
DO $$
BEGIN
  IF NOT (has_table_privilege('app_user', 'scheduled_windows', 'SELECT')
          AND has_table_privilege('app_user', 'scheduled_windows', 'INSERT')
          AND has_table_privilege('app_user', 'scheduled_windows', 'UPDATE')
          AND has_table_privilege('app_user', 'scheduled_windows', 'DELETE')) THEN
    RAISE EXCEPTION 'app_user lacks SELECT, INSERT, UPDATE or DELETE on scheduled_windows (ADR 0017 section 4.7): the default privileges of audit_append_only did not apply. This migration ran in one transaction, so nothing was created. Run prisma migrate resolve --rolled-back 20261006204813_scheduled_windows, run the migration as the role that ran audit_append_only, then deploy again.';
  END IF;
END
$$;
