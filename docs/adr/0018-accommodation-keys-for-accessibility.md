# ADR 0018: Accommodation keys for accessibility (owner decision C-61, P-44)

| Field | Value |
| --- | --- |
| Status | **Proposed** 2026-10-07. The owner accepts or amends. "(owner decision C-61)" marks what docs/compliance/decisions.md already decides. "(architect detail)" marks what this ADR adds, which the owner must confirm. A change to `packages/shared` and a schema change are the owner's under CLAUDE.md rule 7. |
| Author | architecture hub |
| Decides | The stored accommodation keys, shared types, API, audit, lock, projections and retention that FR-305, FR-402 and FR-403 need after C-61: no cap on extra time, the assistive input label, the microphone path, the ID photo upload and the room-scan alternative |
| Does not decide | The slot length and ceiling per session (ADR 0017 4.3 and FR-306, which follow from extra time); the UI wording (frontend) |
| Serves | FR-305, FR-402, FR-403, FR-404, FR-105; NFR-06; BR-12; TC-115, TC-116, TC-117 |
| Builds on | ADR 0015 (accommodations, the identity-check waiver, the lock and CAS, audit, projections, retention), ADR 0010 (shared contracts), ADR 0013 CS-4.4 (candidate projection), ADR 0004 section 5 and 9 (R-4, erasure, R-10), ADR 0005 and C-14 (flags only; a person decides), ADR 0008 (schema), ADR 0017 4.3 |
| Amends (on acceptance) | ADR 0010 section 5 request of ADR 0015 (`accommodationsSchema`, `candidateAccommodationsSchema`, `reviewIdentityProjectionSchema`); ADR 0015 sections 3, 5 and 6 (the new keys); ADR 0008 (a new section 11 delta); ADR 0004 R-4 and the erasure and R-10 reductions |

## 1. Context

- C-61 approves: camera alternatives (OQ-A11Y-1), a microphone path (OQ-A11Y-3), a list of allowed assistive tools (OQ-A11Y-6), extra time with **no cap** decided per candidate by the recruiter (OQ-A11Y-9), and a per-candidate "assistive input" label that relabels flags and never changes detection (C-14).
- FSD changes are in PR #267 (FR-305, FR-402, FR-403). They need stored keys. `accommodationsSchema` today holds `extraTimePct`, `disabledDetectors`, `allowedAssistiveTools`, `notes`, the optional `identityCheckWaiver` and the server-only `identityCheckWaived` (ADR 0015 section 5).
- Every key here is a recruiter decision. A candidate never sets one (C-02): nothing changes detection or rejects without a person.

## 2. Decisions

| # | Topic | Decision | Basis |
| --- | --- | --- | --- |
| 1 | Extra time | `extraTimePct` has **no business cap** (C-61). The write schema keeps an integer of at least 0 and a technical bound of 100 000 percent so the deadline arithmetic cannot overflow; the server computes `deadline_at` and the window from it per session (ADR 0017 4.3, FR-306) | C-61; bound: architect detail |
| 2 | No microphone | **No new key.** "Microphone not required" is derived: it holds when `disabledDetectors` contains `VOICE` (the audio detector, `PROCTOR_DETECTORS`). The system check then reports the microphone as not required and never blocks. Audio recording itself follows ADR 0015 section 3 | C-61; derivation: architect detail |
| 3 | Assistive input label | New optional key `assistiveInput?: true` | C-61 |
| 4 | ID photo upload | New optional key `idPhotoUpload?: true`: the recruiter enables an upload of a photo taken with the candidate's own device for that candidate | C-61; key: architect detail |
| 5 | Room-scan alternative | New optional key `roomScanAlternative?: { reasonCode, reasonNote? }`, with `reasonCode` one of `CANNOT_MOVE_CAMERA` and `OTHER`, the same note rules as `identityCheckWaiver` (the note is allowed and required only for `OTHER`, removed by R-4, never shown to the candidate or the reviewer). The recruiter and reviewer check the room by another route (C-02) | C-61; shape: architect detail |
| 6 | Image source | A new column `identity_checks.id_image_source`, with a new enum `id_image_source` (`CAPTURED`, `UPLOADED`), set when the image is stored and shown to the reviewer as evidence (an ADR 0008 delta) | architect detail; schema change for the owner |

## 3. Shared contract (ADR 0010 amendment request)

| Name | Kind | Change |
| --- | --- | --- |
| `accommodationsSchema`, `Accommodations` | zod, type | Add the optional `assistiveInput`, `idPhotoUpload` and the lenient `roomScanAlternative`; `extraTimePct` loses its old upper bound and gets the technical bound of 100 000 |
| `ROOM_SCAN_ALTERNATIVE_REASONS`, `roomScanAlternativeSchema`, `storedRoomScanAlternativeSchema` | const, zod | New: the write schema and the lenient read schema (with `reasonNoteRemoved`), mirroring the waiver |
| `accommodationsPatchSchema` | zod | The PATCH body gains the same keys; `roomScanAlternative` is optional (omitted means unchanged) or `null` (remove); `assistiveInput` and `idPhotoUpload` accept `true` or `null` |
| `candidateAccommodationsSchema`, `CandidateAccommodations` | zod, type | Gains `idPhotoUpload` and `roomScanAlternative: boolean` (present or not, never the reason), so the screens can show the right step. `assistiveInput` is never projected to the candidate |
| `reviewIdentityProjectionSchema` | zod | Gains `idImageSource` and, for the review bundle, `accommodationsShown: { assistiveInput?: true, roomScanReplaced?: true }` (no reason) |
| `ID_IMAGE_SOURCES`, `idImageSourceSchema` | const, zod | New: a mirror of the DB enum |
| `webhookIdentityCheckSchema` and the CSV export | zod | **Unchanged**: none of the new keys, and no image source, is sent in webhooks or CSV (neutral output, as for the waiver) |

## 4. API, locking, audit and projections

- **Routes.** The PATCH and GET of ADR 0015 section 6 carry the new keys (`PATCH /invitations/:id/accommodations`, the audited GET). The permission is the existing `invitation_accommodations:update`; no new permission.
- **Lock and compare-and-set.** The writes use the ADR 0015 mechanism (`lockForAccommodation` and the CAS on `accommodations`). `idPhotoUpload` and `roomScanAlternative` can be set or removed only while the session is not yet IN_PROGRESS (INVITED to VERIFIED), because they change the pre-test gate; `assistiveInput` and `extraTimePct` follow the extra-time rule of FR-305 (set with the slot, re-booked if changed after booking, not changed during the test). Any change to a key of this ADR is refused with 409 on an ERASED session, as for the other accommodations.
- **Audit.** Every change writes a neutral, reason-free audit row, like `FACE_DETECTORS_DISABLED`: `ACCOMMODATION_ASSISTIVE_INPUT_SET` and `_CLEARED`, `ACCOMMODATION_ID_UPLOAD_ENABLED` and `_DISABLED`, `ACCOMMODATION_ROOM_SCAN_ALTERNATIVE_SET` and `_CLEARED`, and the existing extra-time audit (C-02). The reason and note never go in the audit row.
- **Upload route (architect detail).** With `idPhotoUpload`, the ID presign accepts an `UPLOADED` source. The file is re-encoded server-side with its EXIF and location data removed, the type is limited to JPEG, PNG and HEIC and the size to a stated maximum, and an upload from a phone link uses a scoped single-use token like the side-camera pairing (FR-405). Without the allowance an upload is refused with the existing problem code family (`DETECTOR_DISABLED` is not reused; a new `ACCOMMODATION_NOT_ENABLED` code is added to `PROBLEM_CODES`, an api-contract section in the PR that builds this).
- **Who sees what.** The recruiter sees every key (the audited GET). The reviewer sees `assistiveInput` next to that candidate's paste-like, keystroke and speech flags, "room scan replaced", and the image source; never a reason. The candidate sees only what the screens need (section 3). Nothing here changes a detector, an event or a risk score (C-14, ADR 0005): the label only relabels.

## 5. Schema (ADR 0008 post-freeze change)

- `identity_checks.id_image_source id_image_source` (nullable until an image exists, then `CAPTURED` or `UPLOADED`; a CHECK that a WAIVED row has none), and the enum type `id_image_source`. One column and one enum type; the table, the foreign keys and the indexes are otherwise unchanged. The ADR 0008 section 11 row and totals, the database.md DDL and the migration land together in Database A's PR (the schema check compares them).
- The new accommodation keys live in the existing `invitations.accommodations jsonb`; no column for them.

## 6. Retention and erasure

- **R-4 (the note).** `roomScanAlternative.reasonNote` is removed at the R-4 tier and `reasonNoteRemoved: true` is set, as for the waiver.
- **Erasure and R-10.** The erasure and R-10 reductions of ADR 0015 delete the `assistiveInput`, `idPhotoUpload` and `roomScanAlternative` keys (no reason survives); the server-only `identityCheckWaived: true` rule is unchanged. `id_image_source` goes with the identity check rows, which erasure and R-10 delete.
- **Backups.** The usual rule: erasure is re-applied after a restore (ADR 0004 section 9.7).

## 7. Consequences and affected agents

- **Backend:** the PATCH and GET keys, the lock and CAS rules, the audit actions, the upload route and its image handling, the derived microphone rule, the deadline from an uncapped `extraTimePct` (with ADR 0017 4.3 and FR-306).
- **Frontend:** the invite and accommodations form, the candidate steps (upload, room-scan alternative, no-microphone), the reviewer badges.
- **Database:** the one column and enum, the erasure and R-10 reductions, the R-4 note removal.
- **Integrity:** the label relabels flags only; confirm against ADR 0005 that no detector or risk-score path reads it.
- **QA:** TC-115, TC-116 and TC-117.

## 8. Owner questions

1. Accept the keys of section 2 (and the technical bound on `extraTimePct`, section 2 row 1).
2. Accept the schema change of section 5 (one column and one enum).
3. Accept that `idPhotoUpload` is a recruiter-enabled allowance and not open to every candidate (the hub's recommendation, to keep the live capture as the default evidence).
