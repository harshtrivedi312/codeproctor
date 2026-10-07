# Retention and destruction schedule

Status: **DRAFT v0.5 for owner approval** (C-59 applied 2026-10-07; C-55 applied 2026-10-06; C-17, C-18, C-26, C-27, C-32 and owner fill-ins applied 2026-10-05) (C-04, C-05, C-06). Drafted 2026-10-05 by the Delivery Lead. Approver: Harsh Trivedi. This text has not had professional legal review (C-15).

Once approved, this text is published as a public page. The consent document and the candidate portal link to it (C-05; FE-09). Items in [square brackets] must be filled in before publication. The drafting notes at the end are not published.

---

## How long we keep your assessment data, and how we destroy it

**Rysun Labs Inc.** uses CodeProctor to run proctored coding tests for hiring. This schedule says what we keep from your test, for how long, and how we destroy it. It is our written retention and destruction policy for biometric data under the Illinois Biometric Information Privacy Act (BIPA), and our storage-limitation record under the GDPR and UK GDPR.

**We never sell, rent, trade or otherwise profit from your biometric data, and we never share it for profit.**

### When the clock starts

For most data the clock starts when your assessment is finished. That is the latest of: when you submit the test; when a reviewer records the final decision; and, if the decision can be appealed, 7 days after that decision or when an appeal you opened is resolved. While a review or an appeal is open, the clock does not start, because the data is still needed for that review.

### What we keep and for how long

| Data | What it is | How long we keep it |
| --- | --- | --- |
| Screen, webcam and microphone recordings, the room scan and any second-camera recording | Video and audio recorded during the test | **[N] days (the organisation's setting, default 90)** after the assessment is finished |
| ID image and selfie | The photo of your ID and the live selfie taken for the identity check | **[N] days (the organisation's setting, default 90)** after the assessment is finished, and **never more than 90 days** |
| Face measurements (embeddings) | The numbers calculated from your face to compare your selfie with your ID | **Never saved.** They are calculated in the computer's working memory, held there only while your test runs, and then discarded. If the system restarts, they are recalculated from your stored selfie |
| Identity re-check frames | One small webcam frame (640 px) every 2 minutes, compared with your verified face | **Not kept** if it matches. If it does not match, it is kept as evidence for the reviewer for **[N] days (the organisation's setting, default 90)** after the assessment is finished, and **never more than 90 days** |
| Evidence snapshots | Images saved when the system flags an event (for example, a second person on camera) | **[N] days (the organisation's setting, default 90)** after the assessment is finished |
| Keystroke data | Timing and editing activity in the code editor | **[N] days (the organisation's setting, default 90)** after the assessment is finished |
| Assessment report PDF | The generated report for reviewers | Kept with your results for **1 year** after the test |
| Technical details | IP address, browser and device details | Kept with your results for **1 year** after the test; removed if you ask us to delete your data |
| System logs (Amazon CloudWatch) | Technical logs of the service, which may include your IP address, browser and a session reference, but never recordings, images, one-time codes or passwords | **[30] days** [OQ-9] |
| Face-match tuning photos (internal volunteers only, not candidates) | Photos given by colleagues who volunteered to test the identity check | Deleted when tuning finishes, and no later than the date in the volunteer form |
| Optional demographic answers | Only if you chose to answer the optional post-test questions | Stored separately from your test, never shown to reviewers or recruiters, never used in decisions, and **deleted with your recordings, [N] days (the organisation's setting, default 90)** after the assessment is finished |
| Signed consent record | The consent document version, your typed name, the time you signed, your IP address and browser, and the signed PDF | **3 years** after you sign, to prove you consented; then deleted |
| Results | Your scores, your submitted code and answers, the integrity events (without images), the reviewer's decision and notes, and the report | **1 year** after the test, as US hiring record-keeping rules require; then deleted, leaving only anonymised statistics [unless a legal hold applies: OQ-10] |
| Backups | Encrypted copies of the database | **14 days, on a rotation.** Data deleted from the live system normally leaves the backups within 14 days. If backups stop for a while, we keep the newest 3 copies until backups start again, so that the service can be restored. While backups are stopped, deleted data can stay in those copies for longer, including beyond the 30-day deletion deadline below. If we ever restore a backup, all the deletions you asked for since that copy are made again, and scheduled deletions run again at the next daily check |

[N] is set by the organisation that invited you, between 7 and 730 days, and is normally 90. **Images of your face (the ID image, the selfie and re-check frames that didn't match) are never kept more than 90 days, whatever that setting says.** In every case we never keep biometric data more than 3 years after your last interaction with us.

### How we destroy data

- Files (recordings, images, PDFs) are permanently deleted from our storage, including any earlier stored versions. Every reference to them is then removed from our database.
- Database records are deleted, or overwritten so they can no longer identify you.
- Each deletion is recorded in an audit log that holds only internal reference numbers, never the data itself.
- Deletion runs automatically every day.

### If you ask us to delete your data

You can ask us to delete your data at any time by contacting privacy@example.com. Deletion is completed **within 30 days of your request, or within 30 days after an open review or appeal closes, whichever is later.** One exception is a backup copy kept while backups are stopped (see Backups above); if that copy is ever restored, your deletion is made again. If a review or appeal delays it, we tell you. We delete your recordings, images, keystroke data, code and answers. We keep your scores, pseudonymised (no name or email attached), linked only to your signed consent record while that record is kept (up to 3 years); after that, only anonymised statistics remain. We keep the signed consent record (document version, your typed name, time of signing, IP address, browser and signed PDF) until 3 years after you signed, even after a deletion request, because we may need it to defend a legal claim. It is then deleted.

### Where your data is stored

All data is stored in the United States, in Amazon Web Services region us-east-1. If you are in the EU or UK, your data is transferred to the US. The transfer is protected by Standard Contractual Clauses in our service providers' data processing agreements.

### Questions

Contact privacy@example.com. This schedule was last updated on [date].

---

## Drafting notes for the approver (not published)

1. **Results: 1 year (C-26).** The report PDF counts as a result, so it moved from the media rows to the results row. OQ-10 asks for a legal hold to override deletion when a claim is open.
2. **Consent record on erasure:** decided by C-17 and applied above.
3. **"With the session data" (C-13)** is read here as deletion together with the recordings, after [N] days. If you meant with the results instead (note 1), change that row.
4. **BIPA:** C-27 caps face images (the ID image, selfie and mismatch frames) at 90 days. The engineering rule for DB-06 is to cap these items at 90 days, whatever `retention_days` says. Evidence snapshots and webcam recordings follow `retention_days`, as C-27 doesn't list them.
5. **Volunteer tuning set (C-11).** BIPA's public policy must cover every biometric identifier we hold, so the tuning set has its own row above. That matches the volunteer form's drafting note 2.
6. **S3 versioning.** Permanent deletion needs versioning off, or a lifecycle rule that expires noncurrent versions within days (ARC-05, DEP-03).
7. **Backups (C-55, 2026-10-06).** Backups follow a 14-day rotation, and the newest 3 are never deleted, whatever their age. If backups have stalled, the newest 3 are kept until backups resume, and never beyond the 30-day erasure window without your explicit decision. You get an alarm after 2 days with no new backup, and the Delivery Lead proposes a second alarm before the newest kept backup reaches 30 days. Choose the published wording: either keep the bracket in the backups row ("unless the approver records a decision"), or remove it and promise the 30-day limit outright. Also open: if backups have stalled and you haven't answered the alarm by day 30, are the newest 3 kept (the service stays restorable, and a restore re-applies the erasure list) or deleted (the 30-day promise holds, but there may be no backup)? The Delivery Lead recommends keeping them, with the published row saying so. The last sentence of the backups row follows ADR 0004 R-7 and §9.7: a restore re-applies the erasures recorded after the backup, and ordinary retention deletions are made again at the next daily run (under C-47, the next daily wake). Nothing in the accepted ADRs holds the service closed until the replay finishes; that would need an amendment you approve. Keep the bracket in the published row until you answer the day-30 question: until then nothing is deleted automatically, so a stalled backup can outlive 30 days. In practice, with the 12-day Object Lock and the 1-day noncurrent rule (ADR 0017), a backup outside the newest 3 goes after about 12 to 13 days, so the restore window is about 12 days, still within the 14 days above. **Updated 2026-10-07 by C-59:** you chose to keep the newest 3 even when a stall runs past day 30, with the 28-day alarm to you, and to say so in the published row, which now does. The day-30 question above is answered.
8. **Scores after an erasure request (2026-10-07).** The erasure section used to say the kept scores "can no longer be linked to you". Under C-17 and ADR 0004 §9.5, scores stay pseudonymised and linked to the kept consent record until its 3-year limit, so the text now says that. Please confirm the wording before publishing.
