# Manual test scripts

Owner: qa-engineer. For test cases that need real people or hardware (see /docs/test-matrix.md, level "manual"). Each script is run against staging (synthetic data only) or a local build with real devices, by a tester who is not the author of the feature.

## 0. Before you start (all scripts)

- Chrome or Edge, current stable, on a laptop with a webcam, microphone and one screen, unless the script says otherwise.
- A STANDARD or STRICT test invitation created by staff for a test account you control (the profile is named in each script). The candidate email is a mailbox you can read.
- Use only test accounts and synthetic faces or volunteers who signed the volunteer consent form (B-05 item 3 in /docs/status.md). Never use a real candidate's data.
- Open the staff review page for the session in another browser profile (not on the test laptop) so you can read the events as they arrive.
- Record for each run: date, build or commit, browser and version, OS, pass or fail, and the event IDs seen. A failed step is a defect: file it with the step number, expected and actual result, and name the owner agent from the matrix.
- Every script ends with a clean-up step. Delete the test session through the admin deletion flow (TC-094) afterwards.

## TC-034 Liveness spoof (FR-403, P2, STANDARD)

Needs: a printed colour photo of the face of the person in the ID photo (A5 or larger), a phone showing a still photo of the same face, the real person.

1. Open the invite link, pass the OTP, sign the consent document.
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

## Accessibility with a screen reader (NFR-06, part of TC-092, P1)

Needs: NVDA with Firefox or Chrome on Windows, and VoiceOver with Safari or Chrome on macOS. The axe scan runs automatically; this covers what axe cannot.

1. Walk the whole candidate flow with the keyboard only (Tab, Shift+Tab, Enter, Space, Esc): invite link, OTP, consent, system check, test, submit. Expected: every control reachable, visible focus, no keyboard trap (apart from the intended fullscreen lock overlay, which must still have a focusable Re-enter button).
2. Repeat with NVDA, then VoiceOver. Expected: headings and landmarks announced, form errors announced and linked to their fields, the timer announces time left only at thresholds (5 minutes, 1 minute, time up), the lock overlay and finish dialog are announced as dialogs.
3. Zoom to 200 percent and 400 percent width reflow. Expected: nothing cut off, no horizontal scrolling in the form screens.
4. Record every issue with the WCAG success criterion.

Pass: no blocking issue; every issue is filed with its criterion.
