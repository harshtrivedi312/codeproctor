# Retention and erasure (FR-704, NFR-05)

The service logic of DB-06 (ADR 0004 section 9, compliance decisions C-04, C-06, C-17, C-26, C-27,
C-35). The schema is Database A's; this folder is Database B's (DL-27).

**Built so far (slices 1 and 2):** the clocks, the switches, the object-store port with verified
deletion and the versioning gate, the face tier, the media tier (R-4), the results tier (R-10) with
candidate anonymisation and the accommodation reductions, consent records (R-9), the per-run audit row,
and the guards that keep the markers reserved and consent data behind one repository. **Next slice:**
erasure (the fence through BE-07's SessionStateService via a port, the hold, the re-run, the notice).

## How a tier runs

1. **Select** in `runSystem('RETENTION_ERASURE')` with one reviewed raw query per tier (inside
   `runRawSql`): sessions of every org that are due and have no marker. It returns ids only and
   never writes.
2. **Per session**, in a plain `runInOrg(orgId)` through the org-scoped client: legal-hold check
   (OQ-10, off by default), "marker already there?" (a concurrent run), then list, delete and
   **verify**: every page listed, no DeleteObjects `Errors`, a fresh listing empty.
3. **Only after verification**, one transaction nulls the columns and writes the marker
   (`RETENTION_FACE_DONE` or `RETENTION_MEDIA_DONE`, `entity_type 'session'`, `entity_id` the session
   id as text, metadata `{ tier, runId }`). Otherwise nothing changes and the next run tries again.
4. One `RETENTION_RUN` audit row per org per run: the run id and counts, nothing else.

No `sessions` row is ever deleted (ADR 0004 9.3). Object keys are never logged or returned; a warning
names the session id only.

| Tier        | Due when                                                                | Deletes                                                       | Nulls                                                                                |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Face        | face clock + LEAST(`retention_days`, 90); no hold (C-27, C-35)          | `identity/`, and `evidence/` (OQ-19 on) or `evidence/sealed/` | identity keys, evidence keys                                                         |
| Media (R-4) | anchor + `retention_days` (OQ-18 cap optional); a NULL anchor is a hold | the session prefix except `reports/`                          | media keys (+ `deleted_at`), evidence and identity keys; deletes `keystroke_batches` |

The face clock is `COALESCE(submitted_at, GREATEST(latest identity check, latest FACE_MISMATCH),
first terminal transition, created_at)`. The terminal-transition source is the earliest audit row
whose action is in `TERMINAL_TRANSITION_ACTIONS` (`retention.repository.ts`); BE-07's
`SessionStateService` owns the real names, so that list is the one place to change.

## Switches (`retention.config.ts`)

Environment variables, defaults in brackets. They map to the owner's open questions.

| Variable                                    | Question                                             |
| ------------------------------------------- | ---------------------------------------------------- |
| `RETENTION_LEGAL_HOLD` [false]              | OQ-10: ask `LegalHoldPort` before touching a session |
| `RETENTION_DECLINED_CONSENTS_EXPIRE` [true] | OQ-11 (used by the consent slice)                    |
| `RETENTION_REDUCE_ACCOMMODATIONS` [true]    | OQ-12 (erasure and R-10 slices)                      |
| `RETENTION_MEDIA_CAP_DAYS` [unset]          | OQ-18: set 90 for LEAST(`retention_days`, 90)        |
| `RETENTION_EVIDENCE_IN_FACE_TIER` [true]    | OQ-19                                                |
| `RETENTION_RESULTS_CLOCK` [anchor]          | OQ-20 (results slice)                                |
| `RETENTION_CONSENT_THROUGH_ERASURE` [keep]  | C-17 (erasure slice)                                 |
| `RETENTION_VERSIONING_CHECK` [enforce]      | skip only on staging (R2, synthetic data)            |
| `RETENTION_BATCH_SIZE` [200]                | sessions per tier per run                            |

## Not wired yet

`RetentionModule` is not imported by `AppModule`. Wire it with `RetentionModule.forRoot({ objectStore:
MediaModule })`: BE-09's module exports `ObjectStorePort` (its `S3ObjectStore` adapter); the port is
never bound inside this folder. A scheduler (the BullMQ module) calls `RetentionService.runDaily()`
through a single-flight job. Tests use `testing/in-memory-object-store.ts`.

## Reserved audit actions

`consent-access.spec.ts` fails on any other access to the consent model, an include or select of it, `signedName`, or raw SQL on `consents`. `retention-markers.spec.ts` fails if any file outside the allowlist mentions `RETENTION_*_DONE`,
`ERASURE_EMAIL_SENT`, `ERASURE_EMAIL_FAILED`, `ERASURE_COMPLETED` or their constants (as a
constant, a string literal or inside raw SQL). Add a legitimate writer to the allowlist in the same PR.
