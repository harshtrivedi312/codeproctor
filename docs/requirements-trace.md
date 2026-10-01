# Requirements traceability matrix

Owner: project-manager. Last updated: 2026-09-30. Every status below is **Not started** (no application code exists; git has no commits).

Sources: /docs/brd.md (BO, BR), /docs/fsd.md (FR, NFR), /docs/test-cases.md (TC), /docs/build-plan.md (task IDs). IDs are copied exactly from the docs; none are invented.

Status values: Not started, In progress, Done (merged), Verified (the TC passed in an actual test run recorded by the PM; agent claims do not count).

## 1. Summary counts

| Item | Count | Source check |
| --- | --- | --- |
| Business objectives (BO-1..BO-6) | 6 | brd.md section 2 (not traced to tests; see section 6) |
| Business requirements (BR-01..BR-15) | 15 | brd.md section 6 |
| Functional requirements (FR-101..FR-1103) | 57 | fsd.md section 2 |
| Non-functional requirements (NFR-01..NFR-09) | 9 | fsd.md section 5 |
| Requirements traced (BR + FR + NFR) | 81 | |
| Test cases (TC) | 67 (48 P1, 16 P2, 3 P3) | counted from test-cases.md; matches its intro line |
| TC types | 27 F, 18 I, 17 S, 2 P, 2 R, 1 A | |
| FRs with no test case | 10 | FR-302, FR-406, FR-501, FR-702, FR-801, FR-1001, FR-1002, FR-1101, FR-1102, FR-1103 |
| NFRs with no direct test case | 4 | NFR-03, NFR-07, NFR-08, NFR-09 (NFR-07 and NFR-08 have indirect coverage, see section 4) |
| BRs with no test case through their FRs | 1 | BR-11 |
| Test cases with no requirement ID | 1 | TC-065 (FR column says "Security") |
| Requirements with no build task at all | 0 | FR-1101..FR-1103 and BR-11 map only to FE-14, which is out of scope for this build (D-13); NFR-03 has only ops tasks |
| Requirements only partially covered by the build tasks | 10 | listed in section 5 |
| TCs not named by any prompt step | 14 (7 are P1) | listed in section 4 |

## 2. Business requirements (BR)

The FSD section 1 maps modules to BRs. The FR column lists the primary FRs by content; the module-level mapping is broader (for example M3 covers BR-01, so FR-301..FR-305 all roll up to BR-01).

| BR | Pri | Requirement (short) | FSD module(s) | Primary FR(s) | Build tasks | TCs (via FRs) | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BR-01 | Must | Invite by email with unique expiring link | M3 | FR-301, FR-303, FR-304 (FR-106) | BE-06, BE-07, FE-05, FE-09 | TC-020, TC-021, TC-022, TC-023, TC-007 | Not started |
| BR-02 | Must | Identity check: photo ID plus live selfie | M4 | FR-403 | BE-08, BE-09, FE-09 | TC-033, TC-034 | Not started |
| BR-03 | Must | Record screen, webcam, audio for the full session | M6, M7 | FR-604, FR-701, FR-702 (FR-404) | FE-06, FE-07, BE-09, FE-09 | TC-054, TC-055, TC-070, TC-035 | Not started |
| BR-04 | Must | Detect tab switch, fullscreen exit, paste, faces, phone, voices | M6 | FR-601..FR-607, FR-610 | FE-06, FE-08, BE-10, BE-12 | TC-050..TC-061, TC-064 | Not started |
| BR-05 | Must | Execute and grade code against hidden tests | M2, M5 | FR-201, FR-202, FR-502, FR-503, FR-506 | BE-04, BE-05, BE-11, FE-04, FE-10 | TC-010, TC-011, TC-040, TC-042, TC-043, TC-044, TC-048 | Not started |
| BR-06 | Must | Integrity risk score with evidence timeline | M8 | FR-801, FR-804, FR-805 | BE-10, BE-12, BE-13 | TC-075, TC-076 | Not started |
| BR-07 | Must | Replay typing and linked video at each flag | M9 | FR-901, FR-608 | BE-10, BE-13, FE-10, FE-11 | TC-062, TC-077 | Not started |
| BR-08 | Must | Different question variants per candidate | M2 | FR-203 | BE-04, BE-05, BE-07 | TC-012 (weak, see note) | Not started |
| BR-09 | Should | Live proctor view, message or pause | M9 | FR-903 | BE-13, FE-12, FE-10 | TC-079 | Not started |
| BR-10 | Should | Plagiarism and AI-likeness checks | M8 | FR-803 | BE-12 | TC-074 (AI_LIKENESS has no TC) | Not started |
| BR-11 | Should (Phase 3) | Desktop lockdown client | M11 | FR-1101, FR-1102, FR-1103 | FE-14 (later phase) | none | Out of scope (D-13) |
| BR-12 | Must | Accommodations: extra time, disabled detectors, screen-reader support | M4 (FSD), content is FR-305 in M3 | FR-305 (NFR-06 for screen reader) | BE-06, BE-07, FE-05, FE-08, FE-13 | TC-024, TC-092 | Not started |
| BR-13 | Must | Recordings deleted after retention period | M7 | FR-704 | DB-06, BE-09, FE-03 | TC-072 (TC-094 for erasure under NFR-05) | Not started |
| BR-14 | Must | Complete audit log of staff actions on candidate data | M1 | FR-105 | DB-03, BE-03, BE-13 | TC-006 | Not started |
| BR-15 | Could | ATS integration via webhooks and CSV export | M10 | FR-1003 | BE-14, FE-13 | TC-081 (CSV and session.reviewed untested) | Not started |

Notes:
- BR-08: TC-012 checks the publish gate (reference solution must pass all variants). No TC asserts that two candidates receive different variants.
- BR-12: the FSD lists BR-12 under M4, but accommodations are FR-305 in M3, and "screen-reader support" has no FR. See Q-32.

## 3. Functional requirements (FR)

| FR | Mod | Requirement (short) | Build task(s) | TC(s) | Status | Note |
| --- | --- | --- | --- | --- | --- | --- |
| FR-101 | M1 | Staff login, Argon2id, lock 15 min after 5 failures | BE-02, FE-02 | TC-001, TC-002 | Not started | |
| FR-102 | M1 | TOTP mandatory for Super Admin and Reviewer | BE-02, FE-02 | TC-003 | Not started | Recovery-code storage missing in schema (Q-03) |
| FR-103 | M1 | RBAC on every route | ARC-02, BE-03, FE-03 | TC-004 | Not started | |
| FR-104 | M1 | Access 15 min, refresh 7 days, rotated, revocable | BE-02, FE-02 | TC-005 | Not started | No family_id column (Q-05) |
| FR-105 | M1 | Audit entry on every staff read or change of candidate data | DB-03, BE-03, BE-13, DB-06 | TC-006 | Not started | Partial: only routes marked @Audited are covered; results and candidate list endpoints undefined (Q-18) |
| FR-106 | M1 | Candidate auth by one-time token plus email OTP | BE-06, BE-07, FE-09 | TC-007 | Not started | OTP storage undefined (Q-04) |
| FR-201 | M2 | Author creates coding questions | BE-04, FE-04 | TC-010 | Not started | |
| FR-202 | M2 | Sample and hidden test cases with weights | BE-04, FE-04 | TC-011 | Not started | No candidate fetch endpoint in FSD (Q-18) |
| FR-203 | M2 | Variant params; reference solution must pass all variants | BE-04, BE-05, FE-04 | TC-012 | Not started | |
| FR-204 | M2 | Versioning; past attempts unchanged | BE-04, FE-04 | TC-013 | Not started | |
| FR-205 | M2 | MCQ and short-answer secondary types | BE-04, BE-11, FE-04, FE-10 | TC-014 | Not started | Partial: answer and scoring flow undefined (Q-14) |
| FR-301 | M3 | Test from fixed or random picks, durations | BE-06, BE-07, FE-05 | TC-020 | Not started | |
| FR-302 | M3 | Proctoring profile STANDARD, STRICT, LOCKDOWN | BE-06, FE-05, FE-09 | none | Not started | No TC (Q-29); LOCKDOWN enforcement is FR-1103 |
| FR-303 | M3 | Email invite, unique link, start window, usable once | BE-06, BE-07, FE-09 | TC-021, TC-022 | Not started | "Usable once" versus resume (Q-23); expiry job missing (Q-01) |
| FR-304 | M3 | Bulk CSV invites; reminder 24 h before close | BE-06, FE-05 | TC-023 | Not started | |
| FR-305 | M3 | Per-candidate accommodations | BE-06, BE-07, FE-05, FE-08, BE-12 | TC-024 | Not started | |
| FR-401 | M4 | Landing page, rules, consent, no recording before consent | BE-07, FE-09 | TC-030 | Not started | Consent version source (Q-16) |
| FR-402 | M4 | System check | FE-09 | TC-031, TC-032 | Not started | |
| FR-403 | M4 | ID photo, selfie with liveness, face match score | BE-08, FE-08, FE-09 | TC-033, TC-034 | Not started | Partial: manual approval workflow and UI undefined (Q-12); model licence (Q-27) |
| FR-404 | M4 | Room scan clip | BE-09, FE-09 | TC-035 | Not started | No room-scan endpoint in FSD (Q-18) |
| FR-405 | M4 | STRICT: phone side camera via QR | FE-09, BE-09 | TC-036 | Not started | Partial: phone pairing has no backend step (Q-18, Q-42); SIDE_CAMERA event type missing (Q-08) |
| FR-406 | M4 | Practice question | FE-09 | none | Not started | Partial: no data model or API (Q-13); no TC (Q-29) |
| FR-501 | M5 | Monaco editor, keyword-only autocomplete | FE-10 | none | Not started | No TC (Q-29) |
| FR-502 | M5 | Run samples, Submit hidden, 1 run per 5 s | BE-11, FE-10 | TC-040, TC-041 | Not started | |
| FR-503 | M5 | Judge0 limits, no network | BE-05 | TC-042, TC-043, TC-044 | Not started | Local Judge0 on macOS risk (R-01) |
| FR-504 | M5 | Autosave every 10 s and on run | BE-11, FE-10 | TC-045 | Not started | |
| FR-505 | M5 | Server timer is source of truth; auto-submit at zero | BE-07, BE-11, FE-10 | TC-046, TC-047 | Not started | Paused-time policy (Q-24) |
| FR-506 | M5 | Score = sum of passed hidden weights | BE-11 | TC-048 | Not started | |
| FR-601 | M6 | Fullscreen required; FULLSCREEN_EXIT | FE-06, BE-10, FE-10 | TC-050 | Not started | Resume event type missing (Q-08) |
| FR-602 | M6 | TAB_SWITCH and FOCUS_LOST with duration | FE-06 | TC-051 | Not started | |
| FR-603 | M6 | Block paste, drop, right-click, devtools keys; log | FE-06, FE-10 | TC-052, TC-053 | Not started | No drop event type (Q-08) |
| FR-604 | M6 | Entire-screen share; stop pauses test | FE-06, BE-10 | TC-054, TC-055 | Not started | |
| FR-605 | M6 | Multi-monitor detected; blocks start | FE-06, FE-09 | TC-056 | Not started | |
| FR-606 | M6 | In-browser webcam analysis every 1 s | FE-08, BE-08 | TC-057, TC-058, TC-059, TC-060 | Not started | Client-side detectors can be tampered (R-04) |
| FR-607 | M6 | Mic levels and voice activity | FE-08, BE-12 | TC-061 | Not started | |
| FR-608 | M6 | Keystroke and editor change recording | FE-10, BE-10, FE-11 | TC-062 | Not started | SDK ownership of keystroke signing unclear (Q-26) |
| FR-609 | M6 | Heartbeat 10 s; DISCONNECTED after 60 s | FE-06, BE-07 | TC-063 | Not started | |
| FR-610 | M6 | DevTools, virtual camera, extension checks | FE-06 | TC-064 | Not started | No extension event type (Q-08) |
| FR-701 | M7 | 10 s MediaRecorder chunks to R2 via presigned URLs | FE-07, BE-09 | TC-070 | Not started | |
| FR-702 | M7 | Retry with backoff, IndexedDB buffer up to 200 MB | FE-07 | none | Not started | No TC (Q-29); behavior exercised by TC-063 |
| FR-703 | M7 | Encrypted at rest; 15 min signed playback URLs | BE-09, DEP-01 | TC-071 | Not started | At-rest encryption relies on provider defaults; confirm in DEP-01 |
| FR-704 | M7 | Scheduled deletion after retention period | DB-06, BE-09, BE-08 | TC-072 | Not started | Scope and anchor unclear (Q-11) |
| FR-801 | M8 | Events have type, severity, timestamp, duration, evidence ref | ARC-02, BE-10 | none | Not started | No TC (Q-29); default severities undefined (Q-09) |
| FR-802 | M8 | Keystroke analytics | BE-12 | TC-073 | Not started | |
| FR-803 | M8 | Code similarity and AI-reference similarity | BE-12 | TC-074 | Not started | Source decided (D-12): authors collect solutions from 2-3 AI assistants at publish time; similarity only, never grading. Storage in ARC-01 ADR 0005 |
| FR-804 | M8 | Risk score 0-100, bands, configurable weights | BE-12, FE-03 | TC-075 | Not started | Partial: defaults not in FSD (Q-09); no org-settings API (Q-16) |
| FR-805 | M8 | MEDIUM or HIGH goes to review queue | BE-12, BE-13 | TC-076 | Not started | |
| FR-901 | M9 | Review page, synced video, replay, diffs | BE-13, FE-11 | TC-077 | Not started | |
| FR-902 | M9 | Flag decisions and verdict | BE-13, FE-11 | TC-078 | Not started | |
| FR-903 | M9 | Live grid; message or pause | BE-13, FE-12, FE-10 | TC-079 | Not started | Candidate channel undefined (Q-20) |
| FR-904 | M9 | Appeal within 7 days; different reviewer | BE-13 | TC-080 | Not started | Partial: no candidate appeal page, no reviewer appeal UI, no verdict email (Q-35) |
| FR-1001 | M10 | Candidate report PDF | BE-14, FE-13 | none | Not started | No TC (Q-29) |
| FR-1002 | M10 | Dashboard metrics | BE-14, FE-13 | none | Not started | No TC (Q-29) |
| FR-1003 | M10 | Webhooks and CSV export | BE-14, FE-13 | TC-081 | Not started | Partial: session.reviewed, CSV and webhook admin UI untested or missing (Q-35) |
| FR-1101 | M11 | Electron kiosk, block OS shortcuts | FE-14 (later phase) | none | Out of scope (D-13) | Not in this build |
| FR-1102 | M11 | Block known remote-desktop, VM, AI processes | FE-14 (later phase) | none | Out of scope (D-13) | Not in this build |
| FR-1103 | M11 | Server refuses LOCKDOWN from unsigned client | FE-14 (later phase) | none | Out of scope (D-13) | Not in this build. Partial: server challenge and verification have no backend step (Q-35) |

## 4. Non-functional requirements (NFR)

| NFR | Area | Requirement (short) | Build task(s) | TC(s) | Status | Note |
| --- | --- | --- | --- | --- | --- | --- |
| NFR-01 | Performance | API p95 under 300 ms; code run p95 under 5 s | BE-01, BE-05, BE-15A, BE-15B | TC-091 | Not started | Load estimate risk (R-02) |
| NFR-02 | Capacity | 200 concurrent candidates | BE-15A, BE-15B | TC-090 | Not started | R-02 |
| NFR-03 | Availability | 99.5% during test windows | DEP-01 (uptime checks), DEP-02 (review) | none | Not started | No implementing task; monitoring only (Q-31) |
| NFR-04 | Security | ASVS L2, TLS 1.2+, vault, rate limits | BE-01, BE-03, BE-15A, FE-01, DEP-01, QA-01B | TC-008, TC-093 | Not started | |
| NFR-05 | Privacy | Minimization, encryption, retention, deletion on request in 30 days | DB-06, BE-09, BE-15A | TC-094 | Not started | Partial: no API or UI entry point for admin erasure (Q-18) |
| NFR-06 | Accessibility | WCAG 2.1 AA on candidate and staff screens | FE-01, FE-09, FE-13, QA-01B | TC-092 | Not started | |
| NFR-07 | Browser support | Chrome and Edge; Firefox and Safari blocked | FE-09 | none direct | Not started | Indirect: TC-031 (FR-402). STRICT phone conflict (Q-42) |
| NFR-08 | Resilience | 60 s network drop loses no code or chunks | FE-07, BE-11, FE-10 | none direct | Not started | Indirect: TC-063 (FR-609), TC-045 (FR-504) |
| NFR-09 | Observability | Structured logs, error tracking, uptime alerts, per-session trace ID | BE-01, DEP-01 | none | Not started | Partial: BE-01 has per-request trace ID, not per-session (Q-35) |

## 5. Test cases (TC)

Requirement column is copied from test-cases.md. "Named" = the prompts name this TC in a step. "No" means the PM assigned an owner task (Q-33).

| TC | Requirement | Type | Pri | Verifying task(s) | Named | Status |
| --- | --- | --- | --- | --- | --- | --- |
| TC-001 | FR-101 | F | P1 | BE-02, FE-02 | Yes | Not started |
| TC-002 | FR-101 | S | P1 | BE-02, FE-02 | Yes | Not started |
| TC-003 | FR-102 | S | P1 | BE-02, FE-02 | Yes | Not started |
| TC-004 | FR-103 | S | P1 | BE-03 | Yes | Not started |
| TC-005 | FR-104 | S | P1 | BE-02 | Yes | Not started |
| TC-006 | FR-105 | F | P1 | BE-03, BE-13 | Yes | Not started |
| TC-007 | FR-106 | S | P2 | BE-07 | No | Not started |
| TC-008 | NFR-04 | S | P1 | DB-05, BE-03, BE-13 | Yes | Not started |
| TC-010 | FR-201 | F | P1 | BE-04 | Yes | Not started |
| TC-011 | FR-202 | S | P1 | BE-04 | Yes | Not started |
| TC-012 | FR-203 | F | P1 | BE-05, FE-04 | Yes | Not started |
| TC-013 | FR-204 | F | P1 | BE-04 | Yes | Not started |
| TC-014 | FR-205 | F | P3 | BE-04, BE-11 | Yes | Not started |
| TC-020 | FR-301 | F | P1 | BE-06, BE-07 | Yes | Not started |
| TC-021 | FR-303 | S | P1 | BE-07 | Yes | Not started |
| TC-022 | FR-303 | F | P1 | BE-06, BE-07 | Yes | Not started |
| TC-023 | FR-304 | F | P2 | BE-06, FE-05 | Yes | Not started |
| TC-024 | FR-305 | F | P1 | BE-06, BE-07 | Yes | Not started |
| TC-030 | FR-401 | S | P1 | BE-07, FE-09 | Yes | Not started |
| TC-031 | FR-402 | F | P1 | FE-09 | Yes | Not started |
| TC-032 | FR-402 | F | P1 | FE-09 | No | Not started |
| TC-033 | FR-403 | I | P1 | BE-08, FE-09 | Yes | Not started |
| TC-034 | FR-403 | I | P2 | FE-09, BE-08 | No | Not started |
| TC-035 | FR-404 | F | P2 | FE-09 | No | Not started |
| TC-036 | FR-405 | I | P2 | FE-09, BE-10 (manual via QA-01A) | No | Not started |
| TC-040 | FR-502 | F | P1 | BE-11, FE-10 | Yes | Not started |
| TC-041 | FR-502 | F | P2 | BE-11, FE-10 | Yes | Not started |
| TC-042 | FR-503 | S | P1 | BE-05 | Yes | Not started |
| TC-043 | FR-503 | S | P1 | BE-05 | Yes | Not started |
| TC-044 | FR-503 | S | P1 | BE-05 | Yes | Not started |
| TC-045 | FR-504 | R | P1 | BE-11, FE-10 | Yes | Not started |
| TC-046 | FR-505 | F | P1 | BE-11, FE-10 | Yes | Not started |
| TC-047 | FR-505 | S | P1 | BE-07 | Yes | Not started |
| TC-048 | FR-506 | F | P1 | BE-11 | Yes | Not started |
| TC-050 | FR-601 | I | P1 | BE-10, FE-06, FE-10 | Yes | Not started |
| TC-051 | FR-602 | I | P1 | FE-06, FE-10 | Yes | Not started |
| TC-052 | FR-603 | I | P1 | FE-06, FE-10 | Yes | Not started |
| TC-053 | FR-603 | I | P2 | FE-06, FE-10 | No | Not started |
| TC-054 | FR-604 | I | P1 | FE-06 | No | Not started |
| TC-055 | FR-604 | I | P1 | BE-10, FE-06, FE-10 | Yes | Not started |
| TC-056 | FR-605 | I | P1 | FE-06, FE-09 | No | Not started |
| TC-057 | FR-606 | I | P1 | FE-08 (manual) | No | Not started |
| TC-058 | FR-606 | I | P1 | FE-08 (manual) | No | Not started |
| TC-059 | FR-606 | I | P1 | FE-08 (manual) | No | Not started |
| TC-060 | FR-606 | I | P2 | FE-08 (manual) | No | Not started |
| TC-061 | FR-607 | I | P2 | BE-12, FE-08 | Yes | Not started |
| TC-062 | FR-608 | F | P1 | FE-11, FE-10, BE-10 | Yes | Not started |
| TC-063 | FR-609 | R | P1 | FE-07 (manual), FE-10 | Yes | Not started |
| TC-064 | FR-610 | I | P2 | FE-06 | No | Not started |
| TC-065 | Security (no ID) | S | P1 | BE-10, FE-06 | Yes | Not started |
| TC-070 | FR-701 | F | P1 | BE-09, FE-07 | Yes | Not started |
| TC-071 | FR-703 | S | P1 | BE-09 | Yes | Not started |
| TC-072 | FR-704 | F | P1 | DB-06, BE-09 | Yes | Not started |
| TC-073 | FR-802 | I | P1 | BE-12 | Yes | Not started |
| TC-074 | FR-803 | I | P2 | BE-12 | Yes | Not started |
| TC-075 | FR-804 | F | P1 | BE-12 | Yes | Not started |
| TC-076 | FR-805 | F | P1 | BE-12, BE-13 | Yes | Not started |
| TC-077 | FR-901 | F | P2 | FE-11, BE-13 | Yes | Not started |
| TC-078 | FR-902 | F | P2 | BE-13, FE-11 | Yes | Not started |
| TC-079 | FR-903 | F | P2 | BE-13, FE-12 | Yes | Not started |
| TC-080 | FR-904 | F | P3 | BE-13 | Yes | Not started |
| TC-081 | FR-1003 | F | P3 | BE-14 | Yes | Not started |
| TC-090 | NFR-02 | P | P1 | BE-15B (scripts BE-15A) | Yes | Not started |
| TC-091 | NFR-01 | P | P2 | BE-15B | Yes | Not started |
| TC-092 | NFR-06 | A | P1 | FE-13 | Yes | Not started |
| TC-093 | NFR-04 | S | P1 | QA-01B | No | Not started |
| TC-094 | NFR-05 | S | P2 | DB-06 | Yes | Not started |

TCs not named by any prompt step (14, of which P1: TC-032, TC-054, TC-056, TC-057, TC-058, TC-059, TC-093): TC-007, TC-032, TC-034, TC-035, TC-036, TC-053, TC-054, TC-056, TC-057, TC-058, TC-059, TC-060, TC-064, TC-093.

## 6. Gap lists

### 6.1 Requirements with no test case

- FR (10): FR-302, FR-406, FR-501, FR-702, FR-801, FR-1001, FR-1002, FR-1101, FR-1102, FR-1103.
- NFR (4, no direct TC): NFR-03, NFR-07, NFR-08, NFR-09. NFR-07 is indirectly exercised by TC-031; NFR-08 by TC-063 and TC-045.
- BR (1, derived): BR-11 (all its FRs have no TC).
- Weak coverage even though a TC exists: BR-08 (no TC for variant assignment), BR-10 (AI_LIKENESS untested), FR-1003 (CSV and session.reviewed untested), FR-303 (TC-021 conflicts with TC-045 on link reuse, Q-23).

### 6.2 Test cases with no requirement

- TC-065 "Forged events": the requirement column holds the word "Security", not an ID. The behavior (HMAC signing) appears only in architecture.md Security architecture and backend.md Step 10. Needs a human decision on which requirement it belongs to (Q-30). Not reassigned here.

### 6.3 Requirements not covered by any build task

- No requirement is without a task if FE-14 (deferred, Phase 3) and DEP tasks count.
- Out of scope for this build: FR-1101, FR-1102, FR-1103, BR-11 (FE-14, later phase, D-13).
- Only ops or verification tasks, no implementing task: NFR-03 (DEP-01 uptime checks, DEP-02 review).
- Partially covered (something the requirement asks for has no task): FR-205 (answer and scoring flow), FR-403 (manual approval workflow), FR-405 (phone pairing backend), FR-406 (practice question data and API), FR-804 (org settings API), FR-904 (appeal page, reviewer UI, verdict email), FR-1003 (webhook admin UI, session.reviewed test), FR-1103 (server attestation), NFR-05 (erasure entry point), NFR-09 (per-session trace ID). Also BRD section 7 "flag rates are monitored across groups" has no FR, TC or task (Q-34).

### 6.4 FRs with no parent BR (FSD section 1 mapping)

FR-101, FR-102, FR-103, FR-104, FR-106 (M1 lists only BR-14, delivered by FR-105), FR-1001 and FR-1002 (M10 lists only BR-15), FR-904 (BRD mentions appeals only in section 9), FR-302, FR-406. They trace to BRD sections 5 (scope) and 7 (compliance) in prose, not to a BR ID (Q-32).

## 7. Business objectives (derived, not tested)

| BO | Objective | Related BR / requirements | Note |
| --- | --- | --- | --- |
| BO-1 | Trustworthy screening results | BR-05, BR-06, BR-04 | Measured in pilot; no build task or TC |
| BO-2 | Detect integrity violations | BR-04, BR-06, FR-805 | Flag routing covered by TC-076 |
| BO-3 | Reduce interviewer load | BR-09 (indirect) | Post-launch metric |
| BO-4 | Fair candidate experience | BR-12, NFR-06, FR-406 | Satisfaction survey not in any task |
| BO-5 | Low running cost | DEP-01, DEP-02 | R-03 storage estimate |
| BO-6 | Legal compliance | BR-13, BR-14, FR-401, NFR-05 | Legal approval is a human gate (Q-43) |

## 8. Update rules

The PM updates this file only from merged branches and real test runs (CI output or a run by the PM). A requirement becomes Done when all its build tasks are merged, and Verified when all its TCs pass in a recorded run. Requirements with no TC stay at Done at most and are listed in 6.1 until a human decides on a TC.
