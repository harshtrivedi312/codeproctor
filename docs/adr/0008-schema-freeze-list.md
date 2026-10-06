# ADR 0008: Schema freeze list

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-01 (D-16; ARC-01 Phase B). Gate for DB-02 and DB-03. Section 8 "Roles" amended 2026-10-02 (D-35, ADR 0006 section 7). |
| Author | architect |
| Base | The reference DDL in /docs/database.md at commit `7f5c6b9` (24 tables, 13 enums). |
| Target | The reference DDL in /docs/database.md as updated on 2026-10-01 (31 tables, 20 enums). The target DDL is authoritative; this list is the checklist of every difference. |
| Sources | ADRs 0002 to 0007 (accepted, D-16) and decisions D-17 to D-23 (status.md section 9) |

**How to use it.** DB-02 writes `prisma/schema.prisma` from the target DDL in database.md. DB-02 and DB-03 tick every line below, and nothing else changes. If database.md and this list ever disagree, stop and ask the architect.

## 1. Counts

| Item | Base (7f5c6b9) | Target | Change |
| --- | --- | --- | --- |
| Tables | 24 | 31 | +7 |
| Enum types | 13 | 20 | +7 new; 3 changed (`session_status`, `proctor_profile`, `event_type`) |
| CHECK constraints | 5 | 12 | +7 |
| UNIQUE constraints (not PKs) | 12 | 20 | +8 |
| Composite primary keys | 0 | 3 | `session_sections`, `variant_test_cases`, `proctor_event_batches` |
| Non-unique indexes | 6 (1 partial) | 24 (2 partial) | +18 |
| ON DELETE CASCADE foreign keys | 15 | 22 | +7 |
| ON DELETE SET NULL foreign keys | 0 | 1 | `webhook_deliveries.session_id` |
| Composite foreign keys | 0 | 3 | section 6 |
| `GENERATED ALWAYS AS IDENTITY` columns | 4 | 5 | + `webhook_deliveries.id` |
| Triggers | 1 (`users.updated_at`) | 1 | none added |
| Circular foreign keys added by ALTER | 1 | 2 | + `organizations.current_consent_text_id` |

## 2. Enums

**New enum types (7):**

| Enum | Values | ADR |
| --- | --- | --- |
| `pause_reason` | 'FULLSCREEN_EXIT', 'SCREEN_SHARE_STOPPED', 'SIDE_CAMERA_LOST', 'PROCTOR' | 0002 §5 |
| `client_kind` | 'WEB' | 0004 §6 |
| `event_source` | 'CLIENT', 'SERVER' | 0004 §6 |
| `identity_check_status` | 'PENDING', 'PASSED', 'LOW_CONFIDENCE', 'MANUAL_REVIEW', 'REVIEWED' | 0004 §1 |
| `identity_review_reason` | 'BELOW_THRESHOLD', 'NO_FACE', 'MULTIPLE_FACES', 'LIVENESS_NOT_CONFIRMED', 'MATCH_ERROR' | 0004 §1 |
| `identity_manual_decision` | 'MATCH', 'NO_MATCH', 'INCONCLUSIVE' | 0004 §1 |
| `question_scoring` | 'AUTO', 'MANUAL_PENDING', 'MANUAL' | 0007 §5 (D-23) |

**Changed enum types (3):**

| Enum | Change | Target values | ADR |
| --- | --- | --- | --- |
| `session_status` | add 'DECLINED' (last) | 'INVITED', 'OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS', 'PAUSED', 'SUBMITTED', 'GRADED', 'UNDER_REVIEW', 'COMPLETED', 'EXPIRED', 'APPEALED', 'DECLINED' | 0002 §2 (D-17) |
| `proctor_profile` | remove 'LOCKDOWN' | 'STANDARD', 'STRICT' | 0007 §8 |
| `event_type` | remove 'PROHIBITED_PROCESS'; add 13 values at the end | 39 values: the 26 kept, in base order, then 'SIDE_CAMERA_DISCONNECTED', 'SIDE_CAMERA_RECONNECTED', 'DROP_ATTEMPT', 'CUT_ATTEMPT', 'SHORTCUT_BLOCKED', 'EXTENSION_INTERFERENCE', 'FULLSCREEN_RESTORED', 'SCREEN_SHARE_RESUMED', 'PROCTOR_RESUME', 'IDLE_THEN_COMPLETE', 'DETECTOR_UNAVAILABLE', 'IDENTITY_MANUAL_REVIEW', 'RESUME_OTP_FAILED' | 0005 §1, 0007 §8, D-21 |

Unchanged enums (10): `user_role`, `difficulty`, `question_type`, `submission_kind`, `media_stream` (keeps 'ROOM_SCAN'), `severity`, `risk_band`, `verdict`, `flag_decision`, `appeal_status`.

## 3. New tables (7)

The full DDL of each is in database.md.

| Table | Columns | Keys and constraints | ADR |
| --- | --- | --- | --- |
| `variant_test_cases` | variant_id uuid NOT NULL, test_case_id uuid NOT NULL, input text NOT NULL, expected_output text NOT NULL | PK (variant_id, test_case_id); FK variant_id → question_variants ON DELETE CASCADE; FK test_case_id → test_cases ON DELETE CASCADE | 0007 §1 |
| `ai_reference_solutions` | id uuid PK default gen_random_uuid(), question_version_id uuid NOT NULL, variant_id uuid, assistant text NOT NULL, model_label text NOT NULL, language text NOT NULL, solution_code text NOT NULL, prompt_text text, collected_at timestamptz NOT NULL, collected_by uuid NOT NULL, superseded_at timestamptz, created_at timestamptz NOT NULL default now() | FK question_version_id → question_versions ON DELETE CASCADE; FK variant_id → question_variants ON DELETE CASCADE; FK collected_by → users | 0005 §4, D-20 |
| `session_sections` | session_id uuid NOT NULL, section_id uuid NOT NULL, position int NOT NULL, time_limit_ms bigint, started_at timestamptz, deadline_at timestamptz, ended_at timestamptz | PK (session_id, section_id); UNIQUE (session_id, position); FK session_id → sessions ON DELETE CASCADE; FK section_id → test_sections | 0002 §1 |
| `consent_texts` | id uuid PK default gen_random_uuid(), org_id uuid NOT NULL, version text NOT NULL, body_md text NOT NULL, legal_approved_at timestamptz, legal_approved_by text, created_by uuid, created_at timestamptz NOT NULL default now() | UNIQUE (org_id, version); FK org_id → organizations; FK created_by → users | 0007 §6, D-17 |
| `proctor_event_batches` | session_id uuid NOT NULL, seq int NOT NULL, signature bytea NOT NULL, event_count smallint NOT NULL, received_at timestamptz NOT NULL default now() | PK (session_id, seq); FK session_id → sessions ON DELETE CASCADE | 0005 §3 |
| `webhook_endpoints` | id uuid PK default gen_random_uuid(), org_id uuid NOT NULL, url text NOT NULL, events text[] NOT NULL, secret_enc text NOT NULL, is_active boolean NOT NULL default true, created_by uuid, created_at timestamptz NOT NULL default now() | FK org_id → organizations; FK created_by → users | 0007 §7 |
| `webhook_deliveries` | id bigint GENERATED ALWAYS AS IDENTITY PK, endpoint_id uuid NOT NULL, event text NOT NULL, session_id uuid, attempt int NOT NULL, status_code int, error text, created_at timestamptz NOT NULL default now() | FK endpoint_id → webhook_endpoints ON DELETE CASCADE; FK session_id → sessions ON DELETE SET NULL | 0007 §7 |

Not created: `face_embeddings` (ADR 0004 §2: embeddings are never stored), `user_recovery_codes` and `user_invites` (ADR 0003 chose columns), `candidate_otps` (ADR 0003: Redis), `reports` (ADR 0007: columns on `sessions`).

## 4. Changed tables (column level)

Notation: **add** = new column; **change** = type, nullability or default changes; **rename**; **drop**.

| Table | Change | ADR |
| --- | --- | --- |
| organizations | **add** `current_consent_text_id uuid`. Its FK to `consent_texts(id)` is added by `ALTER TABLE ... ADD CONSTRAINT fk_current_consent_text` after `consent_texts` exists (circular, like `fk_current_version`). | 0007 §6 |
| users | **change** `password_hash text NOT NULL` → `password_hash text` (nullable) | 0003 §4 |
| users | **add** `recovery_code_hashes text[] NOT NULL DEFAULT '{}'` | 0003 §1 |
| users | **add** `set_password_token_hash text UNIQUE`, `set_password_expires_at timestamptz` | 0003 §4, D-22 |
| users | **add CHECK** `(password_hash IS NOT NULL OR set_password_token_hash IS NOT NULL)` | 0003 §4 |
| refresh_tokens | **add** `family_id uuid NOT NULL` | 0003 §3 |
| question_versions | **rename** `mcq_options` → `answer_spec` (still `jsonb`, nullable) | 0007 §5, D-23 |
| question_versions | **add** `validation_report jsonb` | 0007 §1 |
| tests | **change** `profile` keeps type `proctor_profile`, which loses 'LOCKDOWN'; default stays 'STANDARD' | 0007 §8 |
| tests | **add UNIQUE** `(id, org_id)` | 0006 §2 |
| candidates | **add** `erasure_requested_at timestamptz`, `erased_at timestamptz` | 0004 §5, D-19 |
| candidates | **add UNIQUE** `(id, org_id)` | 0006 §2 |
| invitations | **add** `org_id uuid NOT NULL REFERENCES organizations(id)` | 0006 §1 |
| invitations | **change** `test_id`: drop its single-column FK and add composite FK `(test_id, org_id) → tests (id, org_id)` | 0006 §2 |
| invitations | **change** `candidate_id`: drop its single-column FK and add composite FK `(candidate_id, org_id) → candidates (id, org_id)` | 0006 §2 |
| invitations | **add UNIQUE** `(id, org_id)` | 0006 §2 |
| sessions | **add** `org_id uuid NOT NULL REFERENCES organizations(id)` | 0006 §1 |
| sessions | **change** `invitation_id`: keep NOT NULL UNIQUE; drop its single-column FK and add composite FK `(invitation_id, org_id) → invitations (id, org_id)` | 0006 §2 |
| sessions | **change** `status` default 'OPENED' → 'INVITED' | 0002 §2 |
| sessions | **change** `hmac_key_enc text NOT NULL` → `hmac_key_enc text` (nullable) | 0002 §3 |
| sessions | **change** `client_kind text NOT NULL DEFAULT 'WEB'` → `client_kind client_kind NOT NULL DEFAULT 'WEB'` | 0004 §6 |
| sessions | **add** `auth_epoch int NOT NULL DEFAULT 0` | 0002 §4 |
| sessions | **add** `pause_reasons pause_reason[] NOT NULL DEFAULT '{}'`, `proctor_paused_at timestamptz` (`paused_ms` keeps its type; it now holds credited proctor-pause time only) | 0002 §5 |
| sessions | **add** `retention_anchor_at timestamptz` | 0004 §5 |
| sessions | **add** `report_key text`, `report_generated_at timestamptz` | 0007 §7 |
| session_questions | **add** `test_question_id uuid NOT NULL REFERENCES test_questions(id)` (no ON DELETE clause) | 0002 §1 |
| session_questions | **add** `answer jsonb` | 0007 §5 |
| session_questions | **add** `scoring question_scoring NOT NULL DEFAULT 'AUTO'`, `scored_by uuid REFERENCES users(id)`, `scored_at timestamptz`, `scoring_note text` | 0007 §5, D-23 |
| session_questions | **add CHECK** `((scoring = 'MANUAL') = (scored_by IS NOT NULL AND scored_at IS NOT NULL))` | 0007 §5 |
| consents | **drop** `consent_version text NOT NULL`; **add** `consent_text_id uuid NOT NULL REFERENCES consent_texts(id)` | 0007 §6 |
| consents | **drop** `accepted_at timestamptz NOT NULL DEFAULT now()`; **add** `signed_name text`, `signed_at timestamptz`, `declined_at timestamptz` | D-17, 0007 §6 |
| consents | **add** `pdf_key text`, `pdf_generated_at timestamptz`, `copy_emailed_at timestamptz` (`ip` and `user_agent` unchanged) | D-17 |
| consents | **add CHECK** `((signed_at IS NULL) <> (declined_at IS NULL))` and **add CHECK** `(signed_at IS NULL OR signed_name IS NOT NULL)` | D-17 |
| identity_checks | **change** `status text NOT NULL DEFAULT 'PENDING'` → `status identity_check_status NOT NULL DEFAULT 'PENDING'` | 0004 §1 |
| identity_checks | **drop** `room_scan_key` | 0004 §3 |
| identity_checks | **add** `attempt smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 2)` | 0004 §1 |
| identity_checks | **add** `model_id text`, `threshold numeric(5,4)`, `review_reason identity_review_reason`, `manual_decision identity_manual_decision`, `reviewed_by uuid REFERENCES users(id)`, `reviewed_at timestamptz`, `review_note text` | 0004 §1 |
| identity_checks | **add UNIQUE** `(session_id, attempt)`; **add CHECK** `((status = 'REVIEWED') = (manual_decision IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))` | 0004 §1 |
| media_chunks | **change** `object_key text NOT NULL` → `object_key text` (nullable) | 0004 §4 |
| media_chunks | **add** `segment int NOT NULL DEFAULT 0`, `deleted_at timestamptz` | 0004 §4 |
| proctor_events | **change** `source text NOT NULL DEFAULT 'CLIENT'` → `source event_source NOT NULL DEFAULT 'CLIENT'` | 0004 §6 |
| proctor_events | **add** `batch_seq int` | 0005 §3 |
| keystroke_batches | **add** `signature bytea NOT NULL` | 0005 §3 |
| appeals | **add** `new_verdict verdict`; **add UNIQUE** `(session_review_id)`; **add CHECK** `((status = 'OVERTURNED') = (new_verdict IS NOT NULL))` | 0002 §7 |

Changed tables (15): organizations, users, refresh_tokens, question_versions, tests, candidates, invitations, sessions, session_questions, consents, identity_checks, media_chunks, proctor_events, keystroke_batches, appeals.

Tables with no column change (9): audit_logs, questions, test_cases (gets an index), question_variants (index), test_sections (index), test_questions (index), submissions, session_reviews (index), flag_decisions. 15 + 9 = the 24 base tables.

## 5. CHECK constraints (12 in the target)

- **Kept (5):**
  - `organizations.retention_days BETWEEN 7 AND 730`
  - `tests.duration_minutes BETWEEN 5 AND 480`
  - `test_questions (question_version_id IS NOT NULL OR random_rule IS NOT NULL)`
  - `invitations (window_end > window_start)`
  - `sessions.risk_score BETWEEN 0 AND 100`
- **New (7):**
  - `users` password or token
  - `identity_checks.attempt BETWEEN 1 AND 2`
  - `identity_checks` reviewed-complete
  - `session_questions` manual-scoring-complete
  - `consents` signed xor declined
  - `consents` signed name present
  - `appeals` overturned-has-verdict

## 6. Foreign keys

- **New ON DELETE CASCADE (7):**
  - `session_sections.session_id`
  - `proctor_event_batches.session_id`
  - `ai_reference_solutions.question_version_id`
  - `ai_reference_solutions.variant_id`
  - `variant_test_cases.variant_id`
  - `variant_test_cases.test_case_id`
  - `webhook_deliveries.endpoint_id`

  The 15 base cascades are unchanged, for 22 in total.
- **New ON DELETE SET NULL (1):** `webhook_deliveries.session_id`.
- **Composite foreign keys (3).** They replace the single-column FKs on these columns:
  - `invitations (test_id, org_id) → tests (id, org_id)`
  - `invitations (candidate_id, org_id) → candidates (id, org_id)`
  - `sessions (invitation_id, org_id) → invitations (id, org_id)`
- **Every other new FK has no ON DELETE clause** (NO ACTION; set `onDelete: NoAction, onUpdate: NoAction` in Prisma):
  - `invitations.org_id`, `sessions.org_id`
  - `session_questions.test_question_id`, `session_questions.scored_by`
  - `session_sections.section_id`
  - `consents.consent_text_id`
  - `consent_texts.org_id`, `consent_texts.created_by`
  - `organizations.current_consent_text_id`
  - `identity_checks.reviewed_by`
  - `ai_reference_solutions.collected_by`
  - `webhook_endpoints.org_id`, `webhook_endpoints.created_by`

## 7. Indexes

**New non-unique indexes (18):**
- `users (org_id)`
- `refresh_tokens (user_id)`, `refresh_tokens (family_id)`
- `test_cases (question_version_id)`, `question_variants (question_version_id)`, `variant_test_cases (test_case_id)`, `ai_reference_solutions (question_version_id)`
- `tests (org_id)`, `test_sections (test_id)`, `test_questions (section_id)`
- `invitations (test_id)`, `invitations (candidate_id)`
- `sessions (org_id, status)`
- `sessions (retention_anchor_at) WHERE retention_anchor_at IS NOT NULL` (**partial**, DB-03 SQL)
- `session_questions (session_id)`, `session_reviews (reviewer_id)`, `appeals (assigned_to)`
- `webhook_deliveries (endpoint_id, created_at DESC)`

**Kept (6):** `audit_logs (org_id, created_at DESC)`; `sessions (status)`; `sessions (risk_band) WHERE status IN ('GRADED','UNDER_REVIEW')` (partial); `submissions (session_question_id, created_at)`; `proctor_events (session_id, occurred_at)`; `proctor_events (session_id, severity)`.

**New UNIQUE constraints (8):**
- `users.set_password_token_hash`
- `tests (id, org_id)`, `candidates (id, org_id)`, `invitations (id, org_id)`
- `identity_checks (session_id, attempt)`
- `appeals (session_review_id)`
- `consent_texts (org_id, version)`
- `session_sections (session_id, position)`

## 8. Migrations: what DB-03 adds in SQL

DB-03 adds these in SQL, in addition to the base Step 3 list:
- The 7 new CHECK constraints (section 5).
- The new partial index on `sessions (retention_anchor_at)`.
- `GENERATED ALWAYS AS IDENTITY` on `webhook_deliveries.id` (same decision as the other four identity columns).
- The circular FK `fk_current_consent_text`, if Prisma does not emit it.
- Enum array `pause_reason[]` (Prisma supports scalar lists of enums on PostgreSQL; check the generated SQL).
- `bytea` columns (`Bytes`).

**Roles (ADR 0006 §3).** The `audit_append_only` migration does **not** create `app_user`. `infra/sql/roles.sql` creates it once per environment, and the local compose init runs the same file (DB-03 adds both). The migration grants and revokes:
- `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user`
- `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user`
- `ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user`
- `REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_user`

It fails with a clear message if `app_user` is missing. `DATABASE_URL` connects as `app_user`; `MIGRATION_DATABASE_URL` connects as the owner role.

> **Amended 2026-10-02 (D-35; ADR 0006 section 7).** The roles paragraph above is replaced as follows.
> - There is no `infra/sql/roles.sql` and no compose init script.
> - The `audit_append_only` migration first creates `app_user` if it does not exist (LOGIN, no password), then grants. It also:
>   - grants USAGE on schema `public`;
>   - sets default privileges on sequences;
>   - omits `FOR ROLE`;
>   - revokes all access to `_prisma_migrations`.
> - The exact SQL is in ADR 0006 section 7.2.
> - The "clear message" now fires only where the migration role cannot create roles.
> - The password is set outside migrations (ADR 0006 section 7.4).
> - Nothing else in this list changes: the schema counts in section 1 are the same.

**No triggers are added.** Immutability of published question versions, used consent texts and AI reference rows is enforced in services.

## 9. Not schema (recorded so DB-02 does not look for it)

- **jsonb shapes in packages/shared (ARC-02):**
  - `organizations.settings` (OrgSettings: risk points, caps and bands; detector thresholds; `maxProctorPauseMinutes`; `aiReferences.refreshDays` and `minAssistants`; `erasure.holdWhileReviewOrAppealOpen`; `consentDeclineContact`)
  - `question_versions.answer_spec`
  - `session_questions.answer`
  - `invitations.accommodations` (adds `allowedAssistiveTools`)
  - `sessions.device_info.capabilities`
- **Redis only:** candidate OTP state, the pre-start 30-minute block, the in-test retry cooldown (ADR 0003 §2, D-21).
- **Config:** the face-match threshold and model manifest (ADR 0004 §2, ARC-04); `REQUIRE_LEGAL_APPROVED_CONSENT` (ADR 0007 §6).
- **Data not in this database:** the threshold-tuning volunteer set (D-18, PA-08).

## 10. Agents affected

- **db-engineer:** DB-02 builds `schema.prisma` from the target DDL and ticks sections 2 to 7. DB-03 does section 8. DB-04 follows the seed amendments in prompts/database.md Step 4. DB-05 builds the scope map (ADR 0006). DB-06 implements the retention and erasure rules in database.md Data rules. DB-08 checks all counts in section 1.
- **architect:** reviews DB-02 and DB-03 against this list. Any later change needs a new ADR and a forward-only migration (build-plan section 10).

## 11. Deltas after the freeze (2026-10-06)

The target of section 1 stays the freeze of 2026-10-01. These forward-only deltas were decided afterwards. Each has its own ADR or owner decision, and each is in `docs/database.md`. The migrations are Database A's (PR #91 and `app_user_no_temp` are on main; PR #100 is open). The D-55 column `consents.age_confirmed_at` is added here when its migration lands.

| Delta | Source | Change |
| --- | --- | --- |
| `session_status` | ADR 0004 section 9 (C-06, D-54) | + value `ERASED`, the terminal status of an erased session. `sessions` rows are never deleted. |
| `appeal_status` | ADR 0004 section 9 (D-54) | + value `CLOSED_ERASED`. |
| `audit_logs` | ADR 0004 section 9.2 (D-54) | + partial index `audit_logs_retention_marker_idx` for the "no marker yet" retention check. |
| Grants | ADR 0004 section 9.3, ADR 0006 section 7.2 (D-54) | `REVOKE DELETE, TRUNCATE ON sessions FROM app_user`. |
| Grants | FU-DBB-18 (migration `app_user_no_temp`, on main) | `REVOKE TEMPORARY ON DATABASE <current database> FROM PUBLIC`, `REVOKE TEMPORARY, CREATE ... FROM app_user`, and `GRANT TEMPORARY ... TO` the database owner, so `app_user` has no TEMPORARY or CREATE on the database (ADR 0006 section 8.8, DL-26). |
| `identity_check_status` | ADR 0015 (D-54) | + value `WAIVED`. |
| `identity_checks` | ADR 0015 (D-54) | + columns `video_check_done`, `video_check_by` (foreign key to `users`, `ON DELETE NO ACTION`), `video_check_at`; + CHECKs `identity_checks_waived_check` and `identity_checks_video_check_check`. |

Totals against section 1: tables 31 (unchanged); enum types 20 (unchanged; `appeal_status` and `identity_check_status` join `session_status`, `proctor_profile` and `event_type` as changed); CHECK constraints 12 to 14 (the two of ADR 0015); non-unique indexes 24 to 25 (partial indexes 2 to 3); foreign keys +1 (`identity_checks.video_check_by`, no ON DELETE clause, so NO ACTION; ON DELETE CASCADE 22, SET NULL 1 and composite 3 unchanged); no new triggers. The JSON key `accommodations.identityCheckWaived` and the `retention_anchor_at` rules are not schema changes.

