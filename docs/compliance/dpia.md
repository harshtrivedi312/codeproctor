# Data protection impact assessment: CodeProctor pilot

Status: **DRAFT v0.2 for owner approval** (C-03a, C-14). Drafted 2026-10-05 by the Delivery Lead from the project documents (BRD, FSD, architecture, accepted ADRs 0001 to 0010, proposed ADRs 0011 to 0013, compliance decisions C-01 to C-33). Approver: Harsh Trivedi. **This DPIA has not had professional legal review (C-15, R-17).** Statements about laws are a first-pass reading for planning and need verification, especially the items marked *verify*.

Approval of this DPIA is a pilot entry blocker for EU/UK candidates (C-03a; status.md B-05 item 5).

## 1. Why a DPIA is needed

The GDPR and UK GDPR require a DPIA where processing is likely to result in a high risk (Art. 35). CodeProctor meets several of the regulators' criteria at once:
- systematic monitoring of people (screen, webcam, microphone and keystrokes during the test);
- special-category data (biometric data used to identify a person, Art. 9; optional demographic data under C-13);
- evaluation and scoring of people in a hiring context;
- innovative technology (in-browser AI detectors, face matching, AI-likeness checks);
- a power imbalance (candidates who want a job).

## 2. What the processing is

| Item | Description |
| --- | --- |
| Controller | Rysun Labs Inc., [address], for its own hiring. Approver and contact: Harsh Trivedi |
| Purpose | Run fair, trustworthy online coding assessments for hiring: check the candidate's identity, detect possible cheating, score the code, and let trained people make the decision |
| People affected | Job candidates worldwide (C-01), including the EU, UK and US (Illinois, California, New York City and others); staff users (recruiters, reviewers, admins, authors); internal volunteers for face-match tuning (separate consent, C-11) |
| Data | Identity: name, email, invitation details. Identity check: ID image, selfie, liveness result, match score (face templates are calculated in memory and **never stored**, ADR 0004). Monitoring: screen, webcam and microphone recordings, room scan, identity re-check frames (kept only on mismatch, C-08), evidence snapshots, browser and integrity events, keystroke timing and edits, IP address, device details. Results: code, answers, scores, risk score and band, reviewer decisions and notes, appeals. Consent record: version, typed name, timestamp, IP, user agent, signed PDF. Optional demographics (C-13), separate and aggregate only |
| Data flow | Browser to API (HTTPS); browser to object storage directly through short-lived presigned URLs, so media never passes through the API; API to Postgres; worker reads media from storage for analysis; Judge0 (self-hosted) runs code; reviewers watch through 15-minute signed playback URLs |
| Where | One US AWS region for all data, EU/UK included (C-03). Web front end served by Cloudflare Pages. Processors: [processors.md](processors.md) |
| Retention | [retention-schedule.md](retention-schedule.md): media [N] days after the assessment is finished (the organisation's setting, default 90); face images (ID image, selfie, mismatch frames) never more than 90 days (C-27); results 1 year (C-26); consent records 3 years, also after erasure (C-17); system logs [30] days (OQ-9); backups 14 days |
| Who decides | A trained reviewer reviews **every** session; nothing is cleared or rejected automatically, and results can't be used for hiring until the reviewer signs off (C-28). A person makes every hiring decision (BRD §7, FR-805, FR-902, C-14) |

## 3. Lawful basis

| Processing | GDPR / UK GDPR basis | Notes |
| --- | --- | --- |
| Biometric identity check and re-checks | Art. 6(1)(a) consent and **Art. 9(2)(a) explicit consent** (C-02), given by signing the consent document | Consent must be freely given; see risk R5 and section 6 |
| Recording, monitoring, integrity detection, scoring | **Art. 6(1)(f) legitimate interests (C-29)**: a fair, secure assessment that every candidate takes under the same conditions. See the assessment in section 3a | Candidates can object (Art. 21); objections are handled case by case, like accommodations |
| Optional demographics (C-13) | Art. 9(2)(a) explicit consent, separate from the test consent | Aggregate reporting only, with a minimum group size of 10 |
| Consent records kept 3 years | Art. 6(1)(c)/(f) and Art. 17(3)(e) (proving consent; legal claims) | Kept for 3 years even after an erasure request (C-17) |

US laws:
- **Illinois BIPA:** written notice of purpose and retention period; a written release; a public retention and destruction schedule (C-05); no selling or profiting (C-05); no disclosure without consent (the consent document names the processors); reasonable security.
- **CCPA/CPRA:** a notice at collection listing the categories of personal information, including sensitive personal information (biometric data, ID images), the purposes and retention; rights to know, delete, correct and limit. CCPA applies only if the company meets its thresholds (*verify*). The owner has decided to treat it as applying (C-01).
- **Texas (CUBI) and Washington** have their own biometric notice and consent rules; the BIPA-level approach should cover them (*verify*).

## 3a. Legitimate interests assessment (C-29)

| Test | Assessment |
| --- | --- |
| **Purpose:** is there a legitimate interest? | Yes. A hiring assessment is only useful if it is fair and was taken by the right person without outside help. Candidates who prepare honestly benefit from that too. |
| **Necessity:** is the processing needed for it, and is there a less intrusive way? | Remote assessments can't be supervised in person. Screen, webcam, audio and keystroke monitoring is the least intrusive way we know to give similar assurance. It is limited to the test window, starts only after the candidate has read the document, keeps media for [N] days (default 90), keeps face images at most 90 days, and stores no face templates. Accommodations adjust the monitoring for candidates who need it (C-02), and a waived identity check comes with an advised ID video call (C-19). |
| **Balancing:** do the candidate's interests override ours? | The intrusion is significant: the home environment, voice and behaviour. It is mitigated by: notice before anything is recorded; a candidate-initiated room scan; a person reviewing every session (C-28); no automatic rejection; appeals; short retention; access logging; accommodations; and the right to object. Candidates expect proctoring for remote technical assessments, and it is disclosed in job postings (C-14). **Conclusion: the balance favours processing, with these safeguards.** |
| **Device access (ePrivacy Art. 5(3))** | Turning on the camera, microphone and screen sharing goes through browser permission prompts the candidate grants. It is strictly necessary for the service the candidate asked for, the assessment (*verify*). |

## 4. Necessity and proportionality

- **Minimisation:**
  - Face templates are never stored.
  - Re-check frames are kept only on a mismatch.
  - Only object keys are kept in the database.
  - Heavy media goes straight to storage.
  - The ID photo is used only for the identity check (FR-403).
- **Retention limits:**
  - automatic daily deletion jobs;
  - [N] days for media (default 90), and a hard 90-day cap on face images that organisations can't extend (C-27);
  - results deleted after 1 year, leaving anonymised statistics (C-26);
  - erasure on request within the approved timeline (C-06).
- **Transparency:** a plain-language consent document read to the end before anything is recorded (FR-401, C-09), the public retention schedule, and notices in job postings (C-14).
- **Alternatives:** audited per-invitation accommodations, including disabled detectors or no face match, handled case by case by the recruiter (C-02).
- **Human decisions:** flags are evidence, never verdicts; reviewers decide; candidates can appeal to a different reviewer (FR-904).
- **Security:**
  - encryption at rest;
  - private buckets with short-lived signed URLs;
  - two-factor sign-in for reviewers and admins;
  - org scoping (ADR 0006);
  - an append-only audit log of staff access;
  - no secrets, tokens, OTPs or media keys in logs;
  - signed event batches.
- **Separation of environments:** staging holds synthetic data only. The pilot has its own stack, and agents never hold pilot credentials (ADR 0009).

## 5. Risks to the people affected

Likelihood and severity are before the measures. Residual risk is after them.

| # | Risk | Likelihood / severity | Measures | Residual |
| --- | --- | --- | --- | --- |
| R1 | Unauthorised access to recordings or ID images (a breach, or misuse by insiders) | Possible / severe | Encryption at rest; private buckets; 15-minute playback URLs; two-factor for reviewers; org scoping; audit log of every access; least-privilege roles; incident response plan (DEP-02) | Medium |
| R2 | A false face mismatch, more often for some groups (lighting, skin tone, eye conditions, disability) | Likely / significant | Never auto-reject; manual comparison by a person; threshold tuned on a diverse volunteer set with a per-group breakdown (C-11, C-12); pilot exit review of error rates by group (D-05); fairness monitoring (C-13) | Medium |
| R3 | False integrity flags (gaze, voice, pastes, AI-likeness), with disabled or neurodivergent candidates possibly affected more | Likely / significant | Flags are evidence only; trained reviewers; accommodations that turn detectors off; appeal; configurable thresholds and weights | Medium |
| R4 | Recording of bystanders and the private home (household members, room contents, notifications on screen) | Likely / moderate | Tell candidates in advance to use a private space and close other apps; the room scan is the candidate's own action; access limited to reviewers; deletion after [N] days (default 90) | Medium |
| R5 | Consent not freely given, because the candidate needs the job (GDPR Art. 7(4), recital 43; status.md R-18) | Possible / significant (lawful basis invalid) | Consent is now used only for biometrics (C-29); the alternative path is a waived identity check with a recorded reason, a reviewer flag and an advised video ID check (C-02, C-19); declining is not a failed assessment (consent drafting note 2) | Low to medium |
| R6 | Inferring special-category data from video or audio (health, religion, ethnicity) | Possible / significant | No such processing; reviewer guidance not to note such observations; free-text notes erased on erasure | Low |
| R7 | Function creep: recordings or biometric data used for other purposes (security, other hiring, training models) | Unlikely / severe | Purpose limitation in the consent document; no model training on candidate data; access logging; the retention schedule | Low |
| R8 | EU/UK data stored in the US (government access, weaker remedies) | Possible / moderate | SCCs or DPF for every processor (C-03b); encryption; minimal retention; transfer-impact notes in section 8 | Medium |
| R9 | Over-retention (results kept with no limit; organisation settings up to 730 days) | Likely / moderate | Results limited to 1 year (C-26); face images capped at 90 days (C-27); a legal hold for open claims (OQ-10) | Low |
| R10 | Automated decision-making in effect, because reviewers rubber-stamp the score or risk band (more likely now that every session, including low-risk ones, is reviewed through a fast path) | Possible / significant | A verdict requires a decision on every HIGH flag (ADR 0001 F7, FR-902); reviewer training; monitoring of how often reviewers agree with the risk band; appeals | Medium |
| R11 | Under-18 candidates | Unlikely / moderate | A required 18+ confirmation in the consent step; no confirmation, no test (C-30) | Low |
| R12 | Misuse of the optional demographic data, or re-identification from small groups | Unlikely / severe | Separate store; never visible to staff; never used in decisions; aggregate only with a minimum group of 10; deleted with the recordings after [N] days (default 90; C-13) | Low |
| R13 | Candidate data reaching third parties not listed (fonts, model CDNs, logs) | Possible / moderate | Processor register boundary; errors and logs stay in AWS CloudWatch and email goes through AWS SES (C-31, C-32); browser errors are scrubbed before they are logged; self-hosted fonts and model files (ADR 0013) | Low |
| R14 | Results kept past the 1-year limit when a legal claim is open, or deleted while one is pending (C-26) | Possible / moderate | A legal hold (OQ-10) | Low after OQ-10 |
| R15 | Agents act through the owner's GitHub account, so an agent could change CI or the model licence gate (C-33, status.md R-20) | Possible / moderate | Code review on every PR; a PR comment naming the merging session; the owner's own review of security-sensitive files | Medium (accepted by the owner) |

## 6. Measures still to put in place

1. Decide OQ-9 (log retention) and OQ-10 (legal hold). OQ-1 to OQ-8 are decided (C-17 to C-19, C-26 to C-30).
2. Accept the AWS and Cloudflare DPAs, with SCCs or DPF ([processors.md](processors.md)). Email (SES) and logs (CloudWatch) are under the AWS DPA (C-31, C-32).
3. Write a reviewer guide covering bias awareness, not rubber-stamping, and what not to record in notes.
4. Write a breach and incident response procedure (in DEP-02's checklist), including the 72-hour notification under GDPR Art. 33, and US state breach rules.
5. Decide whether an EU representative and a UK representative are needed (GDPR Art. 27; UK GDPR Art. 27) (*verify* the exemptions).
6. Decide whether a DPO is required (Art. 37). It is probably not, because monitoring is not the company's core activity (*verify*).
7. Publish a privacy notice covering everything in the consent document (some of this can be shared with it).
8. Before production: an independent legal review of this DPIA, the consent text and the retention schedule (C-15).

## 7. Automated-decision and AI laws (C-14)

**Position:** automated detection only produces flags. A trained reviewer reviews every session, and results are held until the reviewer signs off (C-28). Nothing is cleared or rejected automatically, and a person makes every hiring decision. This lowers the exposure under every regime below, but it does not remove it, because several regimes cover tools that "substantially assist" a decision, or AI used to "evaluate" candidates.

### GDPR / UK GDPR Art. 22

Art. 22 covers decisions based **solely** on automated processing. Because a person decides, it does not apply, provided the human review is meaningful: the reviewer has the authority and the information to reach a different conclusion. Keep evidence of this, such as the verdict gate on HIGH flags, reviewer agreement rates and appeal outcomes. The UK's Data (Use and Access) Act 2025 reworks the UK rules on automated decisions (*verify* the commencement date and its effect).

### NYC Local Law 144 (automated employment decision tools)

- **Applies when:** the employer uses an "automated employment decision tool" (AEDT) to screen candidates for a job located in NYC, or a remote job tied to an NYC office. An AEDT is a computational process derived from machine learning, statistical modelling, data analytics or AI that produces a simplified output (a score, classification or recommendation) used to **substantially assist or replace** discretionary hiring decisions. The city's rules define "substantially assist" as relying solely on the output, weighting it above other criteria, or using it to overrule a human decision.
- **Our assessment:**
  - The **code score** is calculated by running test cases (deterministic), so it is probably not an AEDT output on its own.
  - The **integrity risk score and band** are statistical and ML outputs, but they only send sessions to human review and are not hiring criteria.
  - If recruiters treat the code score or the risk band as the deciding factor, the tool could fall within the law.
- **If it applies, it requires:**
  - an independent bias audit within one year before use (selection or scoring rates and impact ratios by sex, race/ethnicity and their intersections);
  - a public summary of the audit results and the tool's distribution date on the careers site;
  - notice to NYC candidates at least 10 business days before use, describing the job qualifications and characteristics assessed, how to ask for an alternative process or accommodation, and the data retention policy (on request).
- **Recommendation:**
  - For pilot roles with NYC candidates, either keep scores clearly secondary and document why the tool is not an AEDT, or plan a bias audit.
  - Send the notice anyway, because it is cheap.
  - C-13's aggregate demographic data could support a future audit (*verify* with counsel).

### EU AI Act (Regulation (EU) 2024/1689)

- **Classification:** Annex III point 4(a) lists AI systems used for recruitment or selection, including to evaluate candidates, as **high-risk**. CodeProctor's ML parts (face verification, behavioural detectors, AI-likeness and similarity scoring) evaluate candidates, and their output is used in the EU, so the Act reaches a non-EU provider (Art. 2(1)(c)).
  - The Art. 6(3) exemption (narrow procedural or preparatory tasks) is probably not available, because an Annex III system that profiles people is always high-risk. Behavioural monitoring is likely profiling.
  - One-to-one face **verification** is excluded from the remote biometric identification category in Annex III(1)(a). That doesn't change the employment classification.
- **Prohibited practices to stay clear of:** emotion recognition in the workplace (Art. 5(1)(f)), and biometric categorisation that infers sensitive traits. **No detector may infer emotions or sensitive attributes.** Gaze and presence detection are allowed; any "stress", "nervousness" or similar signal is not.
- **Obligations if high-risk.** We build the system and use it ourselves, so we are both provider and deployer:
  - risk management (Art. 9) and data governance for training, validation and test data (Art. 10);
  - technical documentation (Art. 11, Annex IV) and automatic logging (Art. 12);
  - transparency and instructions for use (Art. 13), and human oversight measures (Art. 14);
  - accuracy, robustness and cybersecurity (Art. 15) and a quality management system (Art. 17);
  - internal-control conformity assessment (Annex VI), an EU declaration of conformity, CE marking and registration in the EU database (Art. 49);
  - post-market monitoring and serious-incident reporting;
  - deployer duties (Art. 26): competent human oversight, monitoring, keeping logs for at least 6 months, and informing the people affected.
  - AI literacy for staff who use the system (Art. 4) has applied since February 2025.
- **Timing:** under the Act as adopted, Annex III high-risk obligations apply from **2 August 2026**. The European Commission proposed in November 2025 (the "Digital Omnibus") to delay them until standards are available, by December 2027 at the latest. **Verify whether that delay was adopted, and the current dates, before the first EU candidate.**
- **Recommendation:**
  - Treat CodeProctor as high-risk for EU candidates.
  - Start an AI Act file now. Much of it already exists: the ADRs, logging, the human-oversight design, the threshold tuning report and the risk register.
  - Get counsel's view on the exact obligations and dates before the first EU candidate.

### Other laws to check (*verify*)

- **Colorado AI Act** (SB 24-205): duties for "high-risk" AI used in consequential decisions, including employment, such as impact assessments, notices, explanations of adverse decisions and appeals. Its effective date was postponed to 2026.
- **Illinois:** the AI Video Interview Act (notice, explanation, consent and deletion on request, for AI analysis of recorded video interviews; a conservative reading treats our webcam recording as covered), and HB 3773's amendment to the Illinois Human Rights Act (notice when AI is used in employment decisions; no discriminatory effect; from 2026).
- **California CCPA regulations on automated decision-making technology:** pre-use notice, opt-out or a human-appeal alternative, and risk assessments, with compliance dates from 2027.
- **Other non-US/EU countries** (C-01, worldwide): not assessed. Candidates from Canada (including Quebec Law 25), Brazil (LGPD), India (DPDP Act) and similar jurisdictions may have rights to notice, consent and transfer safeguards. Recommendation: limit the pilot to countries that have been checked, or apply the GDPR standard everywhere as the baseline.

## 8. International transfer notes (C-03)

- All data is stored in one US AWS region.
- If Rysun Labs Inc. is established only in the US, an EU/UK candidate's own submission to our site is direct collection by a US controller. Under EDPB Guidelines 05/2021 that is not a Chapter V transfer, but the GDPR applies to it through Art. 3(2)(b), monitoring behaviour in the EU. An Art. 27 representative may then be required. If the company has an EU or UK establishment, the export from it to the US is a transfer, and SCCs or DPF apply.
- Either way, C-03 requires SCCs or DPF for every processor, and records them in [processors.md](processors.md). A short transfer risk assessment should note that AWS and Cloudflare are DPF-certified (*verify*), that data is encrypted at rest and in transit, and that retention is short.

## 9. Outcome and sign-off

| Item | Value |
| --- | --- |
| Overall residual risk | Medium, acceptable for a pilot **if** OQ-9 and OQ-10 are decided, the processor agreements are in place, and the human-review evidence (R10) is collected |
| Prior consultation with a supervisory authority (Art. 36) | Not needed if the residual risks above are accepted as medium or low. Revisit if R5 or R2 cannot be brought down |
| Review date | At the pilot exit review, and before production |
| Approved by | Harsh Trivedi, product owner: ____________ date: ________ |

## New open questions from this DPIA

| ID | Question | Suggested answer |
| --- | --- | --- |
| OQ-6 | **Answered by C-29 (legitimate interests; consent for biometrics).** Is the lawful basis for the non-biometric recording and monitoring consent (current design), or legitimate interests or pre-contract steps, with consent kept only for biometrics? | Legitimate interests for proctoring and scoring, explicit consent for biometrics. This keeps the integrity record if a candidate withdraws, and lowers the "freely given" risk |
| OQ-7 | **Answered by C-30 (minimum age 18).** Can candidates under 18 apply (for example, for internships)? | If not, add an 18+ confirmation to the invitation flow. If yes, a parental-consent path is needed |
