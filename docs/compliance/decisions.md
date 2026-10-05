# Compliance decisions

Owner and approver: Harsh Trivedi (product owner). Decided: 2026-10-05. Recorded by the Delivery Lead.

These decisions settle the open Legal items from the pilot Legal brief (status.md B-05; the brief's decision record is in [legal-brief.md](legal-brief.md)). Nobody outside the owner has given legal advice on them. C-15 records that, and recommends a professional legal review before production.

Where a decision changes an accepted ADR, the BRD or the FSD, the "Applied to" column names the document and the session that changes it. The architecture hub owns ADRs and the source-of-truth docs, and the owner accepts each ADR amendment PR. Until a change lands, this file is the record of the decision.

## Decisions

### Scope and jurisdiction

| ID | Decision | What changes | Applied to (owner of the change) |
| --- | --- | --- | --- |
| C-01 | From the start, the pilot is open to candidates in the US, the EU/UK and worldwide. GDPR, UK GDPR, BIPA and CCPA apply. | brd.md section 7 names these four laws as applying, not as "may apply". The DPIA (C-03) covers all four, plus a first-pass check of other laws (C-14). | brd.md §7 (hub); [dpia.md](dpia.md) (Delivery Lead drafts, owner approves) |
| C-02 | Face matching is required for every candidate. The lawful basis for biometric processing is explicit consent, given by signing the consent document. If a candidate refuses, or cannot use the webcam, microphone or ID check, the recruiter handles it case by case through the per-invitation accommodation settings (for example, disabled detectors or no face match). The decline screen shows the recruiter's contact. Recruiter actions on accommodations are audited. | FR-305 adds "no face match / no identity check" as an accommodation. Recruiter changes to accommodations write an audit row. The decline screen shows the recruiter contact (FR-401). | fsd.md FR-305, FR-401 (hub); BE-06 invitations and accommodations audit (backend); FE-05 accommodation UI, FE-09 decline screen (frontend); BE-08 skips the face match when the accommodation says so (integrity) |
| C-03 | All data, EU/UK candidates' data included, is stored in one US AWS region. Before the first EU/UK candidate: (a) a DPIA is completed and approved by the owner; (b) a transfer mechanism is in place: provider DPAs with Standard Contractual Clauses (AWS, Cloudflare, the email provider, Sentry and every other processor), or Data Privacy Framework certification. Both are pilot entry blockers **for EU/UK candidates**. | ARC-05 and DEP-03 pin one US AWS region for pilot and production. A processor register lists each processor and its DPA, SCC or DPF status. | [dpia.md](dpia.md) and [processors.md](processors.md) (Delivery Lead drafts, owner approves; owner signs the DPAs); ARC-05 region (hub); DEP-03 (backend) |

### Retention

| ID | Decision | What changes | Applied to (owner of the change) |
| --- | --- | --- | --- |
| C-04 | Recordings, ID images, selfies, identity re-check frames and keystroke data are deleted 90 days after the test (configurable). **Corrected 2026-10-05 by C-18:** face embeddings are never stored. Signed consent records (document version, signed name, timestamp, IP, user agent, signed PDF) are kept 3 years to prove consent, then deleted. | ADR 0004 R-4 already deletes media, ID images, selfies, evidence and keystroke batches at `retention_days` (default 90). New: consent records get their own 3-year clock and are deleted at its end (ADR 0004 R-5 keeps them indefinitely today). Face embeddings are never stored (ADR 0004 §2, option (a); confirmed by C-18). Re-check frames kept on mismatch are evidence objects, deleted under R-4. | ADR 0004 §5 amendment (hub; owner accepts); DB-06 consent-record clock (database); see open question OQ-1 |
| C-05 | A written retention and destruction schedule is published (BIPA) and linked from the consent document and the candidate portal. Biometric data is never sold or shared for profit. | New public document. The candidate pages link to it. | [retention-schedule.md](retention-schedule.md) (Delivery Lead drafts, owner approves); FE-09 candidate portal link (frontend) |
| C-06 | Erasure hold approved as proposed: "Erasure completes within 30 days of the request, or within 30 days after an open review or appeal closes, whichever is later." The candidate is told about any delay. Code is erased too; only anonymised scores remain. | Confirms D-19 and D-27, so they are no longer provisional. NFR-05 takes the approved wording. | fsd.md NFR-05 (hub); ADR 0004 R-6 status (hub) |

### Consent

| ID | Decision | What changes | Applied to (owner of the change) |
| --- | --- | --- | --- |
| C-07 | E-signature approved as proposed: the candidate scrolls to the end and types their full legal name. Stored: document version, name, server timestamp, IP and user agent. A signed PDF is generated and kept, and the candidate is emailed a copy. | Confirms D-17's signature format. | FR-401 status (hub) |
| C-08 | Identity re-check approved as proposed: one 640 px frame every 2 minutes, compared with the verified face, and kept only on a mismatch. A mismatch always goes to human review and never rejects automatically. | Answers ADR 0013 owner question (4). | ADR 0013 (hub, in PR #39) |
| C-09 | The Delivery Lead drafts the full consent document (2–3 pages, plain language) for owner approval. It covers everything in brief item 1, plus: identity re-check frames, explicit consent for biometric processing, US storage and the transfer of EU/UK data, the retention schedule, the optional demographics question (C-13), that automated detection only flags and a human makes every decision, and how to ask for an accommodation or an alternative. The placeholder guard stays: pilot and production refuse to run until the owner approves the final version. | Draft text; the guard is unchanged. | [consent-document.md](consent-document.md) (Delivery Lead drafts, owner approves); FE-09 loads the approved version |

### Models

| ID | Decision | What changes | Applied to (owner of the change) |
| --- | --- | --- | --- |
| C-10 | AuraFace (training data not disclosed) and COCO-SSD (no stated licence on the weights) are accepted risks, owned by the owner. Object detection stays on in the pilot. Both go into the risk register, and their automatic deployment block is lifted. | Licence flags F-2 and F-3 close as accepted risks (status.md R-16). The ADR 0013 model licence gate lets exactly these two pinned files (by SHA-256) through, citing C-10. Every other model file without a verified licence is still blocked. | ADR 0001 §12 and ADR 0013 licence gate (hub); deploy config (backend, DEP-01/DEP-03) |

### Face-match tuning

| ID | Decision | What changes | Applied to (owner of the change) |
| --- | --- | --- | --- |
| C-11 | The tuning set is built from internal volunteers who sign a separate short consent (purpose-limited; optional self-reported demographics stored separately and deleted after tuning). The Delivery Lead drafts the volunteer consent form for owner approval. This is the first item to finish, because recruiting takes time. | Confirms D-18. | [volunteer-consent-form.md](volunteer-consent-form.md) (Delivery Lead drafts, owner approves); INT-01 (integrity) |
| C-12 | The per-group breakdown of tuning results is allowed, on the basis of the volunteers' explicit consent. | INT-01 may report false-match and false-non-match rates by group. | INT-01 report (integrity); ADR 0004 §3 note (hub) |

### Fairness monitoring

| ID | Decision | What changes | Applied to (owner of the change) |
| --- | --- | --- | --- |
| C-13 | Candidates may optionally self-report demographic information. It is asked after the test, with a separate explicit consent and a "prefer not to say" option. It is stored separately from the session, never visible to reviewers or recruiters, never used in scoring or decisions, and reported only in aggregate with a minimum group size of 10. It is deleted with the session data. It must be in place before the pilot exit review, not before pilot start. | New feature (closes Q-34). It needs a new FR and TCs, an ADR for separate storage and access (a schema change under ADR 0008), an API, a post-test form, and an aggregate report. New build task FAIR-01. | fsd.md new FR and brd.md §7 (hub); ADR for storage (hub, owner accepts); FAIR-01 (database, backend, frontend; see build-plan.md) |

### Automated decision laws

| ID | Decision | What changes | Applied to (owner of the change) |
| --- | --- | --- | --- |
| C-14 | Automated detection only produces flags; a human makes every decision, and nothing anywhere rejects automatically. This is disclosed in the consent document and should be mentioned in job postings. The DPIA assesses whether NYC Local Law 144 or the EU AI Act high-risk rules apply, and what they would require. | Confirms brd.md §7 and FR-805. Job-posting wording is for the recruiting team. | [dpia.md](dpia.md) section 8 (Delivery Lead drafts); consent document (C-09); job postings (owner and recruiting, outside the build) |

### Ownership

| ID | Decision | What changes | Applied to (owner of the change) |
| --- | --- | --- | --- |
| C-15 | The named approver for the consent text, retention wording, DPIA and volunteer form is Harsh Trivedi. No external Legal review is a blocker. The risk register notes that the consent text, DPIA and retention schedule have not had professional legal review, and recommends one before production. | Closes Q-43 (and D-29's placeholder). brd.md §7's "Legal must approve" becomes "the product owner approves". New risk R-17. | brd.md §7, fsd.md FR-401 (hub); status.md risks (Delivery Lead) |
| C-16 | The Legal brief becomes a decision record showing each item, its decision, and what remains. | New file. | [legal-brief.md](legal-brief.md) (Delivery Lead) |

### Follow-up decisions (2026-10-05, answers to OQ-1 to OQ-3)

| ID | Decision | What changes | Applied to (owner of the change) |
| --- | --- | --- | --- |
| C-17 | OQ-1: after an erasure request, the minimal consent proof is kept until its 3-year limit, to defend legal claims. The proof is the signed consent record only: version, name, timestamp, IP, user agent and signed PDF. The consent document and the retention schedule say so. | ADR 0004 R-6 today blanks the consent record and deletes the PDF on erasure. That becomes: keep the consent record and PDF until 3 years after signing, then delete them; erase everything else at once. | ADR 0004 R-6 (hub; owner accepts); DB-06 (database); consent document and retention schedule (done in this PR) |
| C-18 | OQ-2: ADR 0004 is confirmed. Face embeddings are never stored. They are computed in memory for each comparison and discarded, and periodic re-checks recompute from the stored selfie. C-04 is corrected to match. | None to the design; C-04's wording is corrected. | This file; BE-08 and the worker (integrity) keep the current design |
| C-19 | OQ-3: when face matching is waived, the recruiter must record a reason, and reviewers see "identity check waived". The recruiter is advised to check the candidate's ID on a video call before any hiring decision, and records whether that was done. All of it is audited. | The invitation's accommodation carries the waiver reason. The identity check records a waived state. A "video ID check done: yes/no" field is recorded by the recruiter. All three write audit rows. Schema and shared-contract change (ADR 0008, ADR 0010). | ADR (hub; owner accepts); BE-06, BE-08 and BE-13 (backend, integrity); FE-05 and FE-11 (frontend); QA TCs |
| C-20 | Employee volunteers for the tuning set are recruited through an open call, never through managers. The call makes clear that not volunteering has no consequences. | The recruitment rule for INT-01. | volunteer-consent-form.md drafting note 1 (done); INT-01 (owner and integrity) |

## Open questions raised by these decisions

| ID | Question | Why it matters | Suggested answer |
| --- | --- | --- | --- |
| OQ-1 | **Answered by C-17.** When a candidate asks for erasure, is the signed consent record deleted at once (as ADR 0004 R-6 does today), or kept until its 3-year limit (C-04) as proof of consent? | C-04 keeps the record 3 years to prove consent, while R-6 erasure deletes the PDF and anonymises the record. GDPR Art. 17(3)(e) allows keeping data needed to establish or defend legal claims. | Keep a minimal proof record (document version, signed timestamp, signature hash, and the PDF in restricted storage) until the 3-year limit, then delete it; erase everything else at once. Tell the candidate in the erasure confirmation. |
| OQ-2 | **Answered by C-18.** C-04 lists face embeddings with a 90-day limit, but ADR 0004 §2 says embeddings are never stored. Confirm that "never stored" stands. | Storing embeddings would need a schema change and new BIPA handling. | Keep "never stored" (stricter). The 90 days is only an outer limit. |
| OQ-3 | **Answered by C-19.** Under C-02, what replaces identity verification for a candidate given a "no face match" accommodation? | The recruiter needs a defined fallback, and the reviewer needs to see that the check was waived. | The recruiter records the reason. The review screen shows "identity check waived by accommodation". Optionally, a live ID check on a video call, outside the product. |
| OQ-4 | How long are results kept (scores, submitted code and answers, integrity events without images, reviewer decisions and notes)? ADR 0004 R-5 sets no limit today. | GDPR storage limitation needs a limit; the retention schedule and consent document need a number. | [2] years after the assessment is finished, then anonymise to scores only. |
| OQ-5 | Should biometric items (ID image, selfie, re-check frames, evidence frames showing the face) be capped at 90 days, whatever an organisation's `retention_days` (7..730) says? | BIPA requires destruction once the purpose is met. A 730-day organisation setting would keep biometric data far longer than C-04's 90 days. | Yes: cap biometric items at 90 days; `retention_days` may shorten that but never extend it. |
| OQ-6 | Lawful basis for the non-biometric recording, monitoring and scoring: consent (current design), or legitimate interests or pre-contract steps, with explicit consent kept only for biometrics? (DPIA section 3) | It changes what happens when a candidate withdraws, and how strong the "freely given" argument is (R-18). | Legitimate interests for proctoring and scoring; explicit consent for biometrics. |
| OQ-7 | Can candidates under 18 apply? (DPIA R11) | Minors need a parental-consent path, or an age gate. | If not, add an 18+ confirmation to the invitation flow. |
