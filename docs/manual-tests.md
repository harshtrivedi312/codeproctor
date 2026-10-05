# Manual test scripts

Owner: qa-engineer. For test cases that need real people or hardware (see /docs/test-matrix.md, level "manual"). Each script is run against staging (synthetic data only) or a local build with real devices, by a tester who is not the author of the feature.

## 0. Before you start (all scripts)

- Chrome or Edge, current stable, on a laptop with a webcam, microphone and one screen, unless the script says otherwise.
- A STANDARD or STRICT test invitation created by staff for a test account you control (the profile is named in each script). The candidate email is a mailbox you can read.
- Use only test accounts and synthetic faces or volunteers who signed the volunteer consent form (B-05 item 3 in /docs/status.md). Never use a real candidate's data.
- Open the staff review page for the session in another browser profile (not on the test laptop) so you can read the events as they arrive.
- Record for each run: date, build or commit, browser and version, OS, pass or fail, and the event IDs seen. A failed step is a defect: file it with the step number, expected and actual result, and name the owner agent from the matrix.
- Every script ends with a clean-up step. Delete the test session through the admin deletion flow (TC-094) afterwards. Erasure keeps the signed consent record and its PDF for 3 years (C-17) and waits while a review or appeal is open (C-06); this is expected, not a failed clean-up.
- Consent now includes the 18-or-older confirmation (C-30): every script that says "sign the consent document" means tick the confirmation, scroll to the end, type the full legal name and sign (script M-01).
- Every session is reviewed by a person (C-28): after a test finishes, the session waits in the review queue and the recruiter sees no result until a reviewer sets the verdict (script M-04). Do not expect a result on the recruiter side before then.
- Never write an OTP, token, presigned URL, object key or recording URL in a run record, a defect or a chat. Write the event ID, the prefix kind and the time only.
- Accommodation settings change what a session may produce (C-25, C-34, script M-03). "No identity check" waives the verification step (ID photo, selfie, initial match) and, with it, the identity re-check and FACE_MISMATCH; NO_FACE and MULTIPLE_FACES stay on unless "face detectors off" is also set. Whether waiving also switches FACE and GAZE off automatically is OQ-15 and is still open (ADR 0015 is proposed): record what you see. "Face detectors off" alone turns off NO_FACE, MULTIPLE_FACES and the re-check, but the ID check still runs, so TC-034 applies to such a session; GAZE_AWAY may still fire (ADR 0015). TC-034 does not apply to a session with the identity check waived. TC-057, TC-058 and TC-060 do not apply to a session with face detectors off, and TC-057 does not apply to a session with the check waived (no re-check).

## TC-034 Liveness spoof (FR-403, P2, STANDARD)

Needs: a printed colour photo of the face of the person in the ID photo (A5 or larger), a phone showing a still photo of the same face, the real person.

1. Open the invite link, pass the OTP, sign the consent document (18+ confirmation, scroll, typed name: script M-01).
2. At the identity step, upload an ID photo of the real person.
3. When the selfie step starts, hold the printed photo in front of the webcam so the face fills the oval. Move the print slightly. Expected: the liveness check fails with a clear message and a retry is offered.
4. Retry with the phone showing the still photo. Expected: the liveness check fails.
5. Retry as the real person. Expected: liveness passes.
6. On the staff side, open the identity check. Expected: the failed attempts are recorded and the final status is MATCHED or awaiting review, never silently rejected.

Pass: steps 3 and 4 fail liveness, step 5 passes, nothing is auto-rejected.

## TC-036 Second camera disconnect (FR-405, P2, STRICT)

Needs: a phone with a camera and a QR reader (the phone's own camera app).

1. Start a STRICT test. At the setup step, scan the QR code on screen with the phone. Expected: the phone page opens, asks for camera access, and the laptop shows "side camera connected".
2. Place the phone so it shows the desk and the candidate. Start the test.
3. After about two minutes, close the phone browser tab (or lock the phone). Expected (observation: the 15 second figure is a QA expectation, not in the FSD; record the actual delay): a SIDE_CAMERA disconnect event with severity HIGH appears on the staff side, and the test pauses with a message telling the candidate to reconnect.
4. Scan the QR code again. Expected: the test resumes, the paused time is accounted for as the FSD state machine says, and a reconnect event is logged.

Pass: steps 3 and 4 behave as described and the timeline shows both events.

## TC-054 Window-only screen share (FR-604, P1)

1. Start a test and reach the screen-share prompt.
2. In the browser share picker, choose the "Window" tab and select any window. Expected: the app rejects it, explains that the entire screen is required, and asks again. The test does not start.
3. Choose "Chrome tab" and select a tab. Expected: rejected in the same way.
4. Choose "Entire screen". Expected: accepted and the test can start.
5. Repeat steps 2 and 4 on Edge.

Pass: only "Entire screen" is accepted, in both browsers.

## TC-055 Stop sharing mid-test (FR-604, P1)

1. Start a test with the entire screen shared. Type a few lines in the editor.
2. Click the browser's "Stop sharing" bar button. Expected: the test pauses (observation: the 2 second figure is a QA expectation, not in the FSD; record the actual delay and report it if it is over 5 seconds), an overlay asks the candidate to share the screen again, and SCREEN_SHARE_STOPPED (HIGH) appears on the staff side.
3. Try typing. Expected: the editor is locked while paused.
4. Share the entire screen again. Expected: the test resumes and the event timeline shows the stop and the resume.

Pass: pause, event and recovery as described; no code typed before the stop is lost.

## TC-056 Second monitor (FR-605, P1)

Needs: a second monitor and a cable, or a screen mirroring setup that adds a second display.

1. With one screen only, open the invite link and go to the system check. Expected: the check passes the monitor item.
2. Connect the second monitor in extended mode (not mirrored). Expected: the start button is disabled (observation: the 5 second figure is a QA expectation, not in the FSD; record the actual delay) and instructions say how to disconnect the extra screen.
3. Disconnect it. Expected: the start button works again.
4. Start the test. Connect the second monitor mid-test. Expected: a multiple-monitors event is logged and shown on staff side.
5. Repeat step 2 with the second monitor in mirror mode and note the result in the run record (the FSD does not say what must happen; report it to the architect if the app does not block).

Pass: steps 1 to 4 behave as described.

## TC-057 No face (FR-606, P1, STANDARD)

The automated version (fake video file) is planned; this script is the manual backup.

1. Start a test and let it run with your face centred in the camera.
2. Leave the camera view completely (stand up and step out of frame) for 10 seconds, then return.
3. Expected: a NO_FACE event appears on the staff side after about 5 seconds of absence (not before 4 seconds, and not later than 7 seconds), once per absence, with a snapshot.
4. Return and stay still for 20 seconds. Expected: no further NO_FACE events.

Pass: one NO_FACE event, 5 seconds after leaving the frame, with a snapshot.

## TC-058 Second person (FR-606, P1, STANDARD)

Needs: a second person.

1. Start a test with the candidate alone in view for 30 seconds. Expected: no MULTIPLE_FACES events.
2. The second person steps into the frame so their face is clearly visible next to the candidate, and stays 10 seconds.
3. Expected: MULTIPLE_FACES (severity HIGH) with a snapshot showing both faces. Open the snapshot on the staff side and check both faces are visible.
4. The second person leaves. Expected: no new events after 10 seconds.
5. Repeat with the second person only partly in frame (half a face at the edge) and with a poster of a face on the wall behind the candidate. Record the results; a poster that triggers the event is a false positive to report.

Pass: steps 1 to 4 as described.

## TC-059 Phone in view (FR-606, P1, STANDARD)

1. Start a test. Hold a phone (screen on, then screen off) in front of the camera for 5 seconds, about 30 cm from the lens.
2. Expected: PHONE_DETECTED with a snapshot showing the phone. The event appears within a few seconds.
3. Put the phone down out of frame. Expected: no further events.
4. Hold other objects (a mug, a remote control, a book) in view for 5 seconds each. Record any PHONE_DETECTED as a false positive.

Pass: steps 1 to 3 as described. False positives in step 4 go in the run record.

## TC-060 Gaze away (FR-606, P2, STANDARD)

1. Start a test. Look at a fixed point well to the side of the screen (about 60 degrees to the right) for longer than the configured gaze threshold (default 5 s per FR-606; TC-060 uses 7 s), keeping your head still. Check the configured value in the org settings first and write it in the run record.
2. Expected: GAZE_AWAY is logged once.
3. Look back at the screen for 20 seconds. Expected: no more events.
4. Look at the screen but glance away for 2 seconds, three times. Expected: no GAZE_AWAY events (below the configured threshold).
5. Repeat step 1 wearing glasses and note the result.

Pass: steps 1 to 4 as described.

## TC-061 Second voice (FR-607, P2, STANDARD)

Needs: a second person, a quiet room.

1. Start a test. Stay silent for 30 seconds. Expected: no voice events.
2. The second person speaks in normal voice, about 2 metres from the laptop, for 10 seconds. The candidate stays silent.
3. Expected: MULTIPLE_VOICES or SPEECH_DETECTED is logged.
4. The candidate talks to themselves for 10 seconds. Expected: SPEECH_DETECTED (a single voice cannot be MULTIPLE_VOICES).
5. Play music with no speech at normal volume for 20 seconds. Record whether any event appears.

Pass: steps 3 and 4 produce an event; step 1 produces none.

## TC-063 Network drop (FR-609, P1, STANDARD)

The Playwright version uses browser offline mode. This script checks the real network.

1. Start a test on Wi-Fi. Type code and wait for the saved indicator. Note the last code line and the time on the timer.
2. Turn Wi-Fi off (not the browser's offline mode) and keep typing for 45 seconds.
3. Turn Wi-Fi on. Expected: a "Reconnected" message, no error dialog.
4. **Pending architect decision** (TC-063 expects DISCONNECTED/RECONNECTED after 45 s, but FR-609 logs DISCONNECTED after 60 s without a heartbeat; see docs/followups/qa.md). Until the architect decides, record what actually happens for both drops and do not mark this step pass or fail. Working assumption: on the staff side DISCONNECTED appears about 60 seconds after the last heartbeat (so only if the drop lasted longer than that; with a 45 second drop expect no DISCONNECTED), and RECONNECTED if DISCONNECTED was logged. Repeat steps 2 and 3 with a 90 second drop and expect both events.
5. Check the recordings in the review page. Expected: no gap over 10 seconds in any stream after the upload buffer drains, and no missing chunk.
6. Reload the page after the drop. Expected: the code typed during the drop is present.
7. Check the timer. Expected: the server clock kept running; the timer did not pause or jump.

Pass: no code or chunk lost, events as described, timer correct.

## TC-064 Virtual camera (FR-610, P2, STANDARD)

Needs: OBS Studio with its Virtual Camera.

1. Install OBS, add a video capture source with your real camera, and start the Virtual Camera.
2. Open the invite link and, at the camera step, choose "OBS Virtual Camera".
3. Expected: VIRTUAL_CAMERA is logged (and the system check warns or blocks according to the FSD).
4. Switch to the real camera. Expected: no new VIRTUAL_CAMERA events.
5. Repeat with another virtual camera (for example a macOS camera extension or ManyCam) and record the result.

Pass: step 3 logs the event; step 4 does not.

## Compliance and review flows (C-01 to C-35)

These scripts cover the owner decisions in /docs/compliance/decisions.md. Script IDs start with `M-`. A script carries the TC ID it belongs to when one exists in /docs/test-cases.md. Where the decision has no TC yet, the hub is still to assign one (see "Proposed TC cases" in /docs/followups/qa.md) and the heading says "TC pending"; the matrix row is added by QA A when the ID exists. Wording on screen is not yet fixed by the FSD for several of these flows, so the expected results name the meaning, not the exact text; record the exact text seen.

Status of the product text these scripts rely on, checked 2026-10-05 against main: FSD FR-305, FR-401 and FR-805 do not yet carry C-02, C-28 and C-30 (the hub applies them), and ADR 0015 (waived identity check, PR #49) is still proposed. Where a script says "per C-xx", the decision is the source until the FSD lands. If the build disagrees with the decision, file a defect against the owner named in the "Applied to" column of decisions.md.

Common set-up for M-01 to M-06: a staging organisation with a reviewer account (2FA on), a recruiter account, and one test per script. The candidate mailbox is one you can read. Use the approved consent version, or on staging the placeholder version (the placeholder guard blocks pilot and production only, C-09).

### M-01 Consent with the 18+ confirmation (TC-095, TC-030; FR-401; C-07, C-09, C-29, C-30, C-05, C-31; STANDARD)

Needs: a candidate mailbox; browser developer tools open on the Network tab and a second browser profile for the staff side; permission to look at the browser's site settings.

1. Open the invite link and pass the email OTP. Keep the Network tab open and the site settings (camera, microphone, screen) visible. Expected (TC-030): the consent document is shown; no camera, microphone or screen permission prompt appears; no request to a media, presign or events route is made; nothing is uploaded.
2. Look for the 18-or-older confirmation (C-30). Expected: it is a required, separate control that is not ticked by default, with a label that says the candidate is 18 or older.
3. Without scrolling to the end, try to sign. Expected (TC-095): Sign is disabled, the 18+ control cannot make it enabled.
4. Scroll to the end, type the full legal name, leave the 18+ confirmation unticked and try to sign. Expected (C-30): signing is refused, with a message that names the missing confirmation, and focus moves to it. Then, whether or not the browser sent a request, replay the sign request from the Network tab (DevTools, copy as fetch) with the age confirmation false and again with the field missing. Expected (C-30): the server answers 400 both times, no consent row is stored (ask the admin to check), and the status is not CONSENTED. The candidate cannot continue and no media was requested. Do not paste the copied request (it carries a token) into a run record or chat.
5. Tick the 18+ confirmation and sign. Expected: success; the status moves to CONSENTED; the next step (system check) is reachable.
6. In another browser profile open the staff side and find the consents record for the session (or ask the admin to read it). Expected (C-07, C-30): document version, the typed name, a server timestamp (compare with the staff clock, not the candidate laptop), IP address, user agent, and the stored 18+ confirmation. No field holds a password, a token or an OTP.

Variant M-01a (server time, separate run): change the candidate laptop clock one hour forward before the signing step (step 5) on a second run, then repeat steps 5 and 6. Expected: the stored timestamp is the server time, not the laptop time.

7. Open the candidate mailbox. Expected (C-07, C-31): a copy of the signed document arrives (PDF attached or linked). Record the sender domain and the delivery time. The mail contains no OTP and no link that carries a token you did not expect.
8. Check the links on the consent step and the candidate portal. Expected (C-05): a link to the retention and destruction schedule; it opens, it is reachable by keyboard, and its numbers match /docs/compliance/retention-schedule.md.
9. Read the consent document against C-09, C-29 and C-14. Expected: it asks for explicit consent to biometric processing separately from the rest; it separates what is done on legitimate interests from what the candidate consents to; it says software only flags and a person makes every decision; it names the identity re-check (one 640 px frame every 2 minutes, C-08); it names US storage and the transfer of EU and UK data (C-03); it gives the accommodation contact; it mentions the optional demographics question (C-13) as separate and optional.
10. Start a second test for the same candidate email (a new invitation). Expected (TC-095, FR-401): the candidate must sign again; the 18+ confirmation is asked again; the old signature is not reused.

Pass: steps 1 to 10 as described; variant M-01a shows server time. Any media request before step 5 is a P1 defect (TC-030).

### M-02 Decline path (TC-096; FR-401; C-02; STANDARD)

Needs: as M-01, an invitation created by a recruiter whose name and email you know.

1. Open the invite link, pass the OTP, open the consent document and choose Decline. Keep the Network tab and the site settings visible from the start.
2. Expected: a confirmation step or message, then the declined page. The status is DECLINED on the staff side (the Dashboard or the session page).
3. Expected (C-02): the declined page shows the recruiter's contact from the invitation (name and email), and says how to ask for an alternative or an accommodation. Check it is the recruiter of this invitation, not another organisation's contact.
4. Expected (TC-096): no camera, microphone or screen request appeared at any time, before or after declining; no upload and no event batch was sent (Network tab).
5. Reopen the invite link, in the same browser and in another browser. Expected: the declined page again; no OTP prompt that starts a test; no new session.
6. On the staff side, check the recruiter view. Expected: the session shows DECLINED with the decline time and document version; there is no recording, no identity check, no risk score. No data was stored beyond the decline record (OQ-11 is open: record how long the staff side says it keeps the record).
7. As the recruiter, change the invitation so the candidate can try again with an accommodation (create a new invitation with the "no identity check" or "face detectors off" setting, see M-03). Expected: the new invitation starts a new session; the declined one stays DECLINED.

Pass: steps 2 to 6 as described. A media request, an upload or a way to restart the declined session is a P1 defect.

### M-03 Waived identity check and the two accommodation settings (TC pending; FR-305, FR-403, FR-606; C-02, C-19, C-25, C-34; ADR 0015 proposed; STANDARD)

Needs: a recruiter account, a reviewer account (2FA), a super admin account, three invitations (A, B, C) for candidate mailboxes you control, and a laptop with a webcam. Reason codes in ADR 0015: REFUSED_BIOMETRIC_PROCESSING, CANNOT_COMPLETE_ID_CHECK, OTHER (with a note). Expected UI wording is open; record what you see.

Part 1: setting the waiver (recruiter side)
1. Create invitation A with "no identity check" on and no reason. Expected (C-19): refused (400 or an inline error); nothing is saved.
2. Choose reason OTHER with an empty note. Expected: refused. Choose a reason with a note longer than 500 characters. Expected: refused.
3. Choose CANNOT_COMPLETE_ID_CHECK and save. Expected: saved; the invitation shows the waiver and the reason. Open the audit log as the super admin. Expected: one audit row for the change, with organisation, actor (the recruiter), invitation id, IP and no secret. Record whether the free-text note (if you entered one) is copied into the audit detail; the reason may hold health information (OQ-13), so note it either way.
4. Change and then clear the setting on a scratch invitation. Expected: one audit row per change (set, change, clear).
5. Log in as a user without invitation rights (for example the reviewer) and try to change the accommodation through the page or by pasting the request in the developer tools. Expected: 403. Log in as a recruiter of another organisation (if you have one) and request the invitation. Expected: 404.

Part 2: the candidate flow with the waiver (invitation A)
6. Open A as the candidate, pass the OTP, sign the consent document (M-01). Expected: the ID photo and selfie steps are skipped or shown as not required; the system check, room scan and recordings still run; the candidate is told what still runs.
7. Start the test. Wait 5 minutes. Expected (C-34): no identity re-check frame is sent (Network tab: no request to the identity re-check route or an evidence presign for the re-check) and no FACE_MISMATCH event appears.
8. Finish the test. As the reviewer open the session. Expected (C-19, OQ-13): the review screen shows "identity check waived" (or equivalent); the reviewer does not see the reason text (OQ-13 is open: record what the reviewer sees). Also open the browser developer tools on the reviewer's page and read the JSON of the review API responses in the Network tab: record whether the accommodation reason or note appears there even when the screen hides it (it may hold health information, OQ-13). As the recruiter or super admin open the same session. Expected: the reason is visible.
9. As the recruiter record "video ID check done: yes" and then "no" on a copy. Expected (C-19): the field saves, the reviewer sees the result, each save writes an audit row.
10. Expected: the waived session is not rejected anywhere and is not auto-cleared (see M-04).

Part 3: face detectors off, identity check still on (invitation B)
11. Create B with "face detectors off" only. Run the candidate flow. Expected (C-25): ID photo, selfie and the initial face match still run; during the test, no NO_FACE or MULTIPLE_FACES events appear even if you leave the frame for 15 seconds or a second person enters; the identity re-check does not run (C-34): no re-check request, no FACE_MISMATCH. GAZE_AWAY: record whether it still fires (ADR 0015: GAZE stays unless it is also off).
12. Expected: the review screen shows that the face detectors and the re-check were off (ADR 0015 review projection `recheck: OFF_FACE_DETECTORS`); record the text.

Part 4: both settings (invitation C)
13. Create C with both settings and reason REFUSED_BIOMETRIC_PROCESSING. Provisional expectation (OQ-15 is open and ADR 0015 is proposed, so this is not yet a requirement): FACE and GAZE are switched off together with the waiver, and the recruiter cannot switch them back on once the candidate has passed the OTP. Record what you see; do not file a defect for a difference until OQ-15 is answered.
14. Run the candidate flow. Expected: no ID step, no face detection, no gaze events, no re-check; recordings still run.

Pass: parts 1 to 4 as described, every setting change audited, no FACE_MISMATCH or face event where the settings forbid it. A face request sent after a waiver, or a missing audit row, is a P1 defect.

### M-04 Every session reviewed (TC-075, TC-076; FR-805, FR-902, FR-904; C-14, C-28; STANDARD)

Needs: a recruiter, a reviewer, and a webhook receiver you run yourself: a small local HTTP server on your own machine or on the staging network that logs each delivery's headers and body (synthetic data only). Do not use a hosted request-bin or tunnel service: deliveries carry candidate results. Verify the HMAC signature locally on that receiver. Never paste the webhook signing secret into a hosted service, a run record, a defect or a chat; the admin gives it to you through the operator console and you put it in the local receiver's environment only. The staging webhook SSRF guard has an outbound allowlist, so the receiver host may need to be added by the hub; ask for that and wait. Do not work around the guard (no redirects, no alternative hostnames, no guard changes). Run a clean session: no leaving fullscreen, no paste, face centred throughout.

1. Take the clean test as the candidate and finish it. Wait until grading is done. Expected (C-28, FR-805 per C-28): the risk band is LOW and the session is in UNDER_REVIEW, in the reviewer queue. It is not COMPLETED and not cleared automatically.
2. As the recruiter open the session. Expected (C-28): no score, verdict or report is visible yet; the page says the review is pending.
3. As the recruiter try the CSV export and the report download for that session. Expected: the session is not included or the report is refused until the verdict exists.
4. Check the webhook receiver. Expected (FR-1003, C-28): no result-bearing delivery yet (neither session.reviewed nor session.completed). (If one arrived before the verdict, that is a defect.)
5. As the reviewer open the queue. Expected: the session is listed with its band; a fast-review path exists: a summary view and a one-click verdict, with the full timeline still reachable (C-28). Time the review from opening the page to saving the verdict and write the time in the run record (capacity planning).
6. Set a verdict (CLEAN) with the one-click control. Expected: the status moves to COMPLETED; an audit row records the reviewer; the reviewer's note, if any, is kept.
7. Expected after the verdict: the recruiter sees the result and the report; the export includes it; the signed webhook delivers session.reviewed (FR-1003) (verify the signature locally on your receiver, with the secret held only in its environment). Record the event name seen: session.reviewed is the event FR-1003 expects after the review (record the exact name sent, and whether session.completed is also sent).
8. Repeat with a session that produced 2 HIGH and 3 MEDIUM events (leave fullscreen, paste attempts, tab switches, as in the other scripts). Expected (TC-075): the band matches the configured weights (HIGH 20, MEDIUM 8 points, ADR 0005, so 64 and band HIGH by default); the session is in the queue; the verdict cannot be completed while a HIGH flag is undecided (TC-078).
9. Repeat with a waived identity check (M-03) and with an identity check that goes to manual approval (TC-033). Expected: both appear in the queue and cannot be cleared automatically.
10. Set-up (TC-080 is P3, run it last): the reviewer sets a VIOLATION verdict; within 7 days the candidate opens the appeal link. Expected: the appeal goes to a different reviewer.

Pass: no session reaches COMPLETED without a reviewer action; no result is visible to a recruiter, export or webhook before the verdict. Any early result is a P1 defect (C-28; security-relevant because it exposes candidate results).

### M-05 Retention, erasure and the consent proof (TC-072, TC-094; FR-704; NFR-05; C-04, C-05, C-06, C-17, C-26, C-27, C-35; STANDARD)

The time-based checks need either a staging test hook from DB-06 (a way to run the retention job with a shifted clock) or the integration tests; do not change the staging server clock by hand. The hook must exist on staging only and must be admin-gated (SUPER_ADMIN, audited). Verifying that it is absent in pilot and production is part of the run: on a pilot or production build, as a SUPER_ADMIN, try to reach it (the operator console entry, and the route if it is documented) and expect it to be missing or refused (404 or 403). Never run it there for real. If it is reachable without admin rights, or present in pilot or production, that is a P1 security defect (owner: database-engineer for DB-06, and backend-engineer for the route); flag it in /docs/followups/qa.md. The hook is not yet specified in the docs; if the build has none, run only the steps that do not need it, mark the clock steps "not manually verifiable" and point to the integration results for TC-072.

Use two sessions. Session X (steps 2 to 4, 7 to 10) is erased in step 4, so it cannot be used for the clock steps. Session Y, finished and not erased, is used for steps 5, 5a and 6 (clock-shift steps).

Needs: a super admin, a finished session with recordings, an ID photo, a selfie and a signed consent (use M-01 and M-04 data), access to the staging bucket listing through the operator console (read-only; do not copy any object key or URL into the run record or a chat, write only the prefix kind such as "identity/" and the object count).

1. Open the published retention and destruction schedule (C-05). Expected: the firm tiers match decisions.md: ID image, selfie and mismatch frames capped at 90 days from capture or submission, whatever the organisation setting (C-27, C-35); results 1 year (C-26); signed consent records 3 years (C-04). Two points are still open and are observations, not defects: whether evidence frames fall under the 90-day face cap (OQ-19) and whether recordings and keystrokes are capped at 90 (OQ-18). Per retention-schedule.md they follow the organisation's retention days with no cap for now. Write down what the published schedule says for these and for the start of the results clock (OQ-20). Write any difference on the firm tiers as a documentation defect.
2. In the bucket listing, before any deletion, note the prefix kinds present for the session: media, identity, evidence, reports, consent PDF.
3. Request erasure for the candidate as the super admin while an appeal or review is open (set the session UNDER_REVIEW first, or a VIOLATION with an appeal). Expected (C-06, TC-094): the candidate is told that erasure waits; nothing is deleted yet; an audit row records the request.
4. Close the review or appeal. Expected: erasure runs as soon as it closes; the candidate is told it is done.
5. On session Y, using the test hook, set the organisation retention to 7 days and run the job at 8 days. Expected (TC-072, C-27): ID image, selfie and mismatch frames are deleted (shortened), recordings and keystroke batches are deleted, the object keys are nulled, an audit row is written per job. Repeat on another finished session with 365 days at 91 days. Expected: ID image, selfie and mismatch frames are gone at 90 days. Record, without filing a defect, what happens to recordings and evidence frames at 91 days (OQ-18, OQ-19 are open; per retention-schedule.md they follow the setting).
5a. Face tier during an open hold (C-35). On a session whose review or appeal is still open (or UNDER_REVIEW), run the job at 91 days after capture or submission. Expected: the ID image, selfie and mismatch frames are deleted even though the review hold is open; the hold does not extend the face tier. Non-face items stay while the hold is open.
6. On session Y, run the job at 1 year and 1 day. Expected (C-26): scores, verdicts, notes and reports are deleted, only anonymised statistics remain, with no candidate id; at 3 years and 1 day the consent record and PDF are deleted (C-04). The start of the 1-year clock (test date or retention anchor) is OQ-20 and is open: record which date the job used.
7. After the erasure in step 4, list the bucket again. Expected (C-17, TC-094): recordings, ID image, selfie, evidence, code, answers and keystrokes are gone; the only personal item left is the signed consent record and its PDF, until 3 years after signing. The confirmation to the candidate says so.
8. Open the candidate record as the recruiter and the reviewer. Expected: no code, answers, name or email remain beyond what C-17 keeps; the accommodation notes are cleared or you record what is left (OQ-12 is open).
9. Try to open a playback link for the erased session. Expected (TC-071, which is about signed-URL expiry, not erasure): access is denied once the link has expired (20 minutes, TC-071) and also because the object is gone. Do not save or paste the old playback URL anywhere; use the link only from the page where it appeared and write only the time and the result.
10. Check the audit log. Expected: the erasure request, hold, completion and each retention run appear, with no object key and no personal data in the audit detail.

Pass: steps as described. Anything personal left beyond the consent proof, or any deletion of non-face data while a review or appeal is open, is a P1 defect. Deletion of face-tier items while a hold is open is expected (step 5a), not a defect. A reachable clock-shift hook in pilot or production is a P1 defect.

### M-06 Optional demographics (TC pending; C-13, FAIR-01; STANDARD)

Not yet runnable: FAIR-01 is not built. Run when it lands. Needs: a finished test, a reviewer, a recruiter, a super admin, and at least 10 finished synthetic sessions for the aggregate check.

1. Finish a test. Expected: after the test the candidate is offered an optional form with its own explicit consent and a "prefer not to say" choice; the test result does not depend on answering.
2. Skip the form. Expected: nothing is stored; the session behaves exactly as without it.
3. Answer with consent. As the reviewer, recruiter, author and super admin open the session, the export and the webhook payload. Expected (C-13): no individual answer is visible anywhere.
4. Check the aggregate report with fewer than 10 candidates in a group. Expected: the group is not shown.
5. Erase the candidate (M-05). Expected: the answers are deleted with the session data.

Pass: steps as described. Any staff-visible individual answer is a P1 privacy defect.

## Accessibility with a screen reader (NFR-06, part of TC-092, P1)

Needs: NVDA with Firefox or Chrome on Windows, and VoiceOver with Safari or Chrome on macOS. The axe scan runs automatically; this covers what axe cannot.

1. Walk the whole candidate flow with the keyboard only (Tab, Shift+Tab, Enter, Space, Esc): invite link, OTP, consent (including the 18+ confirmation and the retention schedule link, C-30, C-05), the decline screen and its recruiter contact (C-02), system check, test, submit, and the optional demographics form once FAIR-01 exists (C-13). Expected: every control reachable, visible focus, no keyboard trap (apart from the intended fullscreen lock overlay, which must still have a focusable Re-enter button).
2. Repeat with NVDA, then VoiceOver. Expected: headings and landmarks announced, form errors announced and linked to their fields, the timer announces time left only at thresholds (5 minutes, 1 minute, time up), the lock overlay and finish dialog are announced as dialogs.
3. Zoom to 200 percent and 400 percent width reflow. Expected: nothing cut off, no horizontal scrolling in the form screens.
4. Record every issue with the WCAG success criterion.

Pass: no blocking issue; every issue is filed with its criterion.
