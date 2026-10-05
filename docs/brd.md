# Business Requirements Document (BRD)

CodeProctor lets the hiring team run remote coding tests whose results can be trusted, cutting interviewer time spent on candidates who could not have passed without help.

## 1. Business problem

Remote coding tests are now easy to game. AI assistants can solve most standard problems in seconds, answers to popular questions circulate online, and a friend can help off-camera. Unproctored results no longer separate strong candidates from weak ones, so interviewers spend live-interview hours on candidates who should have been filtered out.

## 2. Objectives

| ID   | Objective                     | Measure                                                                                                                                   |
| ---- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| BO-1 | Trustworthy screening results | 90%+ of candidates who pass the test also pass the live technical interview (baseline to be measured in pilot)                            |
| BO-2 | Detect integrity violations   | Every high-risk session is flagged for human review before a hiring decision                                                              |
| BO-3 | Reduce interviewer load       | Fewer live interviews per hire compared with the pre-launch baseline                                                                      |
| BO-4 | Fair candidate experience     | Candidate satisfaction 4/5 or higher; accommodation requests honored                                                                      |
| BO-5 | Low running cost              | Built and staged on free tiers using synthetic data only; pilot and production run on the company's AWS account within an approved budget |
| BO-6 | Legal compliance              | Written consent, retention limits and deletion on request for all recordings                                                              |

## 3. Stakeholders

| Role                 | Interest                                                    |
| -------------------- | ----------------------------------------------------------- |
| Hiring managers      | Reliable signal on coding skill                             |
| Recruiters           | Send tests, track status, see results                       |
| Technical reviewers  | Review flagged sessions, confirm or clear violations        |
| Candidates           | Clear rules, fair test, working tech, privacy               |
| Legal / HR / Privacy | Consent, data retention, anti-discrimination, accessibility |
| IT / Security        | Data protection, access control, audits                     |

## 4. User roles

- **Super Admin** — manages organization settings, users, retention policies.
- **Recruiter** — creates tests from templates, invites candidates, views results.
- **Question Author** — writes and maintains questions, test cases and variants.
- **Reviewer / Proctor** — watches live sessions, reviews recordings and flags, records verdicts.
- **Candidate** — takes the test through a one-time invitation link; has no account.

## 5. Scope

In scope:

- Question bank with multiple languages, hidden test cases and randomized variants.
- Test templates, invitations, scheduling windows and reminders.
- Candidate portal: system check, consent, identity verification, room scan, timed coding environment.
- Proctoring: fullscreen and focus lock, screen, webcam and microphone recording, in-browser AI detection, keystroke logging and replay.
- Automatic grading, integrity risk score, reviewer workflow, reports and audit log.
- Desktop lockdown client (Phase 3).

Out of scope (initial release):

- Applicant tracking system (ATS) replacement; CodeProctor integrates through webhooks and CSV export.
- Fully automatic rejection based on integrity flags; a human always decides.
- Mobile-device test taking (phones and tablets are blocked for the test itself).

## 6. High-level business requirements

| ID    | Requirement                                                                                                                             | Priority         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| BR-01 | Recruiters can invite candidates to a test by email with a unique, expiring link                                                        | Must             |
| BR-02 | Candidates must verify identity (photo ID + live selfie) before starting                                                                | Must             |
| BR-03 | The system records screen, webcam and audio for the full session                                                                        | Must             |
| BR-04 | The system detects and logs tab switches, fullscreen exits, paste attempts, multiple faces, absent face, phone in view and extra voices | Must             |
| BR-05 | Code is executed and graded against hidden test cases automatically                                                                     | Must             |
| BR-06 | Each session gets an integrity risk score with a timeline of evidence                                                                   | Must             |
| BR-07 | Reviewers can replay the candidate's typing and watch linked video at each flag                                                         | Must             |
| BR-08 | Candidates receive different question variants to limit answer sharing                                                                  | Must             |
| BR-09 | Live proctor view of active sessions with the ability to message or pause a candidate                                                   | Should           |
| BR-10 | Plagiarism and AI-likeness checks on submitted code                                                                                     | Should           |
| BR-11 | Desktop lockdown client for high-stakes roles                                                                                           | Should (Phase 3) |
| BR-12 | Accommodation settings: extra time, disabled detectors, screen-reader support                                                           | Must             |
| BR-13 | Recordings deleted automatically after a configurable retention period                                                                  | Must             |
| BR-14 | Complete audit log of staff actions on candidate data                                                                                   | Must             |
| BR-15 | ATS integration via webhooks and CSV export                                                                                             | Could            |

## 7. Compliance and ethics

- Explicit, logged consent before any recording, with a plain-language explanation of what is captured and why.
- Biometric and privacy laws may apply depending on where candidates live (for example Illinois BIPA, GDPR, CCPA/CPRA). Legal must approve the consent text and retention policy before launch.
- Integrity flags are evidence, never verdicts. No candidate is rejected solely by an automated signal.
- Detectors can be biased (lighting, skin tone, eye conditions, disabilities). Thresholds are tuned during the pilot and flag rates are monitored across groups.
- Accessibility target: WCAG 2.1 AA for all candidate-facing screens.

## 8. Assumptions and constraints

- Candidates have a laptop or desktop with webcam, microphone and a Chromium-based browser (Chrome or Edge) for full proctoring.
- Free-tier services are used for build and staging, with synthetic data only. The pilot and production run on AWS, with candidate data (database and recordings) kept in AWS; the web front end is on Cloudflare Pages.
- The company owns all questions; no public question sets are used verbatim.

## 9. Risks

| Risk                                             | Impact                                   | Mitigation                                                  |
| ------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| False positives unfairly flag honest candidates  | Lost talent, reputational and legal risk | Human review, tuned thresholds, candidate appeal path       |
| Candidates drop out because of heavy proctoring  | Smaller pipeline                         | Clear instructions, practice test, short system check       |
| Free-tier limits hit during a large hiring round | Outages                                  | Usage alerts, upgrade path documented                       |
| Recording storage breach                         | Severe privacy incident                  | Encryption, signed URLs, least-privilege access, audit logs |
| Questions leak online                            | Weaker signal                            | Variants, rotation, leak monitoring                         |

## 10. Success criteria for launch

- Pilot of at least 20 real candidates completed with reviewer sign-off.
- All Must requirements implemented and all P1 test cases passing.
- Legal approval of consent and retention; security review closed with no open high findings.
