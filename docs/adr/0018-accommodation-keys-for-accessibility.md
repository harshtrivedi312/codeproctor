# ADR 0018: Accommodation keys for accessibility (owner decision C-61, P-44)

| Field | Value |
| --- | --- |
| Status | **Proposed** 2026-10-07. The owner accepts or amends. "(owner decision C-61)" marks what docs/compliance/decisions.md already decides. "(architect detail)" marks what this ADR adds, which the owner must confirm: in particular the keys `idPhotoUpload` and `microphoneNotRequired`, the reason code `CANNOT_MOVE_CAMERA` and the image source column are architect detail, because C-61 approves the alternatives in principle and not their storage. A change to `packages/shared` and a schema change are the owner's under CLAUDE.md rule 7. |
| Author | architecture hub |
| Decides | The stored accommodation keys, shared types, API, audit, lock, projections, privacy handling and retention that FR-305, FR-402 and FR-403 need after C-61: uncapped extra time, the assistive input label, the microphone path, the ID photo upload and the room-scan alternative |
| Does not decide | The slot length and ceiling per session (ADR 0017 4.3, FR-306); the UI wording (frontend); the consent text (the Delivery Lead, with the DPIA) |
| Serves | FR-305, FR-402, FR-403, FR-404, FR-105; NFR-04, NFR-05, NFR-06; BR-12; TC-115, TC-116, TC-117 |
| Builds on | ADR 0015 (accommodations, the waiver, the lock and CAS, audit, projections, privacy S6 and S7, retention), ADR 0010, ADR 0013 CS-4.4 and 5.6, ADR 0004 section 5 and 9, ADR 0005 and C-14, ADR 0008, ADR 0002 section 2 and L-60 (the gate), ADR 0017 4.3 |
| Amends (on acceptance) | ADR 0010 section 5 request of ADR 0015 (`accommodationsSchema`, `candidateAccommodationsSchema`, `reviewIdentityProjectionSchema`, `ACCOMMODATION_DETECTORS`); ADR 0015 sections 3, 5 and 6; ADR 0013 CS-4.4 (the `identity_checks` create allow-list and the candidate projection list) and 5.6 (a new presign purpose); ADR 0002 section 2 (the gate condition "room scan uploaded"); ADR 0008 (a new section 11 delta); ADR 0004 R-4 and the erasure and R-10 reductions; ADR 0017 4.3 (the extra-time interaction, already in PR #267) |

## 1. Context

- C-61 approves: camera alternatives (OQ-A11Y-1), a microphone path (OQ-A11Y-3), a list of allowed assistive tools (OQ-A11Y-6), extra time with **no cap** decided per candidate by the recruiter (OQ-A11Y-9), and a per-candidate "assistive input" label that relabels flags and never changes detection (C-14).
- Every key here is a recruiter decision. A candidate never sets one (C-02): nothing changes detection or rejects without a person.
- The silent loss of evidence is the main way a recruiter could help a candidate cheat (ADR 0015 owner question 9). Each key therefore leaves a reviewer-visible signal and an audit row, and none of them can be removed after the candidate has used it.

## 2. Decisions

| # | Topic | Decision | Basis |
| --- | --- | --- | --- |
| 1 | Extra time | `extraTimePct` has **no business cap** (C-61): an integer of at least 0 and at most 1 000 000 in the schema (a technical bound). The server computes `deadline_at` and the window from it per session (ADR 0017 4.3). No in-process timer may be armed for the whole duration: a timer holds at most 2^31 ms (about 24.8 days), so deadlines are enforced by timestamps and by chunked or delayed jobs, never by one long `setTimeout` | C-61; the bound and the timer rule: architect detail |
| 2 | No microphone | An **explicit** key `microphoneNotRequired?: true`. Setting it forces `VOICE` into `disabledDetectors` (as `REFUSED_BIOMETRIC_PROCESSING` forces FACE and GAZE off, ADR 0015 section 3); `VOICE` is added to `ACCOMMODATION_DETECTORS`. It can be set or removed only in INVITED, before the consent document can be read (the reason ADR 0015 gives for the FACE override). The system check then reports the microphone as not required and never blocks. If a microphone exists, AUDIO is still recorded (ADR 0015 section 3), and the consent text says "audio is recorded if a microphone is available". A missing or denied microphone is recorded as evidence (a `DETECTOR_UNAVAILABLE` for `VOICE`, which is neither a pause nor a verdict), and the reviewer and the internal report show "Microphone not required; audio may be absent". Turning `VOICE` off for another reason does not make the microphone optional | C-61; the key and rules: architect detail |
| 3 | Assistive input label | An optional key `assistiveInput?: true`. It relabels flags only. It can be set or cleared at any status except ERASED, and every change is audited with its time, which the reviewer sees ("label added at ..."), so it cannot relabel evidence without a trace. No worker, SDK, risk-score or webhook payload carries it | C-61 |
| 4 | ID photo upload | An optional key `idPhotoUpload?: true`: the recruiter enables an upload of a photo taken with the candidate's own device for that candidate. It covers the **ID image only**: the `SELFIE` presign and the liveness step never accept an upload | C-61; the key: architect detail |
| 5 | Room-scan alternative | An optional key `roomScanAlternative?: { reasonCode, reasonNote? }`, with `reasonCode` one of `CANNOT_MOVE_CAMERA` and `OTHER` (architect detail), with the note rules of `identityCheckWaiver` (the note is allowed and required only for `OTHER`) and the privacy rules of section 5. The recruiter and reviewer check the room by another route (C-02). The key is set only in INVITED or CONSENTED and removed only in INVITED; once the gate has used it (the session is VERIFIED) it is frozen, so the reviewer's "room scan replaced" cannot disappear. The reviewer's badge is read from that frozen key and from the SET audit row | C-61; window and freeze: architect detail |
| 6 | Image source | A column `identity_checks.id_image_source` with a new enum `id_image_source` (`CAPTURED`, `UPLOADED`), set **by the server from the presign purpose it recorded**, never from client input, and shown to the reviewer. `CAPTURED` means only that the in-app capture flow was used: a modified client can upload through that route, so the label is not proof of a live photo | architect detail; schema change for the owner |

## 3. Shared contract (ADR 0010 amendment request)

| Name | Kind | Change |
| --- | --- | --- |
| `accommodationsSchema`, `Accommodations` | zod, type | Add the optional `assistiveInput`, `idPhotoUpload`, `microphoneNotRequired` and the lenient `roomScanAlternative`; `extraTimePct` becomes an integer from 0 to 1 000 000. The PATCH uses the waiver's semantics for these keys (below) |
| `ACCOMMODATION_DETECTORS` | const | Add `VOICE` |
| `ROOM_SCAN_ALTERNATIVE_REASONS`, `roomScanAlternativeSchema`, `storedRoomScanAlternativeSchema` | const, zod | New: the write schema and the lenient read schema (with `reasonNoteRemoved`), mirroring the waiver |
| `accommodationsPatchSchema` | zod | The new keys are each optional (**omitted means unchanged**) or `null` (remove), like `identityCheckWaiver`, so a stale client cannot clear them. Resending a deep-equal value outside its window is a no-op, not a 409, so an extra-time change is never blocked by it |
| `candidateAccommodationsSchema`, `CandidateAccommodations` | zod, type | Gains one object, `gate: { idPhotoUpload: boolean, roomScanAlternative: boolean, microphoneNotRequired: boolean }`, so the candidate screens never infer anything from `disabledDetectors`. `assistiveInput` and every reason are never projected to the candidate |
| `reviewIdentityProjectionSchema` | zod | Gains `idImageSource` and `accommodationsShown: { assistiveInput?: { setAt }, roomScanReplaced?: true, microphoneNotRequired?: true }` (no reason) |
| `ID_IMAGE_SOURCES`, `idImageSourceSchema` | const, zod | New: a mirror of the DB enum |
| `webhookIdentityCheckSchema` and the CSV export | zod | **Unchanged**: none of the new keys, and no image source, is sent in webhooks or CSV (neutral output, as for the waiver) |
| Problem codes | const | `ACCOMMODATION_NOT_ENABLED` (an ID upload without the allowance), in `PROBLEM_CODES` (api-contract in the PR that builds this) |

## 4. API, locking, audit and gate

- **Routes.** The PATCH and GET of ADR 0015 section 6 carry the new keys. The permission is the existing `invitation_accommodations:update`; no new permission.
- **Lock and compare-and-set.** The writes use the ADR 0015 mechanism (`lockForAccommodation` and the CAS on `accommodations`). The windows are in section 2 (rows 2, 3 and 5; the upload allowance row 4 is INVITED to CONSENTED). Any change to a key of this ADR is refused with 409 on an ERASED session.
- **Audit.** Every change writes the existing `INVITATION_ACCOMMODATIONS_UPDATED` row with `changedKeys` (ids and key names only, never a value, a reason or a note), plus a neutral, reason-free action per key where the reviewer needs to see the time: `ACCOMMODATION_ASSISTIVE_INPUT_SET` and `_CLEARED`, `ACCOMMODATION_MICROPHONE_NOT_REQUIRED_SET` and `_CLEARED`, `ACCOMMODATION_ID_UPLOAD_ENABLED` and `_DISABLED`, `ACCOMMODATION_ROOM_SCAN_ALTERNATIVE_SET` and `_CLEARED`. These actions follow the ADR 0015 S6 rule: only holders of `invitation_accommodations:read` can read them.
- **The gate (ADR 0002 section 2, L-60).** The condition "room scan uploaded" becomes "room scan uploaded, or `roomScanAlternative` set". When the key is set while the session is CONSENTED, the write enqueues `verify-session` after the commit, and the reconciler covers a lost job (the ADR 0015 S1 mechanism), so a candidate waiting at the room-scan step is not stuck. The identity gate rule is unchanged (a waiver or the match; ADR 0015).
- **ID upload route (architect detail).**
  - **Token.** An upload from a phone link uses a random token stored only as a hash, bound to the session, the organisation, the purpose `ID_IMAGE` and the attempt, single use, with a short TTL (15 minutes). It is revoked when the session leaves CONSENTED, when a waiver is set, and when erasure starts. It never appears in a URL path or query (a fragment and a POST exchange, `Referrer-Policy: no-referrer`), is never logged, and is rate limited (NFR-04). The organisation comes from the token's server record, never from the request. (The side-camera pairing of FR-405 has no written design; this is the design for both, and the pairing follows it.)
  - **Presign.** A new presign purpose `ID_IMAGE_UPLOAD` records the source `UPLOADED`; the existing `ID_IMAGE` purpose records `CAPTURED`. Size is limited by a presigned POST with a `content-length-range` of 10 MB. Without the allowance the presign is refused with `ACCOMMODATION_NOT_ENABLED`; with a waiver set, `IDENTITY_CHECK_WAIVED` takes precedence.
  - **Handling.** The type is detected from the file's magic bytes, not from `Content-Type` (JPEG, PNG and HEIC only). Decoding runs in the worker sandbox with a limit of 40 megapixels and a decompression-bomb check. The EXIF orientation is applied, the image is re-encoded from pixels (so EXIF, GPS and other metadata are dropped), and the original, which still carries the location data, is deleted at once after the re-encode (the DL-30 sweep and R-4 are only backstops). EXIF is never read into a log or an event.
- **Who sees what.** The recruiter sees every key (the audited GET). The reviewer and the internal report PDF show: the assistive input label with the time it was set, "room scan replaced", "Microphone not required; audio may be absent", and the image source (uploaded or captured through the app). Never a reason. The candidate sees only the `gate` object. Nothing here changes a detector, an event or a risk score (C-14, ADR 0005): the label only relabels, and Integrity B tests that the worker, the risk score and the events are identical with and without it.

## 5. Privacy of the new note and reason

`roomScanAlternative.reasonNote` is health-adjacent free text, so it gets the protections ADR 0015 gives the waiver note:

- pino redaction paths for `accommodations.roomScanAlternative.reasonNote` and `.reasonCode` on the invite body, the PATCH and the GET response logging, with a test;
- validation errors that never echo the value (ADR 0015 S7);
- the redact-note operation (GDPR Art. 16) covers this note, and the redaction is re-applied after a restore (ADR 0015 section 6, B2; the redaction list under `db/erasure-list/`, ADR 0017 5.3);
- the reason and the note are never in a webhook, CSV, candidate projection, reviewer projection, report or audit value;
- the new keys join the erasure, R-10 and step-7 "Verified" checks (ADR 0015 section 6 (b)).

## 6. Schema (ADR 0008 post-freeze change)

- **Column and enum.** `identity_checks.id_image_source id_image_source`, and the enum type `id_image_source` (`CAPTURED`, `UPLOADED`).
- **Checks.** A new CHECK `id_image_key IS NULL OR id_image_source IS NOT NULL` (R-4 nulls the key and keeps the row, which is fine), and the existing `identity_checks_waived_check` is extended so that a WAIVED row has no `id_image_source`.
- **ADR 0008 section 11 deltas.** Enum types +1, columns +1, CHECKs +1 (the extension of the existing CHECK does not change the count). The row, the totals, the database.md DDL and the migration land together in Database A's PR, because the schema check compares them.
- The new accommodation keys live in the existing `invitations.accommodations jsonb`; no column for them.

## 7. Retention and erasure

- **R-4 (the note).** `roomScanAlternative.reasonNote` is removed at the R-4 tier and `reasonNoteRemoved: true` is set, as for the waiver.
- **Erasure and R-10.** The ADR 0015 reductions delete the keys `assistiveInput`, `idPhotoUpload`, `microphoneNotRequired` and `roomScanAlternative` (no reason survives); the server-only `identityCheckWaived: true` rule is unchanged. `id_image_source` goes with the identity check rows, which erasure and R-10 delete.
- **Backups.** The usual rule: erasure and the redactions are re-applied after a restore (ADR 0004 section 9.7).

## 8. Consequences and affected agents

- **Backend:** the PATCH and GET keys, the lock and CAS rules, the audit actions, the gate change and the `verify-session` enqueue, the upload route and its image handling, the forced `VOICE`, the deadline from an uncapped `extraTimePct` and the timer rule. `apps/api/src/session/accommodations.ts` has `MAX_EXTRA_TIME_PCT = 300` and treats a larger stored value as no extra time (with a warning): it changes together with the shared bound, or a candidate with 400 percent starts with none. It also accepts non-integers; it must follow the schema.
- **Frontend:** the invite and accommodations form, the candidate steps (upload, room-scan alternative, no-microphone), the reviewer badges.
- **Database:** the one column and enum, the two CHECKs, the erasure and R-10 reductions, the R-4 note removal.
- **Integrity:** the label relabels flags only; confirm against ADR 0005 that no detector or risk-score path reads it; the `VOICE` forced-off path.
- **QA:** TC-115, TC-116 and TC-117.

## 9. Owner questions

1. Accept the keys of section 2, including the architect details named in the Status row.
2. Accept the schema change of section 6 (one column, one enum, one CHECK).
3. Accept that `idPhotoUpload` is a recruiter-enabled allowance, not open to every candidate (the hub's recommendation, to keep the live capture as the default evidence).
4. Accept the 1 000 000 percent technical bound (the owner said no cap; the bound only protects the arithmetic and the timers).
