# Processor register

Status: **DRAFT v0.3 for owner approval** (2026-10-06: C-43, C-45, C-50 and C-52 applied: Postgres on EC2, a separate Judge0 host, Session Manager and Route 53; C-03; C-31 and C-32 applied 2026-10-05: SES and CloudWatch replace the separate email and error-tracking processors, so the outside processors are AWS, Cloudflare and, if used, the ATS). Drafted 2026-10-05 by the Delivery Lead. Approver: Harsh Trivedi.

This register lists every outside service that receives or stores candidate data in the pilot or production, and how each transfer of EU/UK data to the US is covered. **Nothing below was checked against the providers' current documents.** The "To do" column says what the owner must confirm or sign. Data Privacy Framework (DPF) status can be looked up on the DPF list (dataprivacyframework.gov). DPA terms are in each provider's account or legal pages.

C-03 requires a DPA with Standard Contractual Clauses (SCCs), or DPF certification, for every processor **before the first EU/UK candidate**.

## Processors of candidate data (pilot and production)

| Service | Used for | Candidate data it receives | Location | Transfer cover to check | To do (owner) |
| --- | --- | --- | --- | --- | --- |
| Amazon Web Services: EC2 | The app host (API, worker, Postgres, Redis; C-43) and a separate Judge0 host (C-45), both running only in scheduled windows and the daily wake (C-47) | Everything the API and worker handle while processing: personal data, events, code, media while it is analysed | One US region us-east-1 (C-03) | AWS DPA (part of the AWS Service Terms, with SCCs); AWS DPF certification | Confirm the DPA applies to the account; record the region; check AWS's DPF entry |
| Amazon Web Services: S3 | Recordings, ID images, selfies, evidence, report PDFs, consent PDFs, backups | All stored media and documents | Same US region | As above | Same as above; bucket encryption, Block Public Access and versioning settings per ARC-05 |
| Amazon Web Services: database (Postgres in Docker on the EC2 app host, C-43; no RDS) | Postgres database, with backups and WAL archives in the encrypted backup bucket (C-48, C-49) | All structured candidate data | Same US region | As above | As above |
| Amazon Web Services: SES (C-31) | Invitation emails, OTP codes, the consent PDF copy, erasure notices | Name, email address, OTP codes, the signed consent PDF (attachment or link); the SES suppression list keeps bounced addresses | us-east-1 | Covered by the AWS DPA and DPF entry above | Owner sets up SES (domain verification, production access); see status.md B-05 |
| Amazon Web Services: CloudWatch (C-32) | Server logs and browser error reports (sent through our API and scrubbed); Session Manager session logs (C-50) | IP addresses, user agents, session references; never secrets, tokens, OTPs or media keys (CLAUDE.md). Session Manager logs are the exception: they hold whatever an administrator sees in a session, which can include database output with candidate data | us-east-1 | Covered by the AWS DPA and DPF entry above | Set the log group retention (OQ-9) |
| Amazon Web Services: Route 53 (C-52) | DNS for `assess.thebigbraintech.com` (its own hosted zone; the API host's record is updated on boot) | No candidate data in the records. Route 53 sees DNS lookups, which come from candidates' DNS resolvers rather than from candidates' devices, sometimes with a truncated client subnet (part of the candidate's IP address) | Global (AWS) | Covered by the AWS DPA and DPF entry above | Add the delegation NS record in the `thebigbraintech.com` zone by hand (C-52) |
| Amazon Web Services: Systems Manager Session Manager (C-50) | The only interactive access to the pilot instances; sessions are logged | Whatever an administrator views during a session; the session logs go to CloudWatch | us-east-1 | Covered by the AWS DPA and DPF entry above | Keep sessions to maintenance; set the session-log retention with OQ-9 |
| Cloudflare: Pages | Serving the web app and the static "test opens at" page to candidates and staff, at a custom subdomain of `assess.thebigbraintech.com` set by CNAME (C-52). Cloudflare is used for Pages only: no Cloudflare DNS and no Cloudflare API token on any server (C-52) | IP addresses and request metadata of every visitor; no candidate media (uploads go straight to S3); the invitation token wherever a link carries it in the URL path (today `/t/[token]`; the FSD change in #236 moves it to the URL fragment, which isn't sent to Cloudflare). The token alone doesn't open a test without the OTP | Global network | Cloudflare DPA with SCCs; Cloudflare DPF certification | Accept the Cloudflare DPA on the account; check the DPF entry |
| Applicant tracking system (webhooks and CSV export, FR-1003) [if used] | Receiving results | Candidate name and email, status, scores and verdict | Depends | The ATS vendor is the company's own processor; check its DPA and SCCs | List the ATS used, or confirm none for the pilot |

## Services that must not receive candidate data

These are listed so the boundary is explicit. If any of them starts receiving candidate data, it becomes a processor and needs a row above.

| Service | Used for | Why it is not a candidate-data processor | Check |
| --- | --- | --- | --- |
| Cloudflare R2, Supabase or Neon (staging) | Staging storage and database | Staging holds synthetic data only (D-10, D-11, CLAUDE.md) | Keep the rule; no real candidate on staging |
| GitHub (code, Actions, GHCR) | Source code, CI, container images | Holds no candidate data; tests use synthetic data | No production data or logs in CI artefacts |
| Secrets vault (GitHub Actions secrets, or Doppler; the pilot's runtime secrets are set by ADR 0017) | Deployment secrets | Holds credentials, not candidate data | Access limited to the owner (ADR 0009) |
| AI assistants used for reference solutions (D-20) | Generating reference solutions to questions | Receive question text only, never candidate code or data | Keep candidate submissions out of these tools |
| Judge0 CE | Running candidate code | Self-hosted on its own AWS instance (C-45), so not an outside processor | Covered by the AWS rows |
| Let's Encrypt (TLS certificates for the API host, as proposed for ADR 0017) | Issuing the API's TLS certificate | Receives only the hostname and the certificate key's public half, never candidate data | Keep the certificate request free of personal data |
| AWS EventBridge Scheduler and KMS (C-43, C-48) | Starting and stopping the instances; the S3 encryption key | Hold schedules and keys, not candidate data. A schedule's name or payload must not contain candidate names or emails | Covered by the AWS DPA; schedule names use ids only |
| Backup expiry function (AWS, owner-applied, ADR 0017 §5.3) | Deleting backups and WAL older than the C-55 rotation, and erasure-list entries older than the oldest kept backup | Lists object names, dates and versions and deletes them; it never reads backup contents. If erasure-list entries are named by candidate id, it sees those ids in the object names (ADR 0017 can name them by request id instead) | Its role can list and delete in the backup bucket only, with no GetObject; covered by the AWS DPA |
| SES receiving for the load-test mailbox (AWS, C-57) | Receiving mail sent to one dedicated test-only address into its own locked-down S3 bucket, emptied after each test run | Receives only synthetic test mail. The seeder can never read mail sent to real candidates | Covered by the AWS DPA; the bucket and the receipt rule accept only the test address |
| Face and detector models (AuraFace, MediaPipe, COCO-SSD, Silero VAD) | Identity check and detectors | They run on our servers or in the candidate's browser, with model files served from our own origin (ADR 0013), so no data goes to the model authors | Keep runtime downloads from third-party CDNs off |
| Web fonts and other front-end assets | Page display | Must be self-hosted (no runtime calls to font CDNs) so visitors' IP addresses don't go to third parties | Frontend confirms fonts are bundled at build time |

## Notes

1. **Sub-processors.** Each provider lists its own sub-processors. The owner should save the list as accepted, and note how the provider announces changes.
2. **Data collected directly from EU/UK candidates.** If Rysun Labs Inc. is established only in the US, data that an EU/UK candidate types into our site is collected directly by a US controller. Under EDPB Guidelines 05/2021 that collection is not a Chapter V "transfer", although the GDPR still applies to it (Art. 3(2), monitoring behaviour). The processor DPAs and SCCs above still cover onward processing. The DPIA (section 8) records this, together with the need for an EU and a UK representative (GDPR Art. 27; UK GDPR Art. 27) unless an exemption applies.
3. **Records of processing.** This register and the DPIA together serve as the Art. 30 record for CodeProctor.
