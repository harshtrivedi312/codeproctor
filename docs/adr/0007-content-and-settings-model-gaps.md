# ADR 0007: Content, scoring, settings and integrations model

| Field     | Value                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status    | **Accepted** 2026-10-01 (D-16): A-01 option (b); every other recommendation as proposed; amended by D-17 (signed consent document) and D-23 (short answers and manual scoring). See section 10. Applied to database.md; deltas in ADR 0008. |
| Author    | architect                                                                                                                                                                                                                                   |
| Decides   | **A-01 variant model**, A-03 test side (decided with ADR 0002 §1), A-23, Q-13, Q-14, Q-16, A-11 items 2 to 5, the LOCKDOWN enum value (D-13, A-30)                                                                                          |
| Serves    | FR-202, FR-203, FR-205, FR-302, FR-305, FR-401, FR-406, FR-506, FR-804, FR-1001, FR-1003; BR-08, BR-15; TC-011, TC-012, TC-014, TC-030, TC-048, TC-081, TC-095, TC-096, TC-099                                                              |
| Hands off | Endpoint shapes (org settings, consent texts, practice run, webhooks admin): ARC-02.                                                                                                                                                        |

## 1. Variant model (A-01): accepted option (b)

**Context.**

- FR-203: variants change "array sizes, constants, entity names", and "the reference solution must pass all variants before publishing".
- TC-012 (P1): publishing is blocked and the failing variant is shown.
- BR-08 is a Must.
- `test_cases` belong to the question version, so every variant shares one set of expected outputs. When a variant changes a constant, those outputs are wrong for it.

| Option                                                                     | What a variant may change                                                      | DDL                            | TC-012 and BR-08                                                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Cosmetic variants                                                      | Statement text only (names, story, wording). Inputs and outputs are identical. | none                           | A test that fails, fails for every variant, so "failing variant" means nothing. FR-203 and TC-012 must be reworded. Shared code works on every variant, so BR-08 is weak. |
| **(b) Parameterized variants with per-variant test data (accepted, D-16)** | Constants, sizes and names, with inputs and expected outputs per variant       | new table `variant_test_cases` | TC-012 works as written. Code copied from another candidate fails when the constants differ.                                                                              |
| (c) As (b), stored as `question_variants.test_data jsonb`                  | As (b)                                                                         | one jsonb column               | Same behaviour, but no foreign key from the data to the test case, so schema checks live only in code                                                                     |

```sql
CREATE TABLE variant_test_cases (
  variant_id       uuid NOT NULL REFERENCES question_variants(id) ON DELETE CASCADE,
  test_case_id     uuid NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  input            text NOT NULL,
  expected_output  text NOT NULL,
  PRIMARY KEY (variant_id, test_case_id)
);
CREATE INDEX ON variant_test_cases (test_case_id);
-- question_versions add: validation_report jsonb   (A-11 item 4)
```

Rules for (b):

- **V-1** `test_cases` defines the slots: position, hidden flag, weight, and a default input and output. A `variant_test_cases` row overrides the input and output for one variant; without a row the default applies. Every variant therefore has the same number of tests with the same weights, so the versions stay equivalent and scoring stays fair.
- **V-2** `statement_md`, `starter_code` and `reference_solution` may contain Mustache placeholders, rendered per variant from `question_variants.params`. Mustache is logic-less, so the template engine runs no code. `rendered_statement` keeps the rendered statement.
- **V-3** Validation (BE-04 job, BE-05 executor) runs the rendered reference solution on every slot of every active variant with that variant's data. Any wrong answer, runtime error or limit breach blocks publishing. `validation_report` lists the variant, slot and result (TC-012), and FE-04 shows it.
- **V-4** Expected outputs are either authored, or prefilled by running the rendered reference solution and then accepted by the author. A prefilled output cannot catch a wrong reference solution, only crashes and limit breaches, so authors check at least the sample slots by hand.
- **V-5** The candidate sees the variant's rendered statement and its sample cases. Params, hidden data and reference solutions never leave the API (TC-011). Grading uses the data of `session_questions.variant_id`.
- **V-6** A `variant_test_cases` row's variant and test case must belong to the same question version. BE-04 checks this (service rule, ADR 0006).

**If the owner says no.** With (a), fsd.md FR-203 and TC-012 must be amended and the seed variants made cosmetic. With (c), the integrity checks move into BE-04 code. Seed impact of (b): 6 questions × 3 variants × 11 slots gives up to 198 override rows (DB-04).

## 2. Section time limits (A-03, test side)

Decided together with ADR 0002 §1. `test_sections.time_limit_min` stays. BE-06 checks rule S-6 (limits add up to no more than `duration_minutes`). FE-05 explains that sections run in order and do not reopen.

## 3. Score formula (A-23)

- (a) **Accepted.**
  - Coding question score = `points` × (passed hidden weight ÷ total hidden weight).
  - MCQ and short-answer question score = `points` if correct, else 0. A short answer that does not match is never scored 0 automatically; it waits for manual scoring (D-23, section 10).
  - Session total = Σ of question scores, and `tests.pass_score` uses the same scale.
  - TC-048 (weights 1, 1, 2, 2, 4; passing 1, 2 and 4) with 100 points gives 70.00.
- (b) FR-506 read literally: score = sum of passed hidden weights. Drop `test_questions.points` and `session_questions.points`. Totals then depend on how many tests each author wrote.

fsd.md FR-506 and TC-048 were updated in Phase B to state the formula and the expected 70.00.

## 4. Practice question (Q-13)

- (a) **Accepted, no schema change.** One built-in practice question in packages/shared, with statement, starter code and sample tests but no hidden tests. `POST /candidate/practice/run` (ARC-02) runs the samples through Judge0 while the session is CONSENTED or VERIFIED, is rate-limited like Run, and stores nothing.
- (b) A real question per org, served as a session question flagged `is_practice`. It needs `submissions` rows and exclusions in grading and reports.

## 5. MCQ and short answer (Q-14)

- (a) **Accepted.**
  - Rename `question_versions.mcq_options` to `answer_spec jsonb`. Its shape depends on `questions.type` and is a zod discriminated union in packages/shared:
    - MCQ: options, the correct option IDs, and single or multiple choice.
    - SHORT_ANSWER: the canonical answer plus a list of accepted variants, compared after normalization (D-23, section 10).
  - Add `session_questions.answer jsonb`: the selected option IDs or the text. It is autosaved and final at SUBMITTED.
  - `submissions` stays code-only. `grade-session` (BE-11) scores answers (TC-014). `answer_spec` never reaches candidates.
- (b) Make `submissions.language` and `source_code` nullable and add `submissions.answer jsonb`. It keeps a history of answers, but every code path on `submissions` must handle two shapes.

Short answers that do not match go to manual scoring (D-23, section 10).

## 6. Org settings and consent text (Q-16)

- `organizations.settings jsonb` stays. packages/shared defines `OrgSettings`:
  - risk points, caps and band edges (ADR 0005);
  - detector thresholds;
  - `maxProctorPauseMinutes` (ADR 0002);
  - `aiReferences.refreshDays` and `aiReferences.minAssistants` (ADR 0005);
  - `erasure.holdWhileReviewOrAppealOpen` (ADR 0004, D-19);
  - `consentDeclineContact`, the contact shown after a decline (D-17).
  - Defaults apply when a key is missing.
- The face-match threshold is system configuration tuned under D-05, not an org setting.
- Consent text gets its own table. Rows are immutable once used, because they are the legal proof of what the candidate agreed to (brd.md §7). The `consents` table is reshaped for the signed document (D-17, section 10).

```sql
CREATE TABLE consent_texts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  version            text NOT NULL,
  body_md            text NOT NULL,
  legal_approved_at  timestamptz,       -- NULL = placeholder (D-17)
  legal_approved_by  text,              -- Legal sign-off reference (Q-43)
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, version)
);
-- organizations add: current_consent_text_id uuid REFERENCES consent_texts(id)
-- consents: replace consent_version text with consent_text_id uuid NOT NULL REFERENCES consent_texts(id)
```

Alternative: the consent text lives in repository config and only a version string is recorded (backend.md Step 7 "from config"). No table, but there is one text for all orgs and admins cannot change the version (frontend.md Step 3).

## 7. Webhooks, report files and assistive tools (A-11 items 2, 3, 5)

**Webhooks (item 2).** Accepted now, so endpoint secrets never sit in `settings`:

```sql
CREATE TABLE webhook_endpoints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  url         text NOT NULL,
  events      text[] NOT NULL,         -- 'session.completed', 'session.reviewed'
  secret_enc  text NOT NULL,           -- AES-256-GCM, like totp_secret_enc
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_deliveries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id  uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event        text NOT NULL,
  session_id   uuid REFERENCES sessions(id) ON DELETE SET NULL,
  attempt      int NOT NULL,
  status_code  int,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON webhook_deliveries (endpoint_id, created_at DESC);
```

The payload is not stored, because it carries candidate data. Alternative: defer both tables to an ADR due before BE-14 (BR-15 is "Could", TC-081 is P3).

**Report PDF (item 3).** `sessions` add `report_key text` and `report_generated_at timestamptz`. Regenerating overwrites the file, and retention (ADR 0004 R-4) deletes it. Alternative: a `reports` table, if more than one report per session is ever needed.

**Assistive tools (item 5).** The accommodations zod schema gains `allowedAssistiveTools: string[]` (FR-305). No DDL, because `invitations.accommodations` is jsonb.

## 8. LOCKDOWN profile with no client (D-13, A-30)

| Option                                        | DDL                                                                                                                           | Effect                                                                                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **(a) Remove the value (accepted)**           | Drop `'LOCKDOWN'` from `proctor_profile`, and `'PROHIBITED_PROCESS'` from `event_type` (only the lockdown client produces it) | The shared zod enums cannot offer it, so there is nothing to hide or reject. The later lockdown ADR adds both back with a one-line `ALTER TYPE ... ADD VALUE` (forward-only). fsd.md FR-302 note added in Phase B. |
| (b) Keep the value but make it unselectable   | `CHECK (profile <> 'LOCKDOWN')` on `tests`                                                                                    | BE-06 returns 422 and FE-05 hides it. Every switch over the enum still handles a dead value.                                                                                                                       |
| (c) Keep it, shown disabled as "coming later" | none                                                                                                                          | UI text only, with the same dead value in code.                                                                                                                                                                    |

## 9. Consequences and affected agents

- **Accepted delta:**
  - 4 tables: `variant_test_cases`, `consent_texts`, `webhook_endpoints`, `webhook_deliveries`.
  - Columns: `question_versions.validation_report`, the `mcq_options` rename, `session_questions.answer` and the manual-scoring columns (D-23), `organizations.current_consent_text_id`, the reshaped `consents` (D-17), and `sessions.report_key` and `report_generated_at`.
  - 1 new enum (`question_scoring`, D-23); 2 enum values removed.
- **backend-engineer:** BE-04 (variants, validation report, `answer_spec`), BE-05 (per-variant validator), BE-06 (profile, S-6, accommodations, `consent-copy` template), BE-07 (consent document: sign, decline, PDF, email), BE-11 (formula, MCQ and short-answer scoring, manual-scoring queue, practice run), BE-13 (manual scoring endpoint and verdict gate), BE-14 (webhooks, report key).
- **frontend-engineer:** FE-03 (settings, consent texts, decline contact), FE-04 (variant test data, validation report, short-answer variants), FE-05 (profiles, sections), FE-09 (consent document, practice), FE-10 (MCQ and short answers), FE-11 (manual scoring panel).
- **db-engineer:** DB-04 seeds override rows, a placeholder consent text, `answer_spec` and a short-answer question.
- **qa-engineer:** QA-01A uses the updated TC-012, TC-030 and TC-048 and the new TC-095, TC-096 and TC-099.
- **Doc amendments (applied in Phase B):** database prompt Steps 2 and 4; backend.md Steps 4, 6, 7, 11 and 14; frontend.md Steps 3, 4, 5, 9 and 10; fsd.md FR-203, FR-205, FR-302, FR-401 and FR-506.

## 10. Amendments after acceptance (D-17, D-23)

**D-17: signed consent document per session.**

- **Document.** `consent_texts.body_md` holds the 2-3 page document.
  - It covers what is recorded (screen, webcam, microphone, keystrokes), the ID image and selfie, face matching, automated detection and human review, how results are used in hiring, retention and deletion, who can access the data, appeals, accommodations and how to withdraw.
  - Until Legal approves it, the text is a clearly marked placeholder and `legal_approved_at` is NULL.
  - Pilot and production run with `REQUIRE_LEGAL_APPROVED_CONSENT=true`, so the API refuses to serve an unapproved text there. Legal approval of the text and of the e-signature format are pilot entry blockers.
- **Flow.** Rules page, then email OTP, then consent document, then system check (D-06).
  - The sign button is enabled only after the candidate scrolls to the end.
  - The candidate types their full legal name.
  - The server sets `signed_at` from its own clock and stores IP and user agent.
  - Nothing touches camera, microphone or screen before `signed_at` is set (TC-030, TC-095).
- **Storage per session (`consents`):** `consent_text_id` (the document version), `signed_name`, `signed_at` or `declined_at`, `ip`, `user_agent`, `pdf_key`, `pdf_generated_at`, `copy_emailed_at`. The CHECKs are in database.md.
- **Never reused.** A new session needs a new signature; a resumed session keeps its signature.
- **PDF and email.** After signing, a job renders a PDF of the signed document: the document text, version, signed name and server timestamp. It stores the PDF in object storage, sets `pdf_key`, and emails the candidate a copy (template `consent-copy`), setting `copy_emailed_at`.
- **Decline.** It sets `declined_at`, moves the session to DECLINED (ADR 0002 §9), records no media, and shows `settings.consentDeclineContact` (TC-096).
- **Endpoints (ARC-02):**
  - `GET /candidate/session/consent` returns the document;
  - `POST /candidate/session/consent/sign {consentTextId, signedName}`;
  - `POST /candidate/session/consent/decline`.
- _Details chosen by architect; owner to confirm:_
  - declining is stored on the same `consents` row (`declined_at`), with a new terminal status DECLINED;
  - the PDF is emailed as an attachment (the email provider becomes a processor of the signed PDF; DPA in DEP-02);
  - the config flag `REQUIRE_LEGAL_APPROVED_CONSENT`;
  - the decline contact as the org setting `consentDeclineContact`;
  - no stored "scrolled to end" flag (the client enforces it; the PDF states how the document was signed).

**D-23: short answers.**

- `answer_spec` for SHORT_ANSWER is `{ canonical: string, acceptedVariants: string[] }`.
  - A candidate answer matches if, after normalization, it equals the canonical answer or any accepted variant.
  - Normalization: Unicode NFKC, trim, collapse inner whitespace, lower-case.
- A match scores `points` (`scoring = 'AUTO'`).
- A non-match is **never** scored 0 automatically. It gets `scoring = 'MANUAL_PENDING'` and `score` NULL, and the session goes to UNDER_REVIEW at GRADED (ADR 0002 §9).
- A REVIEWER (or SUPER_ADMIN) marks it correct or incorrect in the review workspace. That sets `score` to `points` or 0, `scoring = 'MANUAL'`, `scored_by`, `scored_at` and an optional `scoring_note`, and writes an audit row (TC-099).
- The verdict cannot be set while any answer is MANUAL_PENDING. `sessions.total_score` is computed when the last answer is scored.
- _Details chosen by architect; owner to confirm:_
  - the normalization steps;
  - manual scoring is all-or-nothing (no partial credit), matching section 3;
  - it is done by reviewers in the review workspace;
  - the scoring columns live on `session_questions`.
