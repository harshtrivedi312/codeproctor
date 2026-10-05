# Retention and destruction schedule

Status: **DRAFT v0.1 for owner approval** (C-04, C-05, C-06). Drafted 2026-10-05 by the Delivery Lead. Approver: Harsh Trivedi. This text has not had professional legal review (C-15).

Once approved, this text is published as a public page. The consent document and the candidate portal link to it (C-05; FE-09). Items in [square brackets] must be filled in before publication. The drafting notes at the end are not published.

---

## How long we keep your assessment data, and how we destroy it

**[Company legal name]** uses CodeProctor to run proctored coding tests for hiring. This schedule says what we keep from your test, for how long, and how we destroy it. It is our written retention and destruction policy for biometric data under the Illinois Biometric Information Privacy Act (BIPA), and our storage-limitation record under the GDPR and UK GDPR.

**We never sell, rent, trade or otherwise profit from your biometric data, and we never share it for profit.**

### When the clock starts

For most data the clock starts when your assessment is finished. That is the latest of: when you submit the test; when a reviewer records the final decision; and, if the decision can be appealed, 7 days after that decision or when an appeal you opened is resolved. While a review or an appeal is open, the clock does not start, because the data is still needed for that review.

### What we keep and for how long

| Data | What it is | How long we keep it |
| --- | --- | --- |
| Screen, webcam and microphone recordings, and the room scan | Video and audio recorded during the test | **90 days** after the assessment is finished |
| ID image and selfie | The photo of your ID and the live selfie taken for the identity check | **90 days** after the assessment is finished |
| Face measurements (embeddings) | The numbers calculated from your face to compare your selfie with your ID | **Never stored.** They are calculated in memory for the comparison and discarded straight away |
| Identity re-check frames | One small webcam frame (640 px) every 2 minutes, compared with your verified face | **Not kept** if it matches. If it does not match, it is kept as evidence for the reviewer for **90 days** after the assessment is finished |
| Evidence snapshots | Images saved when the system flags an event (for example, a second person on camera) | **90 days** after the assessment is finished |
| Keystroke data | Timing and editing activity in the code editor | **90 days** after the assessment is finished |
| Assessment report PDF | The generated report for reviewers | **90 days** after the assessment is finished |
| Optional demographic answers | Only if you chose to answer the optional post-test questions | Stored separately from your test, never shown to reviewers or recruiters, never used in decisions, and **deleted with your recordings, 90 days** after the assessment is finished |
| Signed consent record | The consent document version, your typed name, the time you signed, your IP address and browser, and the signed PDF | **3 years** after you sign, to prove you consented; then deleted |
| Results | Your scores, your submitted code and answers, the integrity events (without images), and the reviewer's decision and notes | [Retention period to be decided by the owner: see drafting note 1] |
| Backups | Encrypted copies of the database | **14 days**. Data deleted from the live system leaves the backups within 14 days |

Your organisation's administrator can set a shorter or longer period for recordings and identity images, between 7 and 730 days. **For biometric data (the ID image, selfie and re-check frames) we never keep anything beyond 90 days, and never more than 3 years after your last interaction with us,** whichever is sooner.

### How we destroy data

- Files (recordings, images, PDFs) are permanently deleted from our storage. Every reference to them is then removed from our database.
- Database records are deleted, or overwritten so they can no longer identify you.
- Each deletion is recorded in an audit log that holds only internal reference numbers, never the data itself.
- Deletion runs automatically every day.

### If you ask us to delete your data

You can ask us to delete your data at any time by contacting [contact email]. Deletion is completed **within 30 days of your request, or within 30 days after an open review or appeal closes, whichever is later.** If a review or appeal delays it, we tell you. We delete your recordings, images, keystroke data, code and answers. We keep only anonymised scores, which can no longer be linked to you. [Signed consent record on erasure: see drafting note 2.]

### Where your data is stored

All data is stored in the United States, in [AWS region]. If you are in the EU or UK, your data is transferred to the US under [Standard Contractual Clauses / the EU-US Data Privacy Framework and its UK extension], and the safeguards are described in our privacy notice.

### Questions

Contact [Harsh Trivedi / privacy contact, email]. This schedule was last updated on [date].

---

## Drafting notes for the approver (not published)

1. **Results have no retention period today.** ADR 0004 R-5 keeps scores, code, event rows (without images), reviews and appeals with no time limit. GDPR storage limitation needs one. Suggest: **[2] years after the assessment is finished**, matching a common hiring-record retention period, then anonymise to scores only. This is new decision **OQ-4**.
2. **Consent record on erasure (OQ-1).** If you choose to keep a minimal consent proof until its 3-year limit, add: "We keep a minimal record that you consented (document version, time of signing and a fingerprint of the signed PDF) until 3 years after you signed, to show that we asked for your consent, and then delete it." If you choose deletion at once, say the consent record is deleted with everything else.
3. **"With the session data" (C-13)** is read here as deletion at 90 days, together with the recordings. If you meant with the results instead (note 1), change that row.
4. **BIPA** requires permanent destruction when the purpose is met, or within 3 years of the individual's last interaction, whichever is first. 90 days is within that limit. The 730-day organisation setting must not apply to biometric items. The engineering rule for DB-06: cap biometric items at 90 days whatever `retention_days` says. This needs your confirmation, because today's design applies `retention_days` to ID images and selfies too. This is new decision **OQ-5**.
5. **Volunteer tuning set (C-11)** is not candidate data. It follows its own form: deleted when tuning ends, and no later than the deadline in that form. It is listed in the internal record, not on this public page.
