-- appeal_status_closed_erased: ADR 0004 §9.5 item 2 (proposed), ADR 0008 delta.
-- CLOSED_ERASED closes an open appeal without recording an outcome, when erasure fences the session.
-- It is appended last. R-2 and R-9 treat it as closed.
-- Postgres cannot use a new enum value in the transaction that adds it, so this migration holds
-- nothing else, and it is separate from session_status_erased. The statement is what `prisma migrate diff`
-- generates; only the comments are hand-written.

-- AlterEnum
ALTER TYPE "appeal_status" ADD VALUE 'CLOSED_ERASED';
