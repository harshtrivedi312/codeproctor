# Consent document: proctored coding assessment

Status: **FINAL-FOR-APPROVAL v0.5 (text), not loadable yet** (2026-10-09, compliance reviewer). The owner accepted every recommendation of [owner-decision-sheet.md](owner-decision-sheet.md) on 2026-10-09 (C-36 to C-42, the C-02 amendment, C-67 to C-69). v0.5 applies them and blockers B1 to B6 of [review-2026-10-06.md](review-2026-10-06.md). No open owner decision remains in this text; what remains is the owner's approval, fill-ins, the engineering gate below, and the professional legal review C-67 requires before production. Earlier history: v0.3 (2026-10-05, owner fill-ins, C-17..C-19, C-26..C-33); v0.4 (2026-10-08, section 6 no longer promises reviewer two-factor sign-in, D-70, D-73). Approver: Harsh Trivedi. This text has not had professional legal review (C-15, R-17).

The placeholder guard stays: pilot and production refuse to run until the owner approves a final version, and that version is loaded with its own version number (C-09, FR-401). Items in [square brackets] are filled in per organisation or before approval. The drafting notes at the end are not shown to candidates.

**Do not load this text until the system matches it.** Sections 4, 5 and 9 describe features that must exist first: the explicit "withdraw biometric consent" action and the video-call alternative (C-38 and the C-02 amendment), a human review of every session with no auto-clear (C-28), and the 90-day cap on everything that shows a face (C-37). See drafting note 1.

---

## Your consent for this proctored coding assessment

Document version [x.y] · Rysun Labs Inc.

Please read this document to the end. It explains what happens during the assessment, what we record, how we check your identity, who sees the results, how long we keep your data, and your choices. At the end you sign by typing your full legal name. **Your camera, microphone and screen are not accessed, and nothing is recorded, until you sign.** (We already hold your email address and the details of your one-time code check.)

### 1. Who we are

The assessment is run by **Rysun Labs Inc.**, [address] ("we"), for the role of [role]. We are responsible for your data (the "controller"). Our contact for privacy questions is [privacy email]. Your recruiter is [recruiter name, email]. [If you are in the European Union or the United Kingdom, our representative there is: EU representative, UK representative. Filled in only once appointed.]

### 2. What happens during the assessment

1. You have already confirmed your email with a one-time code.
2. You read and sign this document.
3. We check that your browser, camera, microphone and screen sharing work.
4. We check your identity: a photo of your government ID and a live selfie. **You can choose a video call with your recruiter instead (section 9).**
5. You take the coding test in full-screen mode, with your whole screen shared, and your camera and microphone on.

### 3. What we record during the test

Please take the test **alone, in a private room**. Your camera and microphone may also pick up other people and your surroundings. Close other apps and hide anything private on your screen. If anyone else may be heard or seen, please get their agreement first.

- **Your screen:** a recording of your whole screen.
- **Your webcam:** a video recording of you, and a short scan of your room before the test.
- **[STRICT tests only] A second camera:** your phone, placed to show your desk and screen, recorded the same way.
- **Live view:** a proctor may watch your session live and send you messages or pause the test.
- **Your microphone:** an audio recording.
- **Your typing and editing in the code editor:** keystroke timing, pastes, and how your code changes over time.
- **Browser activity:** for example, leaving full-screen mode, switching tabs or windows, pasting, connecting a second screen, or using a virtual camera.
- **Technical details:** your IP address, browser and device type, and connection events.

In legal terms, this is: identifiers (your name, email and IP address); audio and visual information; internet and device activity; employment-related information; and sensitive personal information (your government ID image and biometric data, section 4). We use it only for the purposes in sections 4 and 5. We record this to check that the test was taken fairly and by the right person.

### 4. Identity check, face checks during the test, and your biometric data

Images of your face and measurements of your face are **biometric data**. We use them for two purposes only:

1. **To confirm your identity.** We take a photo of your government ID and one live selfie, with a short liveness check (for example, turning your head). Face-matching software compares the two faces. During the test we also re-check that the same person is at the keyboard: about every 2 minutes, one small webcam frame (640 px) is compared on our server with your verified face. A frame that matches is discarded at once. A frame that does not match is kept as evidence for a human reviewer.
2. **To check your presence and attention during the test.** Software in your browser uses your webcam picture to measure where your face and eyes are, to see whether you are present, whether anyone else is in view, and whether you are looking at the screen. This does not identify you, and the measurements are not stored. Only the resulting flags (for example, "looked away for 5 seconds") and sometimes a snapshot are saved.

We use biometric data for **nothing else**. We **never sell, rent or trade it, and never share it for profit.**

- The face measurements used to compare faces are held in the computer's working memory only while your test runs, and **never saved**.
- Your ID photo, selfie and any re-check frames that did not match are deleted **no later than 90 days after they were taken** (section 8).
- No software here tries to read your emotions or feelings.

If the faces don't match well enough, **a person compares them. You are never rejected automatically** by the face match.

### 5. Automated detection, and people making the decisions

During the test, software looks for signs that a test may not have been taken fairly. Examples:
- more than one face on camera;
- looking away for long periods;
- a phone or book in view;
- other voices;
- large pastes;
- code very similar to other submissions or to AI-generated answers;
- leaving full-screen mode.

**The software only raises flags. It never decides anything.** It combines the flags into a score that helps the reviewer see which parts of your session to look at first. That score does not change your test score. **A trained reviewer reviews every assessment**, looks at any flags together with the recording, and decides what happened. Your results can't be used in hiring until the reviewer has signed off. **Nothing rejects you automatically, and a person makes every hiring decision.**

Your code is also run against test cases to calculate a score. Your score, the reviewer's decision and a short report are shared with the hiring team for [role]. Together with your other application materials, they are used to decide whether to move your application forward.

### 5a. Why we may use your data (legal basis)

- **Recording, monitoring, the integrity checks and scoring** (sections 3 and 5) are based on our **legitimate interest** in running a fair, secure assessment that every candidate takes under the same conditions. We have weighed that interest against your rights. We limit what we collect, keep it for a short time, let a person review everything, and offer accommodations. You have the right to object (section 9).
- **Your biometric data** (section 4) is processed only with your **explicit consent**, which you give by ticking the separate box and signing below. You can refuse or withdraw (section 9).

### 6. Who can see your data

Only these people and companies can see your data:
- **Our staff with the Recruiter role** for this role see your invitation, status, scores and the final decision.
- **Our staff with the Reviewer role** see the recordings, images, flags and your code, so they can review the assessment. They sign in to their own accounts.
- **Our staff with the Super Admin role** manage the system and handle requests about your data.
- **Our service providers**, under contract and only on our instructions: Amazon Web Services (hosting and storage, Amazon Simple Email Service for sending your invitation, one-time codes and a copy of this document, and Amazon CloudWatch for system logs, which never contain your recordings, images, codes or passwords), and Cloudflare (delivering the web pages). **Amazon Web Services stores your biometric data for us.** They may not use your data for their own purposes.

Every time a staff member opens one of your recordings or images, it is logged. Your scores and status may also be sent to [our applicant tracking system] through an export or automatic notification. We don't share your data with anyone else unless the law requires it.

### 7. Where your data is stored

All your data is stored in the **United States**, in Amazon Web Services region us-east-1. If you are in the European Union or the United Kingdom, your data will be sent to and stored in the United States, where the law may give you fewer rights than where you live. We protect it with encryption, strict access controls and short retention. Our service providers are bound by data processing agreements that include the European Commission's Standard Contractual Clauses (and, for the UK, the UK Addendum). You can ask [privacy email] for a copy.

### 8. How long we keep your data

- **Everything that shows your face or body** (recordings of your screen and webcam, the room scan and any second-camera recording, the ID photo, the selfie, evidence images, and re-check frames that didn't match): deleted **no later than 90 days after it was recorded**, or sooner if the organisation has chosen a shorter period. Encrypted backups are replaced about every 14 days, so a copy can remain in a backup for up to 14 days more, and longer only if backups have failed to run. If we restore a backup, we delete again what you asked us to delete.
- Face measurements: **never stored**.
- Keystroke data: deleted [N] days after your assessment is finished (normally 90).
- This signed consent record (document version, your age confirmation, your typed name, time of signing, IP address, browser and signed PDF): kept **3 years** to prove you consented, then deleted. We keep it for those 3 years even if you ask us to delete your data, because we may need it to show that you consented, for example if there is a legal claim. A record that you declined is kept the same way.
- Your results (scores, code and answers, the reviewer's decision and notes, and the report): kept **1 year** after your assessment is finished (4 years for roles based in California, C-68), as US hiring record-keeping rules require, then deleted, leaving only anonymised statistics. If a legal claim is open, we keep them until it ends.

The full schedule, including how we destroy data, is here: **[link to the retention and destruction schedule]**.

### 9. Your rights and choices

- **You can choose not to have your face matched.** If you prefer, tell your recruiter [name, email] before you start. Your identity is then checked on a short video call, and the face match and the face-based checks during the test are switched off. This choice has no effect on how your assessment is judged. If you need other changes (extra time, assistive technology, no webcam), ask in the same way; we will make reasonable adjustments.
- **Decline.** You may decline at the end of this document. Nothing will be recorded, the assessment will end, and you will see your recruiter's contact so you can discuss alternatives. [Declining is not treated as a failed assessment: see drafting note 3.]
- **Stop or withdraw.** You can stop at any time by ending the session. Recording stops at once. You can also **withdraw your consent to the use of your biometric data** at any time, before or after the test, by using the "withdraw biometric consent" button in the candidate portal, by telling your recruiter, or by writing to [privacy email]. We then stop using your biometric data and delete your ID photo, selfie and any re-check images within 30 days. Your identity can then be checked on a short video call instead. Withdrawing does not affect your assessment and does not affect anything we did before you withdrew. The rest of your data is kept as described in section 8.
- **Access, correct or delete your data.** Contact [privacy email]. Deletion is completed within 30 days of your request. If a review or appeal of your assessment is still open, we delete your recordings, images and keystroke data within the 30 days anyway, and we may keep your results and the reviewer's notes until the review or appeal ends, and no more than 60 days after your request. We tell you if this applies. We keep your scores without your name or email, linked only to your signed consent record, until the 1-year results limit (section 8), and then only anonymised statistics. We also keep the signed consent record for its 3 years (section 8).
- **Appeal a decision.** If the reviewer finds a violation, you can appeal within 7 days, and a different reviewer looks at it.
- **If you are in the EU or UK:** you also have the right to object to processing based on our legitimate interests (section 5a), to restrict processing, to data portability, and to complain to your local data protection authority (in the UK, the Information Commissioner's Office). Giving us your data is necessary to take the assessment online; if you would rather not, ask for the alternatives above.
- **If you are in California:** you have the rights to know, delete and correct your personal information, and to limit the use of sensitive personal information. We don't sell or share your personal information for advertising.

### 10. Your consent

By ticking the boxes and typing your full legal name below, then selecting **I agree and sign**, you confirm that:

1. **you are 18 or older** (required: you can't continue without confirming this) [ ] I confirm I am 18 or older;
2. you have read this document, including how we record and check the assessment on the basis of our legitimate interests (sections 3, 5 and 5a);
3. you understand that your data is stored in the United States (section 7);
4. you understand that software only raises flags, that a person reviews every assessment, and that a person makes every hiring decision (section 5).

**Separate consent for your biometric data:**

[ ] **I explicitly consent, and give my written release, for Rysun Labs Inc. to collect, use, store and disclose to our hosting provider (Amazon Web Services, which stores it for us) my biometric data, meaning images of my face and measurements of my face, only (a) to verify my identity and (b) to check my presence and attention during this assessment, and to keep and destroy it as described in section 8 and in the retention and destruction schedule. I know I can choose a video call instead (section 9), and that I can withdraw this consent at any time.**

Full legal name: ______________________   [I agree and sign]   [I decline]

We record the document version, your age confirmation, your biometric consent, your typed name, the date and time from our server, your IP address and your browser. We generate a signed PDF of this document and email you a copy.

---

## Drafting notes for the approver (not shown to candidates)

1. **Gate before loading (engineering prerequisites).** Do not load v0.5 until all of these exist, each owned as shown: the "withdraw biometric consent" action (C-38; needs ADR 0015 §6 widened, its owner question 10); the face-match alternative as a right on request (C-02 amendment); GRADED always going to UNDER_REVIEW with no auto-clear (C-28; ADR 0002 line 67 and fsd.md section 3, #218 pending when this was written); the 90-day cap on all face-bearing items and recordings (C-37, ADR 0004 section 9 and DB-06); and the separate biometric tick box and the stored age confirmation (FR-401, C-30, C-39). Section 3 also mentions the room scan and the STRICT second camera: keep them only when shipped (FU-FEB-17).
2. **What changed since v0.4, and why.** Section 4 now describes the in-test face analysis, which uses face landmarks (blocker B1, C-36). Section 10 item 3 of v0.4 (old section 11) is now a separate biometric tick box with the AWS disclosure and a fixed term (B2, C-37, C-39). Section 9 gives the face-match alternative as a right (B4), restricts withdrawal to an explicit action and deletes the biometric data on it (B3, C-38), and uses the capped erasure hold (S5, C-41, amending C-06). The optional-questions section is removed (B6): FAIR-01 brings its own notice and consent when it ships. Sections 1, 3, 5, 7 and 9 gain the Article 13 and CCPA wording (S2, S6, S6a, S8). Section numbers after 9 shifted by one (old 11 is now 10).
3. **"Declining is not treated as a failed assessment."** If you can commit to this, keep the sentence: it helps show consent is freely given (R-18). If you can't, replace it with "You can discuss alternatives with your recruiter."
4. **Retention numbers (decided).** The 90-day cap applies to every face-bearing item and recording (C-37, OQ-18, OQ-19). The backup sentence in section 8 states what C-55 and C-59 already decided. The backups sentence was accepted by the owner (C-67). California roles keep results 4 years (C-68). The legal-claim sentence reflects the legal hold (OQ-10).
5. **Representatives.** The pilot starts with US candidates only (C-67, S9). The sentence about an EU and UK representative in section 1 stays in brackets and is filled in when they are appointed, before the pilot opens to EU/UK candidates.
6. **Processors** match the processor register (processors.md): AWS (including SES and CloudWatch, C-31 and C-32), Cloudflare, and an ATS if one is used. Section 7 uses Standard Contractual Clauses, as the owner decided (C-03, S10); the wording says what they protect, not that the candidate's own submission to us is a "transfer".
7. **Job postings and the invitation email (C-14, S7)** carry the one-line AI-use notice. Suggested text: "This role includes a proctored online coding assessment. Software flags possible integrity issues and analyses your webcam picture to check your presence and attention and, with your consent, to confirm your identity with a face match. Nothing is rejected automatically: a person reviews every assessment and makes every hiring decision. You can ask for an alternative to the face match, or for accommodations, by contacting [recruiter]. Details are in the consent document you will be asked to read and sign before anything is recorded: [link]. Retention schedule: [link]."
8. **Reading level.** The aim is plain language at about a US grade 8 reading level. A final readability pass is recommended after your edits.
9. **Reviewer security.** Section 6 does not promise two-factor sign-in (D-70, D-73, D-78). Once a version is approved and served, any change to a statement about who can see candidate data or how it is secured needs a new version number and a fresh signature from candidates who have not yet signed. If the change weakens a promise that signed candidates saw, they also get a notice. The statement "every time a staff member opens one of your recordings or images, it is logged" is true today for recording playback links (`REVIEW_PLAYBACK_ISSUED`); Backend must confirm the same for the ID image and selfie, or section 6 says "recordings" only.
10. **Legitimate interests (C-29).** Section 5a states the basis. The full legitimate interests assessment is in the DPIA, section 3a. Objections from EU/UK candidates are handled case by case, like accommodations.
11. **Age (C-30).** The 18+ confirmation is a required tick box. A candidate who doesn't tick it can't sign, and sees the recruiter contact.
12. **Consent proof on erasure** (C-17) is stated in section 8. A declined-consent record follows the same clock (OQ-11, recommended).
13. **The privacy email** and company address are demo or blank and must be replaced before the pilot.
14. **Laws behind the changes** (claims for a qualified lawyer to confirm): BIPA 740 ILCS 14/15(b), (d) and (e), as amended by SB 2979 in 2024; GDPR Arts 5, 7(3), 9(2)(a), 12(3), 13, 17, 21 and 27; Colorado biometric amendment (HB 24-1130); CCPA notice at collection. Sources are in [review-2026-10-06.md](review-2026-10-06.md).
