# Retention and erasure (FR-704, NFR-05)

The service logic of DB-06 (ADR 0004 section 9, compliance decisions C-04, C-06, C-17, C-26, C-27,
C-35). The schema is Database A's; this folder is Database B's (DL-27).

**Built so far (slices 1 and 2):** the clocks, the switches, the object-store port with verified
deletion and the versioning gate, the face tier, the media tier (R-4), the results tier (R-10) with
candidate anonymisation and the accommodation reductions, consent records (R-9), the per-run audit row,
and the guards that keep the markers reserved and consent data behind one repository. **Slice 3 (this
folder's `erasure/`):** erasure on request (below).

## How a tier runs

1. **Select** in `runSystem('RETENTION_ERASURE')` with one reviewed raw query per tier (inside
   `runRawSql`): sessions of every org that are due and have no marker. It returns ids only and
   never writes.
2. **Per session**, in a plain `runInOrg(orgId)` through the org-scoped client: legal-hold check
   (OQ-10, off by default), "marker already there?" (a concurrent run), then list, delete and
   **verify**: every page listed, no DeleteObjects `Errors`, a fresh listing empty.
3. **Only after verification**, one transaction (which re-reads the R-2 holds under the per-session lock) nulls the columns and writes the marker
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
retention_anchor_at, created_at)`. For a session that was never submitted (EXPIRED, DECLINED, erased
while live) the anchor is its first terminal time: BE-07's `SessionStateService` stamps it on that
transition and the erasure fence keeps or sets it. (ADR 0004 9.2 says "earliest terminal-transition
audit row"; the state machine writes no such rows, so the anchor is used instead: FU-DBB-26 asks the hub
to amend the text.)

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
| `RETENTION_CONSENT_THROUGH_ERASURE` [keep]  | C-17: reserved; erasure never touches consents       |
| `RETENTION_VERSIONING_CHECK` [enforce]      | skip only on staging (R2, synthetic data)            |
| `RETENTION_BATCH_SIZE` [200]                | sessions per tier per run                            |

## Not wired yet

`RetentionModule` is not imported by `AppModule`. Wire it with `RetentionModule.forRoot({ objectStore:
MediaModule })`: BE-09's module exports `ObjectStorePort` (its `S3ObjectStore` adapter); the port is
never bound inside this folder. A scheduler (the BullMQ module) calls `RetentionService.runDaily()`
through a single-flight job. Tests use `../test/retention/in-memory-object-store.ts` (the retention test helpers live in `apps/api/src/test/retention`, which the build and the import guard leave out).

## Reserved audit actions

`consent-access.spec.ts` fails on any other access to the consent model, an include or select of it, `signedName`, or raw SQL on `consents`. `retention-markers.spec.ts` fails if any file outside the allowlist mentions `RETENTION_*_DONE`, `ERASURE_EMAIL_SENT`, `ERASURE_EMAIL_FAILED`, `ERASURE_COMPLETED`, `ERASURE_NOTICE_RECORDED`, `ERASURE_SESSION_FENCED`, `ERASURE_SESSION_PURGED`, `ERASURE_LIST_COMPLETED`, their constants, or a fragment they could be assembled from (as a constant, a string literal or inside raw SQL). Add a legitimate writer to the allowlist in the same PR.

## Erasure on request (`erasure/`, ADR 0004 9.5, C-06, C-17)

`ErasureService.run(orgId, candidateId)` is idempotent and re-runnable. Request id =
`{candidateId}_{epoch seconds of erasure_requested_at}`.

1. Hold (`organizations.settings.erasure.holdWhileReviewOrAppealOpen`, default **true**, anything but a
   boolean counts as true): a session that is UNDER_REVIEW or APPEALED, or has an open appeal, is skipped
   and the candidate is told once (`ERASURE_DELAY_NOTIFIED`). With the switch off the fence closes the
   open appeal (`CLOSED_ERASED`).
   1b. Before anything is fenced or deleted, `ErasureListPort.append` records the candidate on the erasure list that survives restores (a failure stops the run); `complete` follows when every session is settled and the candidate is anonymised, and a failure is retried by the sweep.
2. Request the fence for each other session through `SessionFencePort.requestFence` (a SERVICE session job
   that Backend B builds; it decides under the session lock, so a session that turned held stays as it is;
   retention never writes `sessions.status`), and schedule a look-again re-run. The service reads the status
   back: it records the fence time the first time it reads a session as ERASED and schedules the re-run after
   fence + 60 s + the storage sweep margin.
3. For each ERASED session: delete the whole prefix with verification, then one transaction (candidate
   lock first) applies R-6: delete events, batches, keystrokes, media chunks and identity checks;
   blank submissions, answers, scoring notes, review notes and appeal text; clear device info and the
   report key; reduce accommodations. After completion a session is skipped only if a purge row exists whose `at` (the pass start) is at or after its fence + 60 s + the margin. **Scores, verdicts and the session row stay** (R-10 anonymises them).
4. `ERASURE_COMPLETED` once per request, only when every session is ERASED, and a verified pass ran at or after fence + 60 s + the sweep margin (the fence time is recorded per session).
5. The candidate row is anonymised at the first of: the worker's email-sent row, a recorded manual notice
   (`recordManualNotice`, audited; once per request whoever asks), or day 28 of the deadline (request or last review/appeal close,
   whichever is later; it does not run while a hold is open). Day 25 with no notice raises one alert. The consent record is never touched.

`RetentionModule.forRoot({ ..., erasure })` takes a module exporting the five ports (fence, scheduler, notices, alerts, erasure list); without it every
erasure call is refused (fail closed).
