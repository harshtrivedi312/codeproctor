# Pilot Legal brief: decision record

The Delivery Lead prepared the brief on 2026-10-05. The owner, Harsh Trivedi, decided every item the same day as the approver (C-15). The decision IDs refer to [decisions.md](decisions.md).

| # | Brief item | Decision | What remains | Owner of what remains |
| --- | --- | --- | --- | --- |
| 1 | Consent document text | C-09: the Delivery Lead drafts the full 2–3 page document, which also covers re-check frames, explicit biometric consent, US storage of EU/UK data, the retention schedule, the optional demographics question, that nothing is rejected automatically and a person makes every hiring decision, and accommodations. The placeholder guard stays. | Draft ([consent-document.md](consent-document.md)), owner approval, then loading the approved version into the product (FE-09) | Delivery Lead (draft), Harsh (approval), frontend (load) |
| 2 | E-signature format | C-07: approved as proposed. | Nothing new; it is built in BE-07 and FE-09 as specified | backend, frontend |
| 3 | Identity re-check frames | C-08: approved as proposed (640 px every 2 minutes, kept only on mismatch, human review). | ADR 0013 (PR #39) records it once revised; the owner accepts the ADR | hub, Harsh |
| 4 | Face-match tuning set | C-11: internal volunteers with a separate consent. C-12: the per-group breakdown is allowed on the volunteers' explicit consent. | Volunteer form draft ([volunteer-consent-form.md](volunteer-consent-form.md)) for approval, then recruiting, then INT-01 tuning. INT-01 also needs BE-08; the model download is approved (C-22) | Delivery Lead (draft), Harsh (approval, recruiting), integrity (INT-01) |
| 5 | Erasure timing | C-06: approved as proposed; NFR-05 takes the wording. | Updating NFR-05 and ADR 0004 R-6. C-17 (OQ-1 answered): the signed consent record is kept 3 years, even after erasure | hub |
| 6 | Model licences | C-10: AuraFace and COCO-SSD are accepted risks owned by Harsh; object detection stays on; the automatic deployment block is lifted for these two files. | Licence-gate allowlist for the two pinned files (ADR 0013, deploy config); risk register entry R-16 (done) | hub, backend |
| 7 | Monitoring flag rates across groups | C-13: optional post-test self-report with separate consent, stored apart, aggregate only (minimum group of 10), deleted with the session. Needed before the pilot exit review, not before pilot start. | New FR and TCs, an ADR for storage, and build task FAIR-01 | hub, database, backend, frontend, QA |
| 8 | Named approver | C-15: Harsh Trivedi. External Legal review is not a blocker; one is recommended before production (risk R-17). | Recommended professional review before production | Harsh |

## Added by the decisions (not in the brief)

| Decision | What it adds | Owner of what remains |
| --- | --- | --- |
| C-01 | The pilot is open worldwide; GDPR, UK GDPR, BIPA and CCPA apply. | hub (brd.md §7) |
| C-02 | Face match is required, under explicit consent. Refusals go through audited per-invitation accommodations, and the decline screen shows the recruiter contact. C-19 (OQ-3 answered): a recorded reason, "identity check waived" for reviewers, and an advised ID video check whose outcome is recorded, all audited. | hub (FR-305, FR-401, ADR 0015), backend, frontend, integrity |
| C-03 | Data is stored in one US AWS region. For EU/UK candidates, an approved DPIA and a transfer mechanism (DPAs with SCCs, or DPF) are required first. | Delivery Lead drafts [dpia.md](dpia.md) and [processors.md](processors.md); Harsh approves and signs the DPAs |
| C-04 | Biometric and recording data are deleted after 90 days (configurable). Consent records are kept 3 years, then deleted. C-18 (OQ-2 answered): embeddings are never stored. | hub (ADR 0004 amendment), database (DB-06) |
| C-05 | A public retention and destruction schedule, linked from the consent document and the candidate portal. Biometric data is never sold. | Delivery Lead drafts [retention-schedule.md](retention-schedule.md); Harsh approves; frontend links it |
| C-14 | Nothing is rejected automatically, and a person makes every hiring decision (LOW-band sessions are auto-cleared; OQ-8), disclosed to candidates and in job postings. The DPIA assesses NYC Local Law 144 and the EU AI Act. | Delivery Lead (DPIA section); Harsh and recruiting (job postings) |

Later decisions C-21 to C-33 (the same day) settle the technical items, results retention (1 year), the 90-day cap on face images, review of every session, the lawful basis (legitimate interests, with consent for biometrics), the 18+ minimum, and the providers (SES, CloudWatch). See [decisions.md](decisions.md).
