# Processor register

Status: **DRAFT v0.1 for owner approval** (C-03). Drafted 2026-10-05 by the Delivery Lead. Approver: Harsh Trivedi.

This register lists every outside service that receives or stores candidate data in the pilot or production, and how each transfer of EU/UK data to the US is covered. **Nothing below was checked against the providers' current documents.** The "To do" column says what the owner must confirm or sign. Data Privacy Framework (DPF) status can be looked up on the DPF list (dataprivacyframework.gov). DPA terms are in each provider's account or legal pages.

C-03 requires a DPA with Standard Contractual Clauses (SCCs), or DPF certification, for every processor **before the first EU/UK candidate**.

## Processors of candidate data (pilot and production)

| Service | Used for | Candidate data it receives | Location | Transfer cover to check | To do (owner) |
| --- | --- | --- | --- | --- | --- |
| Amazon Web Services: EC2 | API, worker, Redis, Judge0 host | Everything the API and worker handle while processing: personal data, events, code, media while it is analysed | One US region [region] (C-03) | AWS DPA (part of the AWS Service Terms, with SCCs); AWS DPF certification | Confirm the DPA applies to the account; record the region; check AWS's DPF entry |
| Amazon Web Services: S3 | Recordings, ID images, selfies, evidence, report PDFs, consent PDFs, backups | All stored media and documents | Same US region | As above | Same as above; bucket encryption, Block Public Access and versioning settings per ARC-05 |
| Amazon Web Services: database (RDS or Postgres on EC2, per ARC-05) | Postgres database | All structured candidate data | Same US region | As above | As above |
| Email provider (**not chosen yet, P-10**) | Invitation emails, OTP codes, consent PDF copy, erasure notices | Name, email address, OTP codes, the signed consent PDF (attachment or link) | Depends on the provider | AWS SES: covered by the AWS DPA. Brevo: EU provider with a DPA. Resend: US provider; check DPA and SCCs | Decide P-10, then sign or accept that provider's DPA |
| Error tracking (**not chosen yet, P-10**) | Server and browser error reports | Should receive no personal data once scrubbing is on; in practice, IP addresses, browser details and anything that slips past scrubbing | Depends | Self-hosted GlitchTip on our AWS: no new processor. Sentry SaaS: DPA with SCCs; check DPF | Decide P-10; require PII, token and media-key scrubbing (CLAUDE.md) |
| Cloudflare: Pages | Serving the web app to candidates and staff | IP addresses and request metadata of every visitor; no candidate media (uploads go straight to S3) | Global network | Cloudflare DPA with SCCs; Cloudflare DPF certification | Accept the Cloudflare DPA on the account; check the DPF entry |
| Applicant tracking system (webhooks and CSV export, FR-1003) [if used] | Receiving results | Candidate name and email, status, scores and verdict | Depends | The ATS vendor is the company's own processor; check its DPA and SCCs | List the ATS used, or confirm none for the pilot |

## Services that must not receive candidate data

These are listed so the boundary is explicit. If any of them starts receiving candidate data, it becomes a processor and needs a row above.

| Service | Used for | Why it is not a candidate-data processor | Check |
| --- | --- | --- | --- |
| Cloudflare R2, Supabase or Neon (staging) | Staging storage and database | Staging holds synthetic data only (D-10, D-11, CLAUDE.md) | Keep the rule; no real candidate on staging |
| GitHub (code, Actions, GHCR) | Source code, CI, container images | Holds no candidate data; tests use synthetic data | No production data or logs in CI artefacts |
| Secrets vault (Doppler or GitHub Actions secrets) | Deployment secrets | Holds credentials, not candidate data | Access limited to the owner (ADR 0009) |
| AI assistants used for reference solutions (D-20) | Generating reference solutions to questions | Receive question text only, never candidate code or data | Keep candidate submissions out of these tools |
| Judge0 CE | Running candidate code | Self-hosted on our AWS host, so not an outside processor | Covered by the AWS rows |
| Face and detector models (AuraFace, MediaPipe, COCO-SSD, Silero VAD) | Identity check and detectors | They run on our servers or in the candidate's browser, with model files served from our own origin (ADR 0013), so no data goes to the model authors | Keep runtime downloads from third-party CDNs off |
| Web fonts and other front-end assets | Page display | Must be self-hosted (no runtime calls to font CDNs) so visitors' IP addresses don't go to third parties | Frontend confirms fonts are bundled at build time |

## Notes

1. **Sub-processors.** Each provider lists its own sub-processors. The owner should save the list as accepted, and note how the provider announces changes.
2. **Data collected directly from EU/UK candidates.** If [Company legal name] is established only in the US, data that an EU/UK candidate types into our site is collected directly by a US controller. Under EDPB Guidelines 05/2021 that collection is not a Chapter V "transfer", although the GDPR still applies to it (Art. 3(2), monitoring behaviour). The processor DPAs and SCCs above still cover onward processing. The DPIA (section 8) records this, together with the need for an EU and a UK representative (GDPR Art. 27; UK GDPR Art. 27) unless an exemption applies.
3. **Records of processing.** This register and the DPIA together serve as the Art. 30 record for CodeProctor.
