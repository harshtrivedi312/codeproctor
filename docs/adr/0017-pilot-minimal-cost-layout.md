# ADR 0017: Pilot minimal-cost layout (one scheduled instance, booked slots, no AWS staging)

| Field | Value |
| --- | --- |
| Status | **Proposed** 2026-10-06. The owner accepts or amends. "(owner decision C-43)" marks what docs/compliance/decisions.md C-43 (PR #228) already decides. "(architect detail)" marks what this ADR adds, which the owner must confirm. "**Not verified**" marks AWS prices and behaviour the architect could not confirm; section 15 says how each is checked. Owner questions are in section 14. |
| Author | architecture hub (task ARC-05, the AWS layout part) |
| Decides | The pilot's AWS layout under C-43: the one scheduled instance and what runs on it; when it starts and stops, and the self-stop conditions and hard ceiling; the daily maintenance wake; booked slots; backups and the restore drill; S3 and key choices; how releases reach the instance; what the owner applies and what CI may do; IP, DNS and TLS; the failure modes |
| Does not decide | The booking requirement text and the other FSD changes (queued in section 13 until the owner answers section 14); the Judge0 spike itself (ADR 0016); Cloudflare Pages CSP (R-08); the cookie domain (Q-44); the production layout (it stays as ADR 0001 says until the owner decides it) |
| Serves | NFR-02, NFR-03, NFR-04, NFR-05; FR-303, FR-304, FR-403, FR-704; BR-13; DEP-01, DEP-03 |
| Builds on | Owner decision C-43; ADR 0001 (TB-1..TB-5, C-4, ST-5, ST-6, ST-8, OI-5); ADR 0004 section 9 (retention, erasure, backup restore, 9.7); ADR 0009 (no staging or pilot credentials on developer machines, D-38); ADR 0013 (ingest close, the sweeps, the daily lost-job catcher); ADR 0016 (Judge0 host, co-located fallback) |
| Amends (on acceptance) | docs/architecture.md Deployment (staging and pilot rows); ARC-05 (decided here, except the items in "Does not decide"); ADR 0001 OI-5; ADR 0016 sections 1 and 3 and owner question 2; PA-07 / DEP-03 scope (section 12 gives the exact changes) |

## 1. Context

- C-43 replaces the earlier AWS design (D-57's multi-stack plan) and the Lightsail option with a minimal-cost pilot, target under $10 a month. All security, privacy and retention decisions stay unchanged (C-43).
- One x86 EC2 instance (about 2 vCPU / 8 GB) runs the API, worker, Judge0, Postgres and Redis in Docker Compose, sized for 5 concurrent candidates. No RDS, no NAT gateway, no load balancer. The instance runs only in scheduled test windows and review sessions (C-43).
- Candidates book a slot. An automated schedule starts the instance before each slot and stops it after the last session ends and its uploads are confirmed. Heavy analysis (audio, code similarity, face matching) is queued and runs after sessions end, in the same window (C-43).
- Staging is not on AWS. It stays local in Docker and on free tiers, with synthetic data (C-43; ADR 0009).
- Recordings go to S3, email to SES, logs to CloudWatch. The web front end stays on Cloudflare Pages and must show a clear "the test opens at ..." page while the instance is off (C-43).
- Backend A's template `infra/aws/github-oidc-roles.yaml` (branch `infra/dep01-oidc-roles`) already scopes a deploy role to the pilot. This ADR narrows what that role may do (section 7).

## 2. Decision summary

| # | Topic | Decision | Basis |
| --- | --- | --- | --- |
| 1 | Environments | Local (Docker, synthetic data) and the pilot. There is no AWS staging. Staging media stays on Cloudflare R2 and may use a Supabase or Neon free tier (ADR 0001 OI-5 as it stands); red-team and OWASP work (QA-02, TC-093) run against the local stack | C-43 |
| 2 | Compute | One x86 instance in us-east-1 (C-03), about 2 vCPU / 8 GB, a public subnet, an encrypted gp3 volume, no NAT, no load balancer, no RDS. Instance type and price are **Not verified** (section 10) | C-43 |
| 3 | Lifecycle | EventBridge Scheduler starts and stops it around booked slots (section 4). The host stops itself when idle (section 4.2). A host-independent hard ceiling stops it regardless (section 4.3) | C-43; mechanics: architect detail |
| 4 | Maintenance | A short daily wake runs retention, erasure, reminders and backups, if the owner accepts it (section 4.5, **owner question 4**) | C-43 open item 4 |
| 5 | Booking | The recruiter picks the slot when inviting (recommended). No always-on booking service (section 4.6, **owner question 3**) | C-43 open item 3 |
| 6 | Data | S3 buckets for recordings, backups and releases; encryption with one customer-managed key (recommended, **owner question 5**); Postgres backups by WAL archiving plus a dump at shutdown; a tested restore (section 5) | C-43; choices: architect detail |
| 7 | Deploy | The instance pulls a signed release manifest from S3 at boot and verifies it. CI never has a command path into the instance (section 6) | architect detail |
| 8 | Owner and CI | The owner applies the CloudFormation templates for data buckets, keys, roles, the instance and the schedule group. CI deploys the app only (section 7) | architect detail |
| 9 | IP and DNS | No Elastic IP. The instance updates one Route 53 record at boot with its instance role. Caddy gets its certificate with HTTP-01 (section 8) | architect detail |
| 10 | Judge0 | **Open.** Co-located as C-43 says, or on its own small instance as ADR 0016 recommends (section 9, **owner question 2**) | C-43 open item 2 |
| 11 | Identity face match | **Open.** Recommended live in the pre-test gate, so FR-403 and ADR 0002 CONSENTED to VERIFIED are unchanged (**owner question 1**) | C-43 open item 1 |

## 3. Layout

- **Instance.** Docker Compose runs `caddy`, `api`, `worker`, `judge0` (server and workers), `postgres` and `redis`. The Compose networks, ports and the Judge0 isolation are those of ADR 0016 (section 9 lists what changes when Judge0 is co-located).
- **Public surface.** Only Caddy listens: 443 (and 80 for the certificate challenge) from the internet. Redis, Postgres and Judge0 are never published (ADR 0016, ADR 0001 TB-5). The security group has no other inbound rule.
- **No interactive access.** No key pair and no SSM SendCommand (both are denied today). Logs go to CloudWatch. The break-glass path is to replace the instance from the owner-applied template and restore (section 5.4), not to log in. Whether the owner wants a read-only access path is **owner question 7**.
- **Instance role.** IMDSv2 only, with the hop limit set to 1 so containers cannot reach it. The role holds only: read and write on the media bucket prefix (ST-5), write on the backup bucket, read on the release bucket, the KMS key's use actions, `ses:SendEmail` from the pilot identity, `logs:PutLogEvents` on its log group, `route53:ChangeResourceRecordSets` on the one record (section 8), and, if the owner accepts booking at invite time, `scheduler:CreateSchedule` and `DeleteSchedule` in the slot schedule group with `iam:PassRole` for the one scheduler role (section 4.1). It holds no `iam:*`, no `s3:Delete*` on the backup or release buckets, and no `ec2:*`.
- **Storage.** One encrypted gp3 volume holds Postgres, Redis (append-only file is off; Redis holds only rebuildable state, ADR 0013 and the `noeviction` note in `.env.example`), Caddy's certificates and Docker's data. The volume persists while the instance is stopped. Its size is **Not verified** (section 10).
- **Web.** Cloudflare Pages is unchanged. While the instance is off the pages load and API calls fail; section 4.6 says what the candidate sees.

## 4. Lifecycle, schedule and booking

### 4.1 Start and stop schedules

- **Slot schedule.** For each booked slot (or group of overlapping slots) the app creates two one-time EventBridge Scheduler schedules in the group `codeproctor-pilot-slots`: a start at slot start minus 20 minutes, and a ceiling stop (4.3). Schedule names carry a slot id only, never a candidate, invitation or email.
- **Scheduler role.** The target is the universal `ec2:StartInstances` and `ec2:StopInstances`, through one execution role limited to the one instance's ARN. The app may create schedules only in its own group and may pass only that role.
- **Retries and alarm.** The start schedule uses a retry policy and a dead-letter queue. A message in the queue raises a CloudWatch alarm and an SNS email to the owner, so a failed start is known before the candidates arrive (section 11).
- **Monthly budget guard.** The app refuses a booking that would take the booked instance-hours of the month above a configured limit (default set from the section 10 estimate), so booking cannot overrun the budget (architect detail).

### 4.2 Self-stop

A host timer checks every minute. It stops the machine with `shutdown -h now` (the instance's shutdown behaviour is `stop`, so no `ec2:StopInstances` permission is needed on the instance role) when all of these hold, continuously for 10 minutes:

1. No session is IN_PROGRESS, PAUSED, or in the VERIFIED-to-start window of a booked slot that has not ended.
2. No booked slot is open or starts within the next 30 minutes. (A later slot is covered by its own start schedule.)
3. No upload is unconfirmed: no session has open ingest (ADR 0013 ingest close not yet done) or a pending storage sweep, and every `media_chunks` row of a finished session is confirmed.
4. The BullMQ queues are empty: no waiting or active job, and no delayed job due within 30 minutes. Later delayed jobs are lost with the Redis state and re-created by the daily lost-delayed-job catcher at the next start (ADR 0013 section 5.11, line "A lost delayed job"), which is why Redis needs no persistence.
5. Today's maintenance work, if this start included it, is done (4.5).
6. A shutdown backup has been started: the stop is a sequence, not a power cut (5.2).

The check is a function in `apps/api` that exposes only counts and booleans on a loopback-only route; the timer holds no credentials.

### 4.3 Hard ceiling

- **Per slot.** The ceiling stop is the end of the latest slot of the window plus 2 hours. A stop by the ceiling raises an alert (a session was still running, a queue was not empty, or a backup did not finish).
- **Per maintenance wake.** 60 minutes.
- **Why the host cannot veto it.** The ceiling is an EventBridge schedule, so a hung host, a stuck queue or a compromised container cannot keep the instance (and the bill) running. A stop sends the instance a normal ACPI shutdown: Docker stops the containers, Postgres shuts down cleanly, the shutdown dump runs first if time allows.
- **Safe by design.** Every job is idempotent and resumes at the next start (ADR 0004 sections 9.2 and 9.7, ADR 0013 sections 5.7 and 5.11). A session cut off by the ceiling is the same case as a host crash: the heartbeat watchdog and the close-section sweeps handle it at the next start. The ceiling is for failures, not for normal operation: slots are sized so that the self-stop comes first.

### 4.4 Heavy analysis

Audio checks, code similarity, AI-likeness and the face re-checks that are not part of the pre-test gate run as queued jobs after the last session of the window ends, inside the same window and below the ceiling. They never share the window with a live test at a priority above it (the queue priorities of ADR 0013 section 5.7 stay). A window must be sized for its analysis as well as its sessions (section 10). The review UI shows "analysis pending" (ADR 0005 AI-3) until the jobs finish; no session reaches a verdict before its review (C-28).

### 4.5 Daily maintenance wake (owner question 4)

- **What needs a running instance.** The retention tiers, R-9 and R-10, the erasure runs and their retries, the reminder emails, the lost-job catcher and the backup verification (ADR 0004 sections 9.2 to 9.5 and 9.7). All of them are idempotent and already retried the next day, so a missed wake only delays them.
- **Cost.** One 20-minute wake a day is about 10 instance-hours a month, a large share of a budget this small (section 10).
- **Recommendation.** A 20-minute wake once a day at a fixed time, which also serves as the recruiter and reviewer window of 4.6 (so it is not an extra start). The owner may instead choose a wake only on days that have a slot, plus one weekly maintenance wake; the cost is that an erasure request or a retention run can wait up to a week (the erasure limits of ADR 0004 section 9.5 and C-27 must still hold: the owner checks the weekly wake against them, and if it does not fit, the daily wake stays).

### 4.6 Booking, staff windows and the closed-instance page (owner question 3)

- **Option A (recommended).** The recruiter picks the slot when creating the invitation. The invitation carries the slot, the instance is running when a recruiter works (a staff window, 4.5), and the schedules of 4.1 are created at that moment. No second data store and no always-on service. The candidate cannot self-book. A reschedule request goes to the recruiter by email, who changes the slot in the next window.
- **Option B.** An always-on booking service (for example a Cloudflare Worker with a small store, or a Lambda with a table) holds the free slots and creates the schedules, so candidates self-book while the instance is off. It adds a second data store with candidate data, its own authentication and retention rules, and a second place for the privacy review. It is the only way to let candidates book at any time.
- **Staff access while off.** Recruiters and reviewers can use the app only while the instance runs: in the daily window, in a slot window, or in a review window a reviewer requests (a reviewer request creates a schedule like a slot, through the same app route, in a window that is already running). A staff user cannot start the instance by hand: that needs a path into AWS that this ADR does not create.
- **The closed-instance page.** The invitation link opens a Cloudflare Pages page. If the API does not answer, the page says that the test is not open yet and that the time is in the invitation email. The page holds no candidate data, no token and no time: putting a time in the URL would put invitation data in a query string, and storing it for the page would be an always-on store (Option B). The email, sent by the app while it runs, states the slot's start and end in the candidate's time zone and in UTC.
- **Reminders.** Sent by the app in the daily window for the slots of the next 48 hours, and at invitation time. A reminder sent earlier than 24 hours before a slot depends on a window existing then.

## 5. Data: S3, encryption, backups, restore

### 5.1 Buckets

Three buckets in us-east-1, created by the owner's template, each with Block Public Access, a TLS-only bucket policy, versioning off (or noncurrent versions expired within 1 day, ST-8 and ADR 0004 section 9.2), and no access from any role other than the ones named here:

| Bucket | Content | Written by | Read by | Lifecycle |
| --- | --- | --- | --- | --- |
| media | Recordings, identity images, evidence, reports, consent PDFs (ADR 0004 prefixes) | instance role (and presigned PUT by candidates) | instance role | By the retention jobs and the lifecycle rules agreed in C-43 |
| backups | WAL archive and nightly or shutdown dumps | instance role (write only) | the owner's restore role only | Expire after 35 days (5.3) |
| releases | The signed release manifest (section 6) | the CI deploy role (write on one prefix) | instance role | Keep the last 10 manifests |

### 5.2 Encryption (owner question 5)

- **Recommended: one customer-managed KMS key (SSE-KMS) for media and backups**, with S3 Bucket Keys on. The key policy lets the owner administer it, lets the instance role use it (`GenerateDataKey`, `Decrypt`), lets the owner's restore role decrypt, and gives CI no access. Cost: about $1 a month plus requests (**Not verified**). It adds a second control on candidate recordings, so a mistake in a bucket policy does not by itself expose them; every decrypt is in CloudTrail; and revoking the key stops reads. Presigned PUT works with a bucket default of SSE-KMS (the signing role needs the key actions, ST-6).
- **Alternative: SSE-S3.** No cost and no key to manage, and every new object is already AES-256 encrypted (ST-6). Access then rests on the bucket policy and the role only.
- The EBS volume uses the account's default EBS key (no extra cost).

### 5.3 Backups

- **Two kinds, both to the backups bucket.** (a) Continuous WAL archiving with a tool such as pgBackRest or WAL-G (open source), with a weekly base backup in the daily window; (b) a logical `pg_dump` taken during shutdown (4.2 step 6), and before any schema migration at boot (section 6).
- **Why both.** WAL gives point-in-time recovery for a crash while running. The dump is portable across Postgres versions and is the one the restore drill and ADR 0004 section 9.7 use.
- **Nothing is written while the instance is off,** so the recovery point after a stop is the shutdown backup; after a crash while running it is the last archived WAL (the archive timeout is 60 seconds).
- **Retention of backups: 35 days.** A backup contains candidate rows that an erasure removed after it was taken. ADR 0004 section 9.7 re-applies erasures after a restore from the erasure list kept outside the database backup, so a restore never resurrects erased data, and the 35-day limit means an erased person's rows leave the backups within 35 days (the consent and privacy text must say that backups age out within 35 days; Delivery Lead to confirm with the DPIA). The erasure list itself is kept outside the dump (ADR 0004 section 9.7) and holds the minimum needed to re-apply.
- **Dumps hold biometric-adjacent data only as the schema holds it** (scores, no embeddings, ADR 0004 C-18). Recordings are not in the dump (they are objects in the media bucket).

### 5.4 Restore drill

- **When.** Before the pilot opens to real candidates (a gate for B-05), then every quarter and after any change to the backup tooling.
- **How.** The owner applies a throwaway instance template, restores the latest base backup and WAL, and separately the latest dump, into it, runs the application's migration check and a read-only smoke test, re-applies the erasure list, and destroys the instance. It runs on AWS, never on a developer machine (ADR 0009).
- **What it must prove.** The restore works from the archive alone; the time to restore is recorded and below the owner's target; an erased candidate does not reappear after re-application; the restored database passes `verify-schema`.

## 6. Deploy mechanism

SSM SendCommand and key pairs are denied today. Two ways remain.

| Option | How | For | Against |
| --- | --- | --- | --- |
| **a. The instance pulls a signed release at boot (recommended)** | CI builds the images, pushes them to a registry, and writes a release manifest (image digests, the migration list) to the releases bucket, signed with cosign keyless signing whose identity is pinned to this repository's `pilot` environment workflow. At boot a systemd unit verifies the signature and the pinned identity, pulls the images by digest, takes a pre-migration dump if the manifest carries migrations, runs `prisma migrate deploy`, then starts Compose | CI has no command path into the data host; no inbound access; no SSM; fits a machine that is mostly off, because a release takes effect at the next start; the GitHub `pilot` environment's required reviewers are the human gate (the OIDC role trusts only that environment) | A release is live only after the next start; an urgent fix needs the owner to start the instance; signature verification needs the host to reach the signing transparency service at boot (**Not verified**, section 15) |
| b. A narrow SendCommand | CI runs one SSM document on the one instance | An immediate deploy to a running instance | Needs the SSM agent and its role on the data host, gives CI command execution next to the data, and reverses today's denial |

- **Recommendation: a.** A compromised CI job can then at worst publish a manifest the host refuses to run (the signature identity is pinned), not run a command on the host.
- **Mutable tags are not used.** The manifest names digests.
- **Rollback.** CI writes the previous manifest back as the current one; the next start applies it. A migration that cannot be undone needs the pre-migration dump (5.3) and the owner.
- **What is baked in, owner-applied.** The signing identity to trust, the releases bucket name and the registry. They are set in the instance template, never fetched from the release.
- **Secrets.** No secret in user-data or in the manifest (ADR 0016 section 3.5). The instance reads them from Secrets Manager or SSM Parameter Store with its role at boot. Which store is cheaper at this size is **Not verified**.

## 7. Owner and CI split

| Who | What |
| --- | --- |
| **Owner (applies the templates)** | The GitHub OIDC provider and the deploy role; the three buckets and their policies; the KMS key and its policy; the instance, its security group, role and profile, volume and the shutdown behaviour; the Route 53 zone and record; the schedule group, the scheduler execution role and the DLQ with its alarm; Budgets and the SNS email; the restore role and the restore-drill template; the SES identity (ST-5, `.env.example`) |
| **CI (`codeproctor-pilot-deploy`, trusted only from `environment:pilot`)** | Push images to the registry; write the release manifest to the releases bucket prefix. Nothing else |
| **The app, on the instance** | Presign uploads; create and delete slot schedules in its own group; update its one DNS record; send email; write logs |

- **Consequence for Backend A's template.** The deploy role in `github-oidc-roles.yaml` is broader (S3, KMS, Secrets Manager, Logs, alarms, SSM, SES, Budgets and a permissions boundary for roles it creates). Under this ADR the role does not create or change infrastructure: it needs only the registry push and `s3:PutObject` on the manifest prefix. If the owner keeps Terraform (owner question 6) the broader role stays but is applied only to stacks that exclude data, keys, the instance and the scheduler. I will review that template against this ADR when its PR is opened.
- **Never in CI:** data buckets, KMS, the instance, the role of the instance, `iam:*` beyond the boundary, `ec2:*`, `scheduler:*`.

## 8. IP, DNS and TLS

- **No Elastic IP.** Since 2024 AWS charges for every public IPv4 address (about $0.005 an hour, **Not verified**). An Elastic IP on a stopped instance is charged all month; an auto-assigned address costs only while running.
- **DNS.** A Route 53 hosted zone for one delegated subdomain (about $0.50 a month) holds the API record. At boot a unit upserts the record with the instance's current public IP, using the instance role limited to that record, so no external secret is needed. The record's TTL is 60 seconds.
- **TLS.** Caddy obtains its certificate with HTTP-01 and keeps it on the volume. The first start after a new volume has the usual issuance delay.
- **Alternative: Cloudflare Tunnel.** It removes the public address and the inbound ports, but candidate traffic would pass through Cloudflare's network, which is a processor question for processors.md, and the tunnel token is a long-lived secret on the host. Not recommended unless the owner prefers it.

## 9. Security consequences (Judge0 co-located, owner question 2)

- **The risk.** Judge0 runs untrusted candidate code in privileged containers (TB-4, ADR 0016). On the same host as Postgres, the secrets and the instance role, a sandbox escape reaches the whole database, every recording the role can read, and the schedule role. ADR 0016's dedicated host exists for this reason.
- **Mitigations if it stays co-located** (the fallback in ADR 0016): the Judge0 workers on an `internal: true` network with no route out and no route to IMDS; IMDSv2 with hop limit 1; the iptables rule in `DOCKER-USER` that drops traffic to 169.254.169.254 and to the other Compose networks from the Judge0 network; the instance role kept to the list in section 3; no secret in the Judge0 environment; the CPU, memory and PID limits of ADR 0016; patching by rebuilding the image. They reduce the risk; they do not make an escape harmless.
- **Dedicated small instance.** A second instance (a smaller x86 type) with no instance role, started and stopped with the main one by the same schedules, about $1 to $3 more a month (**Not verified**). TLS and the allow-list of ADR 0016 apply unchanged.
- **Recommendation.** Keep the dedicated Judge0 instance if the budget allows, and accept the co-located layout only with the owner's written acceptance of the residual risk (the same pattern as ADR 0013 control 0). The load test (section 15) shows whether 8 GB is enough for both layouts.
- **Other co-location effects.** One host means one failure domain: a full volume, a stuck container or a bad release stops everything. The self-stop sequence (4.2) and the ceiling (4.3) bound the damage.

## 10. Cost estimate (**Not verified**; the owner checks it with the AWS pricing calculator)

The figures are the architect's estimates from list prices, for a 2 vCPU / 8 GB x86 on-demand instance (about $0.08 to $0.10 an hour). They show how little room the $10 target leaves, not a quote.

| Item | Basis | Per month |
| --- | --- | --- |
| Compute | about 50 instance-hours (slots, analysis and the daily window together) | $4 to $5 |
| EBS gp3, 30 GB, kept while stopped | storage only | about $2.50 |
| Route 53 zone and the public IPv4 while running | fixed | about $0.50 and under $1 |
| KMS customer-managed key (5.2) | fixed | about $1 |
| S3 (recordings, backups, releases) | depends on volume and the lifecycle | $1 to $2 for a small pilot |
| SES, CloudWatch logs (14-day retention, few logs), Scheduler, SNS | small | under $1 |

The total is at or just above $10 when the KMS key, a dedicated Judge0 instance or a daily wake is added. The hours are the lever: the monthly budget guard (4.1) and the Budgets alert at 80% make the limit enforced rather than hoped for. Which items the owner trades for the target is the content of owner questions 2, 4 and 5.

## 11. Failure modes

| Failure | Effect | Handling |
| --- | --- | --- |
| The start schedule fails or the capacity is unavailable | The slot cannot open | Retry policy, the DLQ alarm and the owner's email; the candidate sees the closed-instance page; the recruiter reschedules. The candidate's time is not consumed, because the session has not started |
| The host hangs or loops | Cost and risk | The ceiling stop (4.3) and the Budgets alert |
| The ceiling stops the instance during a session | An interruption | The same as a crash: resume (ADR 0002 L-1..L-5), and the sweeps at the next start; an alert |
| A release is bad | The app does not start | The unit refuses an unsigned manifest; a bad signed one is rolled back by writing the previous manifest and starting the instance |
| A volume or instance is lost | Data since the last backup | Restore (5.4); nothing was written while off, so the loss is bounded by the last archived WAL |
| A candidate's session spans a stop | Not possible by design | Self-stop condition 1 forbids it; the ceiling is the only way, and it alerts |
| DNS lags after a start | A slow first connection | TTL 60 s and the 20-minute lead before the slot |

## 12. Updates to other documents (on acceptance)

- **docs/architecture.md, Deployment.** Staging row: "Local Docker Compose with synthetic data; free-tier Supabase or Neon allowed; media on Cloudflare R2 (C-43). There is no AWS staging." Pilot row: "One scheduled x86 EC2 instance running Docker Compose (api, worker, Judge0, Postgres, Redis, Caddy), started and stopped around booked slots (ADR 0017); real candidate data; recordings in AWS S3; web on Cloudflare Pages." Production row: unchanged until the owner decides it.
- **ARC-05.** Decided here: Postgres on the instance (no RDS), S3 settings (5.1, 5.2), backups (5.3), the deploy mechanism, DNS and the IP approach. Still open: Cloudflare Pages CSP (R-08), the cookie domain (Q-44), the vault choice (6, secrets).
- **ADR 0001 OI-5.** "Decided (D-11, C-43, ADR 0017): the pilot runs on one scheduled instance with Postgres on it; S3 settings as ADR 0017 section 5; backups to S3; no AWS staging. Still open: the instance type and OS image (spike), production layout." ST-6 is decided by 5.2.
- **ADR 0016.** Section 1 and row 3 of section 2: the pilot's Judge0 host is the co-located or small dedicated instance of ADR 0017 section 9, per the owner's answer to question 2. Row 4 (staging): "no AWS staging; Judge0 runs in the local stack". Owner question 2 is answered by C-43.
- **PA-07 / DEP-03.** Scope becomes "the pilot instance, buckets, key, schedule group and DNS as in ADR 0017"; DEP-01 becomes local and free-tier staging (C-43).
- **processors.md** (Delivery Lead): Route 53, EventBridge Scheduler, KMS and SNS as AWS sub-services of the same processor; no new third party unless Option B or a tunnel is chosen.

## 13. FSD changes queued (not drafted until the owner answers section 14)

- FR-303 and FR-304: the invitation window becomes a booked slot.
- A new requirement: book, reschedule and cancel a slot, and the schedule that recruiters and reviewers see, including a reviewer's request for a review window.
- NFR-02: 5 concurrent candidates (the 200 concurrent target moves to production).
- NFR-03: availability applies to the scheduled instance and its windows.
- FR-403: depends on owner question 1.
- FR-704 and NFR-05: no change expected; the backup retention of 5.3 is added to the retention text.
- ADR 0002 section 1 (timing windows) and TC cases for the closed-instance page and the schedule.

## 14. Open owner questions

1. **Identity face match, live or deferred (FR-403).** Recommended: live, so FR-403 and ADR 0002 CONSENTED to VERIFIED are unchanged, and only audio and similarity analysis wait until after the session. Deferring it makes the pre-test gate weaker than "security decisions unchanged" allows (C-43).
2. **Judge0 co-located or on a small dedicated instance (section 9).** Recommended: dedicated, about $1 to $3 more a month. Co-located needs the owner's written acceptance of the sandbox-escape risk.
3. **Booking while the instance is off (4.6).** Recommended: the recruiter picks the slot at invitation (Option A). Candidates cannot self-book while it is off unless Option B's always-on service is accepted.
4. **The daily maintenance wake (4.5).** Recommended: one 20-minute wake a day, which doubles as the staff window. The alternative is wakes only on slot days plus a weekly one, which delays erasure and retention by up to a week.
5. **S3 encryption: one customer-managed key or SSE-S3 (5.2).** Recommended: the key, about $1 a month, because of the extra control on recordings.
6. **The CI plan role and Terraform state: keep or drop (7).** Recommended: drop both for the pilot. With the instance, buckets and keys applied by the owner and CI limited to the registry push and the manifest, there is little for a plan role to plan.
7. **Interactive access (3).** Recommended: none for the pilot. The alternative is an Instance Connect Endpoint with a narrow policy, which re-opens the denial of key pairs and SSM in a different form.
8. **Release gate (6).** Recommended: the GitHub `pilot` environment's required reviewers approve each release. Confirm who approves.

## 15. Verification and spike (before the pilot)

- **Load test (C-43):** 5 concurrent candidates through TC-090 and TC-091 on the chosen instance size, co-located and dedicated, with the face model running live. The pass criteria are those of NFR-01 and ADR 0016 section 11. Memory headroom at 8 GB is **Not verified**.
- **Start and stop:** a rehearsal of start, a 3-session window, analysis, self-stop and a ceiling stop, measuring the start-to-ready time, which sets the 20-minute lead.
- **Backup and restore:** the drill of 5.4.
- **Deploy:** an unsigned manifest is refused, a signed one runs, a rollback works, and the host reaches the signing service at boot.
- **Isolation:** the IMDS block from the Judge0 network, the instance role's effective permissions (an IAM policy simulation) and the absence of any inbound rule other than 80 and 443.
- **Prices and limits:** the section 10 estimate against the AWS calculator; the public IPv4 charge; the Scheduler and KMS prices.
- **Closed-instance page:** the invitation link while the instance is off shows the page and no data.
