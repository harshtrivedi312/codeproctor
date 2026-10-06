-- session_status_erased: ADR 0004 §9.5 item 1 (accepted, D-54), ADR 0008 delta.
-- ERASED is the terminal status of a session that candidate erasure has fenced. It is appended last
-- and has no exit transition (ADR 0002 amendment).
-- Postgres cannot use a new enum value in the transaction that adds it, so this migration holds
-- nothing else. The statement is what `prisma migrate diff` generates; only the comments are hand-written.

-- AlterEnum
ALTER TYPE "session_status" ADD VALUE 'ERASED';
