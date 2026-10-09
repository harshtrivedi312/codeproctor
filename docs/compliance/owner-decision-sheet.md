# Owner decision sheet: compliance items for the pilot

Status: **DRAFT for owner decision.** Prepared 2026-10-09 by the compliance reviewer for the Delivery Lead to put to the owner (Harsh Trivedi). One line per decision: the question, my recommendation, and what it unlocks. The reasoning is in [review-2026-10-06.md](review-2026-10-06.md) (section references B1 to S10, M1) and [review-2026-10-08-optional-2fa-and-demo-consent.md](review-2026-10-08-optional-2fa-and-demo-consent.md). IDs C-36 to C-42 are proposed and become real only when the owner decides and the Delivery Lead records them in [decisions.md](decisions.md). The drafts of consent v0.5, retention schedule v0.4 and the privacy notice apply these recommendations and say so; if you decide differently, they change.

## A. Decisions that block the first real candidate

| # | Question | Recommendation | What it unlocks |
| --- | --- | --- | --- |
| **C-36** (B1) | Is the in-test face analysis (gaze, face count, presence) covered by the same explicit biometric consent as the ID face match, and described to candidates? | **Yes.** Say it plainly in the consent. | A truthful BIPA release and Art. 9 consent. Without it, the consent text is false today |
| **C-37** (B2) | Cap every item that shows a face (ID image, selfie, mismatch frames, evidence snapshots, webcam, room scan, second camera) at 90 days from capture, stated as a fixed number? | **Yes.** Organisations may shorten, never extend. Backups add up to 14 days of rotation, and longer if backups stall (C-55, C-59); the documents now say so | The BIPA term in the written release; OQ-18 and OQ-19 |
| **C-38** (B3) | Does withdrawing biometric consent delete the ID image, selfie and re-check frames within 30 days and move the identity check to a video call? | **Yes**, through an explicit "withdraw biometric consent" action (finishing or ending the test is not a withdrawal). This needs the ADR 0015 §6 window widened (its owner question 10) | GDPR Art. 7(3). Backend and hub work |
| **C-02 amendment** (B4) | Is the "no face match" alternative a right on request instead of a case-by-case favour? | **Yes.** The recruiter records a reason ("candidate preference" is allowed) and may not refuse | Freely given consent for EU/UK candidates |
| **C-39** (S1) | A separate required tick box for biometric consent? | **Yes** | Explicit consent separate from other terms; a stronger BIPA release |
| **B6** | Remove the post-test demographics questions (section 10) from the pilot consent? | **Yes.** FAIR-01 brings its own notice and consent when it ships | The consent matches what the system does |
| **C-41** (S5, amends C-06) | Put an outer limit of 60 days on the erasure hold, only for results and reviewer notes? | **Yes.** Face data and recordings are never held | GDPR Art. 12(3); the Illinois AI Video Interview Act's 30 days |

## B. Decisions that block the first EU/UK candidate

| # | Question | Recommendation | What it unlocks |
| --- | --- | --- | --- |
| **S9** | Appoint EU and UK Art. 27 representatives, or start with US-only candidates? | **Start US-only for the first pilot candidates, appoint both representatives before opening to EU/UK.** Representative services cost little | C-01 stays "worldwide" in time; no Art. 27 breach |
| **C-42** (S10) | Make the signed DPA with SCCs (and the UK Addendum) the primary transfer mechanism, with DPF secondary? | **Yes.** The DPF appeal (C-703/25 P) is still pending | processors.md; consent section 7 |
| **R1 / D-78** | Keep staff 2FA optional (decided), with R1 at High for EU/UK and Illinois until the host application's second-factor sign-in or an equivalent control is live? | **Already decided (D-78).** Record the gate: before the first real candidate, that control is live and CodeProctor's own password login is unreachable for staff | DPIA §6 item 9; Art. 36 view from counsel |

## C. Retention and records

| # | Question | Recommendation | What it unlocks |
| --- | --- | --- | --- |
| **S4** | Will Rysun hire for California-based roles? If yes: keep results 4 years for them (California's ADS rules), 1 year elsewhere? | **If yes, option B** (per-job results retention: 4 years for California roles, 1 year elsewhere; never recordings or face data). If no, exclude California roles from the pilot | C-26 stays lawful; DB-06 gains a per-job setting |
| **C-40** | Audit-log retention | **3 years**, matching consent records; it holds internal reference numbers and staff IP addresses, never recordings, answers or images | A schedule row; Art. 5(1)(e) |
| **OQ-9** | CloudWatch logs | **30 days** (Session Manager logs, C-50, too) | Schedule row |
| **OQ-10** | Legal hold by Super Admin that pauses deletion for one candidate's results | **Yes.** Audited, manual lift, and it never extends the 90-day face tier | Schedule; DB-06 |
| **OQ-11** | Declined-consent records on the 3-year clock | **Yes** | Schedule row |
| **OQ-12** | Clear accommodation notes on erasure (health data) | **Yes**, keeping only which settings were used | Art. 9 minimisation |
| **OQ-13** | Reviewers see only "identity check waived", not the reason | **Yes** | Health data |
| **OQ-14** | A separate "no webcam" accommodation | **Yes**, implying no identity check and no face detectors | A path for candidates with no usable camera |
| **OQ-15** | Refusing biometrics switches off every face-based detector | **Yes** (C-25 and C-34 already point this way) | Consistency |
| **OQ-18** | Recordings capped at 90 days, `LEAST(retention_days, 90)` | **Yes** (same as C-37) | The fixed term in the release |
| **OQ-19** | Evidence snapshots in the 90-day face tier | **Yes** | Same |
| **OQ-20** | Results clock runs from the retention anchor (after review and appeal) | **Yes** | Results outlast an appeal |
| **OQ-21** | Tuning report breaks down by one dimension, skin tone | **Yes**, revisit at the pilot exit review | INT-01 |

## D. Scope and housekeeping

| # | Question | Recommendation | What it unlocks |
| --- | --- | --- | --- |
| **M1** | Is the pilot Rysun's own hiring only? | **Yes.** If any other organisation's candidates are tested, Rysun becomes a processor and the consent text is wrong | The controller statements in every document |
| **Fill-ins** | Real privacy email, company address, recruiter contact | The owner supplies them. `privacy@example.com` is blocked by the consent guard | Consent approval |
| **C-15 / R-17** | Professional legal review | **Before production, and ideally before the first real EU/UK or Illinois candidate.** I prepare the review pack | Production |
| **Backups (new)** | Backups can hold a face image for up to 14 days after its 90-day deletion, and longer if backups stall (C-55, C-59). Accept this and state it in the consent and schedule? | **Yes, state it.** BIPA's outer limit is the earlier of the purpose ending or 3 years, so it is lawful. Consent says "90 days, plus up to 14 days while backups rotate" | The wording in consent v0.5 and retention v0.4 |

## What happens after you decide

The Delivery Lead records each answer in `decisions.md`. I update the drafts to match, mark which are final, and prepare the lawyer pack. Anything you decide differently from my recommendation, I redraft before the document goes to you for approval.

*All recommendations are for owner decision. They are not legal advice from a licensed lawyer.*
