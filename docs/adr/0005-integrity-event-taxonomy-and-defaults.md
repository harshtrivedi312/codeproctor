# ADR 0005: Integrity event taxonomy, defaults, replay state and AI reference solutions

| Field | Value |
| --- | --- |
| Status | **Accepted** 2026-10-01 (D-16): every recommendation as proposed; amended by D-20 (AI solution languages and assistants) and D-21 (RESUME_OTP_FAILED event). See section 6. Applied to database.md; deltas in ADR 0008. |
| Author | architect |
| Decides | Q-07 storage (source decided by D-12), Q-08, Q-09, A-10 |
| Serves | FR-106, FR-603, FR-605, FR-610, FR-801, FR-802, FR-803, FR-804, FR-903; BR-10; NFR-08; TC-036, TC-053, TC-063, TC-065, TC-074, TC-075, TC-097 |
| Hands off | Canonical JSON and the signing scheme: ARC-03. events.ts: ARC-02. Worker use of AI reference solutions: ARC-04. |

## 1. Event types (Q-08)

Add these values to `event_type`:

| Value | Source | Default severity | Why |
| --- | --- | --- | --- |
| SIDE_CAMERA_DISCONNECTED | CLIENT, SERVER | HIGH | TC-036 |
| SIDE_CAMERA_RECONNECTED | CLIENT | LOW, weight 0 | Ends the SIDE_CAMERA_LOST pause (ADR 0002) |
| DROP_ATTEMPT | CLIENT | LOW | FR-603, TC-053 |
| CUT_ATTEMPT | CLIENT | LOW | frontend.md Step 6 blocks cut |
| SHORTCUT_BLOCKED | CLIENT | LOW | FR-603 "each attempt is logged" |
| EXTENSION_INTERFERENCE | CLIENT | MEDIUM | FR-610 |
| FULLSCREEN_RESTORED | CLIENT | LOW, weight 0 | Resume event (backend.md Step 10) |
| SCREEN_SHARE_RESUMED | CLIENT | LOW, weight 0 | Resume event |
| PROCTOR_RESUME | SERVER | LOW, weight 0 | FE-12 resume |
| IDLE_THEN_COMPLETE | SERVER | MEDIUM | FR-802 |
| DETECTOR_UNAVAILABLE | CLIENT | MEDIUM | A required detector or model file could not run (for example, blocked) |
| IDENTITY_MANUAL_REVIEW | SERVER | HIGH, weight 0 | Puts the identity decision on the timeline and behind the verdict gate (ADR 0002 §6) |
| RESUME_OTP_FAILED | SERVER | MEDIUM, weight 0; always pushed to /live | A wrong OTP while the test is in progress alerts the proctor (D-21, added after acceptance) |

- SDK capability flags are not events. They go in `sessions.device_info.capabilities`; the shape is defined in packages/shared.
- PROHIBITED_PROCESS: see ADR 0007 §8.
- Alternative: one generic `RESUMED` type with the reason in the payload. Fewer values, weaker typing.

## 2. Default severities and risk weights (Q-09)

No schema change. Defaults live in packages/shared; org overrides live in `organizations.settings.risk` (ADR 0007 §6).

- The server assigns severity from the event type. Severity sent by the client is ignored (ADR 0001 TB-1).
- **score = min(100, Σ over types of min(count, cap) × points[severity] × weight[type])**.
  - Default points: LOW 2, MEDIUM 8, HIGH 20.
  - Default cap: 3 events per type.
  - Default weight 1.0. Informational types and IDENTITY_MANUAL_REVIEW have weight 0.
  - Detectors disabled by accommodations have weight 0 and never run (FR-305).
- Bands as in FR-804. Check against TC-075: 2 HIGH + 3 MEDIUM = 40 + 24 = 64, so band HIGH.
- Default severity of the existing types:
  - **HIGH:** SCREEN_SHARE_STOPPED (TC-055), MULTIPLE_FACES (TC-058), PHONE_DETECTED, MULTIPLE_VOICES, VIRTUAL_CAMERA, MULTI_MONITOR, PASTE_BURST, CODE_SIMILARITY.
  - **MEDIUM:** FULLSCREEN_EXIT, TAB_SWITCH, FOCUS_LOST, DEVTOOLS_OPEN, NO_FACE, FACE_MISMATCH, GAZE_AWAY, BOOK_DETECTED, SPEECH_DETECTED, TYPING_ANOMALY, AI_LIKENESS.
  - **LOW:** PASTE_ATTEMPT, COPY_ATTEMPT, RIGHT_CLICK.
  - **LOW, weight 0 (informational):** DISCONNECTED, RECONNECTED, PROCTOR_PAUSE, PROCTOR_MESSAGE.
- These are starting values. The integrity-engineer documents them in /docs/integrity-config.md and they are tuned in the pilot (R-06).
- Alternative: severity points with no per-type cap. Simpler, but one noisy detector can reach 100 on its own.

## 3. Replay state for event batches (A-10)

- (b) **Accepted:** a batch table, inserted in the same transaction as the batch's events.

```sql
CREATE TABLE proctor_event_batches (
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          int  NOT NULL,
  signature    bytea NOT NULL,      -- HMAC-SHA256 as received (32 bytes)
  event_count  smallint NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);
-- proctor_events add:   batch_seq int          (NULL for SERVER events)
-- keystroke_batches add: signature bytea NOT NULL
```

  - Same `seq` and same signature: a retry whose response was lost. Answer 200 and store nothing.
  - Same `seq` and a different signature: replay or tampering. Reject (TC-065).
  - Batches that arrive out of order after an offline period are accepted (NFR-08, TC-063).
- (a) `sessions.last_event_seq bigint` with "seq must be greater". This rejects a batch that arrives after a later one succeeded, so batches buffered during a network drop would be lost.
- (c) Redis with append-only persistence only. Lost on a flush or a database restore.

## 4. AI reference solutions (Q-07 storage, D-12)

D-12: question authors run each question through 2-3 popular AI assistants at publish time. The solutions are used for similarity checks only, never for grading, and are refreshed periodically.

| Option | Shape | Problem |
| --- | --- | --- |
| **(a) Table linked to the question version (accepted)** | `ai_reference_solutions` (below) | One more table |
| (b) jsonb on `question_versions` | One column | Published versions are immutable (FR-204, Data rules), so a refresh would need a new question version or an exception to that rule |
| (c) Files in object storage keyed by version | No DDL | No audit trail, no per-row metadata, a second access path to secure |

```sql
CREATE TABLE ai_reference_solutions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_version_id uuid NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
  variant_id          uuid REFERENCES question_variants(id) ON DELETE CASCADE,  -- NULL = base statement
  assistant           text NOT NULL,     -- product, for example 'ChatGPT', 'Claude', 'Gemini'
  model_label         text NOT NULL,     -- model or version label as the assistant shows it
  language            text NOT NULL,     -- one of question_versions.allowed_languages
  solution_code       text NOT NULL,
  prompt_text         text,              -- prompt used, if it differs from the statement
  collected_at        timestamptz NOT NULL,
  collected_by        uuid NOT NULL REFERENCES users(id),
  superseded_at       timestamptz,       -- set when a refresh replaces this row
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ai_reference_solutions (question_version_id);
```

Rules:
- **AI-1** Rows are append-only. A refresh inserts new rows and sets `superseded_at` on the rows they replace. CODE_SIMILARITY and AI_LIKENESS events cite the row they matched (payload `aiReferenceSolutionId`), so a reviewer or an appeal can see it.
- **AI-2** The worker compares a submission with every row of the session's question version (current and superseded; variant rows first when present) in the same language.
- **AI-3** Never used for grading. Only the analysis worker reads the table. Grading (BE-11) and candidate serializers never touch it (code-reviewer check), and it is hidden from candidates like `reference_solution` (TC-011).
- **AI-4 Refresh.** Org setting `aiReferences.refreshDays` (default 90). FE-04 shows "refresh due" when a version's newest row is older than that. There is no automatic job, because collection is manual.
- **AI-5 Publish gate.** For each of the question's allowed languages that is in the D-20 list (python, javascript, java), publishing requires rows from at least `aiReferences.minAssistants` distinct assistants (default 2; 0 turns the gate off). Alternative: warn only.
- **AI-6 Audit and retention.** Create and supersede are audited (`ai_reference.create`, `ai_reference.supersede`). The rows are question content, not candidate data: the retention job ignores them, and they are deleted only with their question version.

Owner answers (D-20) and what is still open:
- **Languages:** Python, JavaScript and Java only. More are added only when a role needs them.
- **Assistants:** two, on business or team plans that do not train on inputs. This addresses the question-leak risk (brd.md §9).
- **Still not verified:** each assistant's terms on keeping and reusing outputs.

## 5. Consequences and affected agents

- **Accepted delta:** 13 new `event_type` values (section 1, including RESUME_OTP_FAILED from D-21), 2 tables (`proctor_event_batches`, `ai_reference_solutions`), `proctor_events.batch_seq`, `keystroke_batches.signature`.
- **integrity-engineer:** BE-10 (batch table, idempotent retry), BE-12 (weights, caps, AI-2), /docs/integrity-config.md.
- **backend-engineer:** **BE-04** gets an author API to add, list and supersede AI solutions, and the publish gate (AI-5). This is new knock-on work.
- **frontend-engineer:** **FE-04** gets an author UI tab for AI solutions and the refresh-due badge. This is new knock-on work.
- **proctor-sdk-engineer:** FE-06 and FE-08 emit the new client types.
- **architect:** ARC-02 updates events.ts. ARC-04 only consumes the stored solutions.
- **db-engineer:** DB-02 and DB-03 apply the delta. DB-04 seeds AI rows for each seeded coding question: 2 assistants × Python, JavaScript and Java = 6 rows, clearly marked as synthetic.

## 6. Amendments after acceptance (D-20, D-21)

- **D-20 languages.** The shared constant `AI_REFERENCE_LANGUAGES = ['python','javascript','java']` lists the languages that get AI reference solutions. BE-04 rejects other languages.
  - *Detail chosen by architect; owner to confirm:* the constant, not a database CHECK. Adding a language when a role needs it is then a code change, not a migration.
- **D-20 assistants.** Two assistants on business or team plans that do not train on inputs. `aiReferences.minAssistants` defaults to 2. The `assistant` and `model_label` columns record which ones; which products to use is the owner's choice and is not a system dependency.
- **D-21 RESUME_OTP_FAILED.** Added to section 1.
  - *Detail chosen by architect; owner to confirm:* severity MEDIUM with risk weight 0, because a typo must not raise the risk score; the proctor alert comes from the forced push to /live, not from the severity.
