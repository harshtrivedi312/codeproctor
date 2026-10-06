# Volunteer consent form: face-match tuning set

Status: **DRAFT v0.1 for owner approval** (C-11, C-12, D-18). Drafted 2026-10-05 by the Delivery Lead. Approver: Harsh Trivedi. This text has not had professional legal review (C-15).

Items in [square brackets] must be filled in before use. The drafting notes at the end are not part of the form.

---

## Help us make identity checks fair: volunteer consent

**Rysun Labs Inc.** ("we") is building CodeProctor, a tool we use to run online coding tests for job candidates. Before each test, CodeProctor checks that the candidate is the person on their photo ID by comparing a photo of the ID with a live selfie. If the two don't match well enough, a person reviews them. Nobody is ever rejected automatically.

To set that "match well enough" level fairly, we need to test the comparison on photos of real people with a range of ages, skin tones, genders and appearances. We are asking colleagues to volunteer. This form explains what is involved. Please read it all before signing.

### 1. Taking part is completely voluntary

- You don't have to take part, and saying no has no effect on your job, performance review, pay, promotion or how anyone treats you.
- Your manager will not be told whether you took part.
- You can change your mind at any time, before or after you sign (see section 7).

### 2. What we will collect

- **ID-style photo.** A photo of your government photo ID, with everything except your portrait covered by the template we give you. As soon as it is uploaded we crop it to the portrait and delete the original, so we keep no ID number, name, address or date of birth from the document.
- **Selfies.** [3 to 5] photos of your face taken with a laptop webcam or phone, under different conditions (for example normal light, dim light, with and without glasses).
- **Optional: demographic information.** If you tick box B below, you may also tell us your age band, gender, skin tone (on a picture scale) and whether you wear glasses. Every question has a "prefer not to say" option. This is separate from your photos and you can skip it entirely.

The photos and the face-shape measurements calculated from them are **biometric data** under laws such as the Illinois Biometric Information Privacy Act (BIPA) and the GDPR.

### 3. What we will do with it

- We run your ID-style photo and selfies through CodeProctor's face-matching model. It turns each face into a set of numbers and produces a similarity score. The numbers are used in memory and never saved. **We keep only the scores.**
- We also compare your photos with other volunteers' photos, to measure how often the tool wrongly matches two different people.
- We use the scores to choose the match level. If you tick box C, we also check whether the tool works equally well across groups, using the demographic information volunteers give.
- We write a short report with the results. **The report contains only totals and percentages, never photos or names.** We do not report any group with fewer than [10] people on its own.

### 4. What we will not do

- We will not use your photos or data for any other purpose: not for hiring decisions, security, marketing, or training any AI model.
- We will not sell, rent or trade your biometric data, or share it for profit.
- We will not give your photos or data to any other company. The face-matching model runs on our own systems.
- We will not put your photos in CodeProctor's candidate database.

### 5. Who can see it and where it is kept

- Only the people running the tuning can open your photos: [names or roles, e.g. the integrity engineer and Harsh Trivedi].
- Photos and demographic answers are stored separately, in encrypted storage with restricted access, in our AWS account in the United States (region us-east-1). They are linked only by a random code, not by your name.
- If you are in the EU or UK, your data is stored in the United States. The transfer is protected by Standard Contractual Clauses in our service providers' data processing agreements.

### 6. How long we keep it

- Your photos, the cropped ID portrait and your demographic answers are **deleted as soon as the tuning is finished, and no later than [date, e.g. 6 months after you sign]**, whichever comes first.
- We record the deletion, and will confirm it to you if you ask.
- The final report, with totals and percentages only, is kept as a record of how the match level was chosen.

### 7. Changing your mind

- You can withdraw at any time by emailing privacy@example.com. You don't need to give a reason.
- We delete your photos and answers within [7] days and confirm when it is done.
- If the report has already been written, we can't remove you from totals that are already calculated, but those totals don't identify you.

### 8. Your rights

You can ask to see the data we hold about you, correct it, or have it deleted, at privacy@example.com. If you are in the EU or UK, you can also complain to your data protection authority. Questions about this form go to [Harsh Trivedi, contact].

### 9. Your consent

You must be 18 or over to take part. Please tick each box you agree to. Box A is required to take part; B and C are optional.

- [ ] **A. Photos and face matching (required).** I agree that Rysun Labs Inc. may collect my ID-style photo and selfies, create face measurements from them, and use the resulting scores only to tune and test CodeProctor's identity check, as described above. I have read how long they will be kept and when they will be destroyed.
- [ ] **B. Demographic information (optional).** I agree to give optional demographic information, stored separately from my photos and deleted with them.
- [ ] **C. Group results (optional).** I agree that my demographic information may be used to calculate how accurate the identity check is for different groups. Only totals for groups of [10] or more people will be reported.

Full name: ______________________   Signature: ______________________   Date: ____________

Volunteer code (filled in by us): ____________

---

## Drafting notes for the approver (not part of the form)

1. **Freely given consent.** The volunteers are employees. Regulators treat employee consent with caution because of the power imbalance (GDPR Art. 7(4), recital 43; EDPB consent guidelines). The form handles this in section 1 by keeping participation unrelated to the job and hiding who took part from managers. **Decided (C-20):** recruit through an open call, never through managers. The call says plainly that not volunteering has no consequences. Offer no incentive large enough to feel coercive.
2. **BIPA.** BIPA needs a written release that states the purpose and how long the data is kept, plus a public retention and destruction policy. Section 6 and box A cover the release. The public policy is the retention schedule (C-05), which should list the tuning set as its own category.
3. **Crop-and-delete of the ID photo** keeps us from holding ID numbers. The integrity engineer must build it into the upload step before collection starts. An alternative is an ID-style portrait taken by us instead of a real ID, but that tests the real-world case less well.
4. **Group size of 10** follows C-13 for candidates. A small volunteer set may make some groups unreportable. The report says only that "some groups were too small to report separately". It never names or counts the hidden groups, because naming one would reveal that a group with fewer than 10 people exists (Delivery Lead decision, FU-INB-04).
5. **The real model:** the download was approved by C-22.
6. **Fill-ins needed:** company legal name, contact email, storage location and region, the people with access, the number of selfies, the deletion deadline, the withdrawal turnaround, and the EU/UK transfer mechanism (C-03).
