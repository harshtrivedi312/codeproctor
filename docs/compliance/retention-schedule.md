# Retention and destruction schedule

Status: **DRAFT v0.2 for owner approval** (C-17, C-18 and owner fill-ins applied 2026-10-05) (C-04, C-05, C-06). Drafted 2026-10-05 by the Delivery Lead. Approver: Harsh Trivedi. This text has not had professional legal review (C-15).

Once approved, this text is published as a public page. The consent document and the candidate portal link to it (C-05; FE-09). Items in [square brackets] must be filled in before publication. The drafting notes at the end are not published.

---

## How long we keep your assessment data, and how we destroy it

**[COMPANY LEGAL NAME]** uses CodeProctor to run proctored coding tests for hiring. This schedule says what we keep from your test, for how long, and how we destroy it. It is our written retention and destruction policy for biometric data under the Illinois Biometric Information Privacy Act (BIPA), and our storage-limitation record under the GDPR and UK GDPR.

**We never sell, rent, trade or otherwise profit from your biometric data, and we never share it for profit.**

### When the clock starts

For most data the clock starts when your assessment is finished. That is the latest of: when you submit the test; when a reviewer records the final decision; and, if the decision can be appealed, 7 days after that decision or when an appeal you opened is resolved. While a review or an appeal is open, the clock does not start, because the data is still needed for that review.

### What we keep and for how long

| Data | What it is | How long we keep it |
| --- | --- | --- |
| Screen, webcam and microphone recordings, the room scan and any second-camera recording | Video and audio recorded during the test | **[N] days (the organisation's setting, default 90)** after the assessment is finished |
| ID image and selfie | The photo of your ID and the live selfie taken for the identity check | **[N] days (the organisation's setting, default 90)** after the assessment is finished [never more than 90: OQ-5] |
| Face measurements (embeddings) | The numbers calculated from your face to compare your selfie with your ID | **Never saved.** They are calculated in the computer's working memory, held there only while your test runs, and then discarded. If the system restarts, they are recalculated from your stored selfie |
| Identity re-check frames | One small webcam frame (640 px) every 2 minutes, compared with your verified face | **Not kept** if it matches. If it does not match, it is kept as evidence for the reviewer for **[N] days (the organisation's setting, default 90)** after the assessment is finished [never more than 90: OQ-5] |
| Evidence snapshots | Images saved when the system flags an event (for example, a second person on camera) | **[N] days (the organisation's setting, default 90)** after the assessment is finished |
| Keystroke data | Timing and editing activity in the code editor | **[N] days (the organisation's setting, default 90)** after the assessment is finished |
| Assessment report PDF | The generated report for reviewers | **[N] days (the organisation's setting, default 90)** after the assessment is finished |
| Technical details | IP address, browser and device details | Kept with your results [OQ-4]; removed if you ask us to delete your data |
| Face-match tuning photos (internal volunteers only, not candidates) | Photos given by colleagues who volunteered to test the identity check | Deleted when tuning finishes, and no later than the date in the volunteer form |
| Optional demographic answers | Only if you chose to answer the optional post-test questions | Stored separately from your test, never shown to reviewers or recruiters, never used in decisions, and **deleted with your recordings, [N] days (the organisation's setting, default 90)** after the assessment is finished |
| Signed consent record | The consent document version, your typed name, the time you signed, your IP address and browser, and the signed PDF | **3 years** after you sign, to prove you consented; then deleted |
| Results | Your scores, your submitted code and answers, the integrity events (without images), and the reviewer's decision and notes | [Retention period to be decided by the owner: see drafting note 1] |
| Backups | Encrypted copies of the database | **14 days**. Data deleted from the live system leaves the backups within 14 days |

[N] is set by the organisation that invited you, between 7 and 730 days, and is normally 90. [If the owner decides OQ-5 as proposed: **images of your face (the ID image, selfie, re-check frames, evidence snapshots and webcam recordings) are never kept for more than 90 days, whatever that setting says.**] In every case we never keep biometric data more than 3 years after your last interaction with us.

### How we destroy data

- Files (recordings, images, PDFs) are permanently deleted from our storage, including any earlier stored versions. Every reference to them is then removed from our database.
- Database records are deleted, or overwritten so they can no longer identify you.
- Each deletion is recorded in an audit log that holds only internal reference numbers, never the data itself.
- Deletion runs automatically every day.

### If you ask us to delete your data

You can ask us to delete your data at any time by contacting [EMAIL]. Deletion is completed **within 30 days of your request, or within 30 days after an open review or appeal closes, whichever is later.** If a review or appeal delays it, we tell you. We delete your recordings, images, keystroke data, code and answers. We keep only anonymised scores, which can no longer be linked to you. We keep the signed consent record (document version, your typed name, time of signing, IP address, browser and signed PDF) until 3 years after you signed, even after a deletion request, because we may need it to defend a legal claim. It is then deleted.

### Where your data is stored

All data is stored in the United States, in Amazon Web Services region [AWS REGION, e.g. us-east-1]. If you are in the EU or UK, your data is transferred to the US. The transfer is protected by Standard Contractual Clauses in our service providers' data processing agreements.

### Questions

Contact [EMAIL]. This schedule was last updated on [date].

---

## Drafting notes for the approver (not published)

1. **Results have no retention period today.** ADR 0004 R-5 keeps scores, code, event rows (without images), reviews and appeals with no time limit. GDPR storage limitation needs one. Suggest: **[2] years after the assessment is finished**, matching a common hiring-record retention period, then anonymise to scores only. This is new decision **OQ-4**.
2. **Consent record on erasure:** decided by C-17 and applied above.
3. **"With the session data" (C-13)** is read here as deletion together with the recordings, after [N] days. If you meant with the results instead (note 1), change that row.
4. **BIPA** requires permanent destruction when the purpose is met, or within 3 years of the individual's last interaction, whichever is first. 90 days is within that limit. The 730-day organisation setting must not apply to biometric items. The engineering rule for DB-06: cap biometric items at 90 days whatever `retention_days` says. This needs your confirmation, because today's design applies `retention_days` to ID images and selfies too. This is new decision **OQ-5**.
5. **Volunteer tuning set (C-11).** BIPA's public policy must cover every biometric identifier we hold, so the tuning set has its own row above. That matches the volunteer form's drafting note 2.
6. **S3 versioning.** Permanent deletion needs versioning off, or a lifecycle rule that expires noncurrent versions within days (ARC-05, DEP-03).
