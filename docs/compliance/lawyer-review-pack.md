# Lawyer review pack (C-15, as amended by C-67)

Status: **DRAFT for the owner**, prepared 2026-10-09 by the compliance reviewer. The owner (Harsh Trivedi) decided on 2026-10-09 that a professional legal review is required before production, and recommended before the first EU/UK or Illinois candidate (C-67). This pack is what the owner hands to the lawyer or firm. It contains no real candidate data and no credentials. Nothing in the pack is legal advice from a licensed lawyer.

## 1. What we are asking for

1. A written opinion on each question in section 5, ranked by the priority in section 6.
2. Markup of the four candidate-facing and public documents (consent, retention schedule, privacy notice, volunteer form) and the DPIA, using the replacement wording where we have it.
3. A yes/no on each primary-text check in section 4.
4. A view on whether we need any registration, representative, audit or notice we have not identified (section 7).

A suitable reviewer: a privacy and employment lawyer with (a) Illinois BIPA litigation or advisory experience, (b) GDPR/UK GDPR experience with employment and biometric data, and (c) California and New York AI-in-hiring experience. One firm can cover all three, or the work can be split between a US firm and an EU/UK firm.

## 2. The product in five lines

- A proctored coding test for **Rysun Labs Inc.'s own hiring** (C-69). Candidates start in the **US only**; EU/UK admitted later after representatives are appointed (C-67).
- During the test the system records the screen, webcam, microphone and keystroke timing, and takes a room scan. Before the test it verifies identity with an ID photo and a selfie (face match). During the test it compares one small webcam frame about every 2 minutes with the verified face, and browser software measures face and eye position for gaze, face-count and presence flags.
- Software only raises flags. **A person reviews every session; nothing is rejected automatically; a person makes every hiring decision** (C-28). Candidates can appeal to a different reviewer within 7 days.
- Face measurements are never stored. Everything that shows a face or body is deleted within 90 days of capture. Results are kept 1 year (4 years for California roles). Signed consent records are kept 3 years, also after an erasure request.
- Hosted on AWS (us-east-1), email through SES, logs in CloudWatch, static pages on Cloudflare. No other processor receives candidate data.

## 3. Documents to review

| Document | Path (on `main` unless a PR is named) | State |
| --- | --- | --- |
| Consent document v0.5 | `docs/compliance/consent-document.md` (draft PR #353) | Final-for-approval text; not loadable until the system matches it |
| Retention and destruction schedule v0.6 | `docs/compliance/retention-schedule.md` (draft PR #354) | Final-for-approval text; not publishable until the system matches it |
| Privacy notice v0.1 | `docs/compliance/privacy-notice.md` (draft PR #355) | Final-for-approval text |
| DPIA v0.4 | `docs/compliance/dpia.md` (draft PR #370) | Final-for-approval text |
| Processor register | `docs/compliance/processors.md` | Needs a SCC-primary update after C-42; DPAs unsigned |
| Volunteer consent form (face-match tuning, internal volunteers) | `docs/compliance/volunteer-consent-form.md` | Draft v0.1; review items M2 in the 2026-10-06 review |
| Decisions record | `docs/compliance/decisions.md` | C-01 to C-69 |
| Earlier reviews, with sources | `docs/compliance/review-2026-10-06.md`, `review-2026-10-08-optional-2fa-and-demo-consent.md`, `owner-decision-sheet.md` | Reasoning behind each draft |

Supporting technical facts (read-only; the lawyer need not read code): `docs/adr/0004-identity-biometrics-and-retention-scope.md` (retention and erasure), `0015-identity-check-waiver.md` (the alternative to the face match), `0013-proctor-transport-keys-wire-contracts-models.md` (what the in-test detectors do), `0017` (hosting and backups), and `docs/fsd.md` FR-401, FR-606, FR-805.

## 4. Primary-text checks (claims we found by web search and have not read at source)

Each of these appears in the documents as a claim for counsel to confirm.

| Claim | Where it is used | What to check |
| --- | --- | --- |
| EU AI Act Annex III high-risk obligations now apply from 2 December 2027, by Regulation (EU) 2026/1744, in force 27 July 2026 | DPIA section 7; entry conditions | The Official Journal text and the application dates; whether Art. 4 AI literacy and Art. 5 are unchanged |
| Colorado SB 26-189 replaced SB 24-205, effective 1 January 2027 | DPIA section 7 | The enacted text; whether it reaches a hiring assessment with human review |
| UK Arts 22A to 22D in force since 5 February 2026 (SI 2026/82) | DPIA section 7 | The instrument and the "meaningful human involvement" test |
| BIPA SB 2979 (single violation per person per method; e-signature counts) applies retroactively per a 7th Circuit decision of April 2026 | Consent release; risk R16 | The statute text and the decision; whether Illinois state courts agree |
| California Civil Rights Council ADS regulations (4-year records) apply to our proctoring data | Retention schedule, C-68 | The regulation (2 CCR) and whether flags and risk scores are "ADS data" |
| CCPA ADMT regulations: duties for hiring from 1 January 2027; risk assessment for biometric identity verification | DPIA, privacy notice | The regulation text and whether a human reviewer takes us outside "ADMT" |
| Colorado HB 24-1130 applies to employers and applicants | Retention schedule, privacy notice | The text, the written-policy elements, and the incident-plan requirement |
| Illinois HB 3773 notice duty in force 1 January 2026; IDHR rules withdrawn 2 June 2026 | Privacy notice, invitation email | The statute and any new rules |
| Illinois AI Video Interview Act reaches a proctored coding test | Privacy notice, deletion within 30 days | Whether a webcam recording of a coding test is a "video interview" |
| NYC Local Law 144 does not apply, or applies only if recruiters treat scores as decisive | DPIA section 7 | Whether the integrity risk score or the code score is ever an AEDT output; notice timing |
| The EU-US Data Privacy Framework is valid and the Latombe appeal (C-703/25 P) is pending | DPIA section 8 | Current status; the SCC-primary approach |
| Emotion recognition prohibition (EU AI Act Art. 5(1)(f)) covers recruitment, and keystroke analytics must not infer emotion | DPIA section 7 | The Commission's final guidelines |

## 5. Questions for counsel

**Biometrics and consent**
1. BIPA: does landmark-based gaze, face-count and presence analysis (no identification, measurements not stored) create a "scan of face geometry"? Is one release enough to cover identity verification and attention analysis, with disclosure to AWS as storage provider?
2. Is a typed-name e-signature plus a separate tick box a valid "written release" under BIPA (as amended 2024), and valid explicit consent under GDPR Art. 9(2)(a)?
3. GDPR: is a video-call alternative on request enough for freely given consent in a hiring setting, particularly for Germany and France? Is there a safer lawful basis for the face match (probably not; please confirm)?
4. Withdrawal: is our rule right (explicit action; face data deleted within 30 days; other data kept on legitimate interests)? Is it a problem that the withdrawal also moves the candidate to a video-call check?
5. Is a face image allowed to remain in an encrypted backup for up to 14 days after its 90-day deletion, and longer if backups stall (C-55, C-59), if the consent and schedule say so?

**Retention and rights**
6. California: does the 4-year rule reach the proctoring data or only decision data? Does it apply to candidates who live in California for roles based elsewhere? Is keeping results only 1 year elsewhere safe under federal rules (29 CFR 1602.14)?
7. Erasure: is the 60-day outer limit on holding results and reviewer notes during an open review or appeal defensible under GDPR Art. 17(3)(e) and Art. 12(3), CCPA and the Illinois AI Video Interview Act? Is a legal hold by a Super Admin enough?
8. Consent records kept 3 years even after an erasure request: is this valid under GDPR Art. 17(3)(e) and CCPA exceptions?

**Automated decisions and AI**
9. Does our design (a person reviews every session, an appeal, human hiring decision) avoid GDPR Art. 22 and UK Art. 22A, CCPA ADMT and Colorado SB 26-189? What would make the human review not "meaningful" in practice?
10. NYC Local Law 144 and the EU AI Act: is the integrity risk score ever an AEDT output? When high-risk obligations apply (2 December 2027), are we provider and deployer, and what is the minimum file?

**EU/UK specifics (before the first EU/UK candidate)**
11. Art. 27: can we rely on the exemption for a pilot? Which representative service is appropriate?
12. Art. 36: with staff 2FA optional (D-78) and the DPIA risk R1 rated High until a host-application second factor or compensating measures are live, is prior consultation needed?
13. Transfers: is "SCCs primary, DPF secondary" right for a US controller collecting directly from EU/UK candidates (EDPB Guidelines 05/2021)? Is the wording in consent section 7 accurate?

**Security and reasonable care**
14. Is password-only staff access to biometric data and recordings (2FA optional, D-78) compatible with GDPR Art. 32 and BIPA's reasonable standard of care? What compensating measures would satisfy you?
15. If a consent version that promised a security control was signed before the control was removed, is a notice or re-consent needed?

## 6. Priority

1. **Before the first real US candidate (strongly recommended):** questions 1, 2, 5, 6, 7, 9, 14 and the Illinois and Colorado primary-text checks.
2. **Before the first EU/UK candidate (required by our own conditions):** questions 3, 4, 11, 12, 13 and the GDPR/UK primary-text checks.
3. **Before production (required by C-67):** everything else, plus a read of the final approved texts.

## 7. Items we may have missed

Please tell us about: any registration or filing (for example, a data broker or biometric registry in a state); breach notification duties by state for biometric data; whether CCPA applies to Rysun Labs Inc. (thresholds) and to employee and applicant data; Texas CUBI and Washington biometric rules; the laws of countries other than the US, EU and UK before any candidate is admitted from them; and recording rules for audio of bystanders (two-party consent states).

## 8. What we will provide

- All documents in section 3, in Markdown, with a changelog of every decision.
- A walkthrough of the candidate journey (the demo, with synthetic data) so the lawyer can see exactly what a candidate sees.
- The technical facts needed to answer a question, from the engineering team, on request.
- The owner's answers to follow-up questions. We will not send real candidate data.

## 9. After the review

The compliance reviewer folds the lawyer's markup into new versions of each document and a short record of what changed and why. The owner approves. Documents that change a statement to candidates take a new version number (consent drafting note 9).

*This pack is a draft for the owner. The reviewer who prepared it is not a licensed lawyer, and nothing in it replaces the professional review it asks for.*
