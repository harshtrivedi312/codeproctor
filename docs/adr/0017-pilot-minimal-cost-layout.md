# ADR 0017: Pilot minimal-cost layout (two scheduled instances, recruiter-picked slots, no AWS staging)

| Field | Value |
| --- | --- |
| Status | **Proposed** 2026-10-06. The owner accepts or amends. "(owner decision C-43..C-48, C-49)" marks what docs/compliance/decisions.md already decides (PRs #228 and #232). "(architect detail)" marks what this ADR adds, which the owner must confirm. "**Not verified**" marks AWS prices and behaviour the architect could not confirm; section 15 says how each is checked. Section 14 lists what is still open. |
| Author | architecture hub (task ARC-05, the AWS layout part) |
| Decides | The pilot's AWS layout under C-43: the two scheduled instances (the main instance and a small Judge0 instance) and what runs on them; when they start and stop, the self-stop conditions and the hard ceiling; the daily maintenance wake; recruiter-picked slots and the static page; backups and the restore drill; S3 and key settings; how releases reach the instance; what the owner applies and what CI may do; IP, DNS and TLS; the failure modes |
| Does not decide | The FSD wording (section 13 lists the changes; they are in the FSD PR); the Judge0 spike itself (ADR 0016); Cloudflare Pages CSP (R-08); the cookie domain (Q-44); the production layout (it stays as ADR 0001 says until the owner decides it) |
| Serves | NFR-02, NFR-03, NFR-04, NFR-05; FR-303, FR-304, FR-403, FR-704; BR-13; DEP-01, DEP-03 |
| Builds on | Owner decisions C-43..C-48 and C-49; ADR 0001 (TB-1..TB-5, C-4, ST-5, ST-6, ST-8, OI-5); ADR 0004 section 9 (retention, erasure, backup restore, 9.7); ADR 0009 (no staging or pilot credentials on developer machines, D-38); ADR 0013 (ingest close, the sweeps, the daily lost-job catcher); ADR 0016 (Judge0 host) |
| Amends (on acceptance) | docs/architecture.md Deployment (staging and pilot rows); ARC-05 (decided here, except the items in "Does not decide"); ADR 0001 OI-5; ADR 0016 sections 1 and 3 and owner question 1 (option B confirmed by C-45); PA-07 / DEP-03 scope (section 12 gives the exact changes) |

## 1. Context

- C-43 replaces the earlier AWS design (D-57's multi-stack plan) and the Lightsail option with a minimal-cost pilot. All security, privacy and retention decisions stay unchanged.
- One x86 EC2 instance (m7i.large, non-burstable, 2 vCPU / 8 GB; C-49) runs the API, worker, Postgres and Redis in Docker Compose, sized for 5 concurrent candidates. Judge0 runs on its own small dedicated instance (C-45). No RDS, no NAT gateway, no load balancer. The instances run only in scheduled test windows and review sessions (C-43).
- The recruiter picks the slot when inviting (C-46). An automated schedule starts the instances 45 minutes before each slot, with a health check and an alarm (C-49), and stops them after the last session ends and its uploads are confirmed. The identity face match stays live before the test (C-44). Audio checks, code similarity and other heavy analysis are queued and run after the sessions end, in the same window (C-43, C-44).
- A daily maintenance wake of about 15 minutes runs retention, erasure, backups and reminders (C-47). One customer-managed KMS key with S3 Bucket Keys encrypts the data buckets (C-48). DNS is updated through the Cloudflare API on boot, with no Elastic IP (C-49).
- The accepted budget is about $12 a month. The 5-candidate load test on the real instances is the gate before the first candidate (C-49).
- Staging is not on AWS. It stays local in Docker and on free tiers, with synthetic data (C-43; ADR 0009).
- Recordings go to S3, email to SES, logs to CloudWatch. The web front end stays on Cloudflare Pages and shows a clear "the test opens at ..." page while the instances are off (C-43, C-46).
- Backend A's template `infra/aws/github-oidc-roles.yaml` (branch `infra/dep01-oidc-roles`) already scopes a deploy role to the pilot. This ADR narrows what that role may do (section 7).

## 2. Decision summary

| # | Topic | Decision | Basis |
| --- | --- | --- | --- |
| 1 | Environments | Local (Docker, synthetic data) and the pilot. There is no AWS staging. Staging media stays on Cloudflare R2 and may use a Supabase or Neon free tier (ADR 0001 OI-5 as it stands); red-team and OWASP work (QA-02, TC-093) run against the local stack | C-43 |
| 2 | Compute | The main instance: m7i.large in us-east-1 (C-03), a public subnet, an encrypted gp3 volume. The Judge0 instance: a small x86 instance with a minimal role (section 3). Prices are **Not verified** (section 10) | C-49, C-45 |
| 3 | Lifecycle | EventBridge Scheduler starts both instances 45 minutes before a booked slot and stops them at a hard ceiling (section 4). The main host stops itself when idle (4.2); the Judge0 host stops itself when the main host stops pinging it | C-49; mechanics: architect detail |
| 4 | Maintenance | A daily wake of about 15 minutes, with an alarm to the owner if it does not run (4.5) | C-47 |
| 5 | Booking | The recruiter picks the slot when inviting. A static "opens at" page on Cloudflare Pages. No booking service (4.6) | C-46 |
| 6 | Data | Three S3 buckets (recordings and ID images, backups, releases); one customer-managed KMS key with S3 Bucket Keys for the data buckets; WAL archiving plus a dump at shutdown; a restore drill before the pilot (section 5) | C-48, C-49 |
| 7 | Deploy | The main instance pulls a signed release manifest from S3 at boot and verifies it. CI never has a command path into either instance (section 6) | architect detail |
| 8 | Owner and CI | The owner applies the CloudFormation templates for buckets, the key, roles, the instances and the schedule group. CI deploys the app only (section 7) | architect detail |
| 9 | IP and DNS | No Elastic IP. The main instance updates its DNS record through the Cloudflare API at boot. Caddy gets its certificate with HTTP-01 (section 8) | C-49 |
| 10 | Judge0 | A dedicated small instance, started and stopped with the main one, with no app secrets and no network access to Postgres, Redis or the media buckets (section 9) | C-45 |
| 11 | Identity face match | Live in the pre-test gate; FR-403 and ADR 0002 CONSENTED to VERIFIED are unchanged. Only audio, similarity and other heavy analysis wait until after the session (4.4) | C-44 |

## 3. Layout

- **Main instance.** Docker Compose runs `caddy`, `api`, `worker`, `postgres` and `redis`.
- **Judge0 instance.** It runs the Judge0 stack of ADR 0016 (server, workers and the TLS terminator) with that ADR's Compose networks, ports and isolation. Section 9 lists what C-45 requires of it.
- **S3 access of the main instance.** The VPC has an S3 gateway endpoint (free), so the worker's egress rule of ADR 0014 ("the S3 endpoint") has a path without a NAT gateway. The two instances are in subnets with separate route tables, and only the main instance's has the endpoint. The endpoint policy names the media, backups and releases buckets, and the ECR layer bucket if ECR is used (**Not verified**), because a gateway endpoint carries all of that subnet's S3 traffic, including the backup writes, the release reads and the image layers.
- **Public surface.** On the main instance only Caddy listens: 443, and 80 for the certificate challenge, from the internet. Redis, Postgres and the Judge0 server are never published (ADR 0016, ADR 0001 TB-5). The security groups have no other inbound rule, except the one rule of section 9 on the Judge0 instance.
- **No interactive access.** No key pair and no SSM SendCommand (both are denied today). Logs go to CloudWatch. The break-glass path is to replace the instance from the owner-applied template and restore (5.4), not to log in. Whether the owner wants a read-only access path is open (section 14).
- **Main instance role.** IMDSv2 only, with the hop limit set to 2, because the `api` container sits behind Docker's bridge and needs the role's credentials. `api` has its own egress network that no other container joins, and that network is its default route (Docker's gateway-priority setting, **Not verified**). A `DOCKER-USER` rule drops traffic to 169.254.169.254 from every source except `api`'s fixed address on that egress network. The rule matches that address, not a whole bridge, because `api` shares its other networks with `worker`, `caddy`, `postgres` and `redis`. So `worker` (which parses untrusted candidate media and images and, per ADR 0014 D3, holds no S3 credentials and reads only through presigned GETs) and `caddy` (which faces the internet) cannot reach the role. The rule is in the isolation test of section 15. The role holds only: read, write and `s3:DeleteObject` on the media bucket (ST-5; retention, erasure and the sweeps delete objects), put, get and list but no delete on the backup bucket (a bucket policy denies delete except the lifecycle rule, and denies overwriting an existing key; **Not verified**, section 15), read on the release bucket, pull of the images (the images hold no secret: from ECR with this role or from a registry the host can read without a stored credential), the key's use actions, `ses:SendEmail` from the pilot identity, `logs:PutLogEvents` on its log group, `secretsmanager:GetSecretValue` on its own secrets (including the Cloudflare DNS token, section 8), and the schedule actions of 4.1, with `iam:PassRole` for the three scheduler roles of 4.1 only (start-only, stop-only and the probe's invoke-only role), with the condition `iam:PassedToService` set to `scheduler.amazonaws.com`. It holds no `iam:*`, no `s3:Delete*` on the backup or release buckets, and no `ec2:*`.
- **Judge0 instance role.** A minimal one, for what the instance needs to start: `secretsmanager:GetSecretValue` on its own three secrets (`AUTHN_TOKEN`, `AUTHZ_TOKEN` and its TLS leaf key), `s3:GetObject` on its own manifest prefix of the releases bucket, and image pull (ECR, or a public registry with no credential). It holds nothing else: no data bucket, no KMS, no scheduler, no `ec2:*`. Its secrets use the default Secrets Manager key, not the data key. It reaches Secrets Manager, S3 and the registry through a public address (an auto-assigned IPv4 while it runs, counted in section 10) with a security group that allows 443 outbound to the S3 managed prefix list and to the AWS ranges for Secrets Manager and the registry, or to any address if those ranges cannot be listed (a security group filters by address; **Not verified**), and to what ADR 0016 section 3 allows, which this ADR adds to that allowlist. The sandbox containers still have no route out (the `internal: true` network of ADR 0016 and the `DOCKER-USER` rule), so this egress is open only to host processes. A sandbox escape would therefore have an outbound channel; that is a residual risk, recorded here for the owner to confirm (C-45 chose the dedicated instance but did not discuss this egress); interface endpoints are not used because their fixed monthly cost would put the budget at risk (**Not verified**). Its hop limit is 1 and a `DOCKER-USER` rule drops traffic from the Judge0 networks to 169.254.169.254, so sandboxed code cannot use the role (section 9). No user-data holds a secret (ADR 0016 section 3.5).
- **Storage.** One encrypted gp3 volume on the main instance holds Postgres, Redis (append-only file on, `appendfsync everysec`, and `noeviction`, as DL-24 and `.env.example` require: Redis holds the lockout counters, the token-revocation markers and the TOTP replay store, so a stop must not wipe it), Caddy's certificates and Docker's data. It persists while the instance is stopped. Its size is **Not verified** (section 10). The Judge0 instance has a small volume with no candidate data beyond what a run holds until deleted (ADR 0016).
- **Web.** Cloudflare Pages is unchanged. While the instances are off the pages load and API calls fail; 4.6 says what the candidate sees.

## 4. Lifecycle, schedule and booking

### 4.1 Start and stop schedules

- **Slot schedule.** When a recruiter invites with a slot, the app creates EventBridge Scheduler schedules in the group `codeproctor-pilot-slots`: a start 45 minutes before the slot (C-49) and a health probe (below), and, in the ceiling group, a ceiling stop (4.3). Overlapping slots share one window. The schedules use `ActionAfterCompletion: DELETE`. Schedule names carry a slot id only, never a candidate, invitation or email.
- **Scheduler role.** The targets are the universal `ec2:StartInstances` and `ec2:StopInstances`, through execution roles limited to the ARNs of the two instances: a start-only role for the start group and a stop-only role for the ceiling group (and a third, invoke-only role for the probe, below) (**Not verified**: the Scheduler retry and dead-letter behaviour below). The app may create and delete schedules only in the start group, with the start-only role, and create them only in the ceiling group, with the stop-only role (4.3), and may pass only those two roles and the probe role below. The trust policy of each role carries an `aws:SourceArn` condition that binds the start-only role to the group `codeproctor-pilot-slots` and the stop-only role to the group `codeproctor-pilot-ceiling` (**Not verified**), so a schedule created in the ceiling group can never start an instance.
- **Health check and alarm (C-49).** A schedule 35 minutes before the slot (5 minutes before the gate opens, 10 minutes after the instances start) calls a small probe (an owner-applied Lambda function or equivalent) that requests the main instance's `/health`, which reports as booleans only whether the Judge0 instance answers its health check (the Judge0 instance has no public name and accepts traffic only from the main instance, so the probe cannot reach it directly; **Not verified**). The probe schedule is created in the slots group with a third role, invoke-only on the one probe function and bound to the slots group by `aws:SourceArn`; it is the third role the app may pass (4.1, section 3). A failure publishes to an SNS topic that emails the owner, so a failed start is known while there is still time to act (section 11). The start schedule also has a retry policy and a dead-letter queue with the same alarm.
- **Monthly budget guard.** The app refuses an invitation whose slot would take the booked instance-hours of the month above a configured limit (set from section 10), so booking cannot overrun the budget (architect detail).
- **Reviewer windows.** A reviewer's request for a review window creates a schedule through the same route while the instance is running (for example in the daily window); nothing outside the running app can create one.

### 4.2 Self-stop

- **Main host.** A host timer checks every minute. It stops the machine with `shutdown -h now` (the instance's shutdown behaviour is `stop`, so no `ec2:StopInstances` permission is needed on the instance role) when all of these hold, continuously for 10 minutes:
  1. No session is IN_PROGRESS or PAUSED, no slot window is open (from the gate opening to the end of the window), and none opens within the next 60 minutes, which covers the start lead and the warm-up (a later slot has its own start schedule), and no staff user has made an authenticated request in the last 15 minutes of a staff window (4.5), so a recruiter or reviewer is not cut off while working.
  2. No upload is unconfirmed: no session has open ingest (ADR 0013 ingest close not yet done) and the close sweep (pass 1) of every finished session has completed. The condition keys on sweep completion, not on every chunk being confirmed, because a chunk the client never sent is never confirmed.
  3. The BullMQ queues are idle: no waiting or active job, and no delayed job due within 30 minutes. Later delayed jobs (email and webhook retries with backoff, the erasure re-run, sweep pass 2 an hour after a close) stay in Redis, which the append-only file keeps across the stop, and run at the next start, late; the daily lost-delayed-job catcher (ADR 0013 section 5.11) covers only the storage sweeps and is not relied on for the others. Sweep pass 1 must be done for every closed session; pass 2 does not hold the stop (architect detail; Backend B confirms against ADR 0013 section 5.11 that deferring it to the next start is safe for storage).
  4. This start's maintenance work, if any, is done (4.5).
  5. The shutdown sequence has finished (5.3): the dump is uploaded, the final WAL segment is archived and Redis has saved (`SHUTDOWN SAVE`). Only then does the script halt the machine. The stop is a sequence, not a power cut.
- **How it checks.** The check is a function in `apps/api` that exposes only counts and booleans on a route bound to the host's loopback address and denied by an explicit Caddy rule, so it cannot be proxied from the internet. The timer holds no credentials.
- **Judge0 host.** It stops itself with `shutdown -h now` when it has received no health ping from the main instance for 10 minutes and no run is active. The `api` pings it every minute while it runs. The Judge0 host therefore needs no IAM and no way to see the main instance's state.

### 4.3 Hard ceiling

The ceiling must hold even if the running host is compromised, so the host can neither cancel it nor keep the instances alive:

- **Backstop owned by the owner.** An owner-applied recurring schedule invokes a small function every 15 minutes that stops any pilot instance that has been running longer than a global maximum (default 6 hours, **Not verified** as the right value) and emails the owner. The app role cannot change it. The app refuses any window longer than this maximum minus a margin (the window is the 45-minute early start, the slots, the post-session analysis and 2 hours), so the backstop cannot take candidate time, including accommodated time. A cost alert (Budgets) and, if the owner wants it, a Budgets action back it up (**Not verified**).
- **Per-window ceiling.** The app creates a stop schedule at the end of the window plus 2 hours in a separate group, `codeproctor-pilot-ceiling`, where its role has `scheduler:CreateSchedule` only: no update and no delete. A compromised app can therefore add stops, which only end a run earlier, and cannot remove one. The schedules use `ActionAfterCompletion: DELETE`.
- **Stale ceilings.** Because a ceiling cannot be deleted, a cancelled or moved slot leaves its old stop in place. The app keeps those times and refuses any slot whose window (start minus 45 minutes to end plus 2 hours) contains one. A stale stop that fires while the instances are off does nothing.
- **Window end.** The window end is the latest time any session in the window can reach: the latest `deadline_at`, including accommodations extra time and the pause limits (ADR 0002 section 5), plus the allowance for the post-session analysis (4.4). The ceiling never takes candidate time from an accommodated session.
- **The daily wake.** The wake's own ceiling (60 minutes) is an owner-applied recurring schedule. The app refuses any slot whose window overlaps the wake period, so the wake's stop never cuts a slot.
- **The stop is a normal ACPI shutdown.** Docker's default 10-second stop timeout would kill Postgres and the dump, so the Compose file sets `stop_grace_period` long enough for the shutdown sequence (**Not verified**, 4.2 and section 15). The ceiling does not wait for it past the instance's own limit.
- **Safe by design.** Every job is idempotent and resumes at the next start (ADR 0004 sections 9.2 and 9.7, ADR 0013 sections 5.7 and 5.11). A session cut off by the ceiling is the same case as a host crash: the heartbeat watchdog and the close-section sweeps handle it at the next start. The ceiling is for failures, not for normal operation: windows are sized so that the self-stop comes first.
- **Start schedules.** The app creates and deletes start schedules in the group `codeproctor-pilot-slots` only, and only for the main and Judge0 instance ARNs through the start-only scheduler role. A compromised app can start the instances repeatedly; the backstop above bounds each run and the cost alert bounds the month.

### 4.4 Heavy analysis (C-44)

- **Stays live before the test:** the identity face match (FR-403, ADR 0002 CONSENTED to VERIFIED).
- **Deferred until after the sessions of the window:** audio checks, code similarity and other heavy analysis. They are queued jobs that run below the live-test priorities (ADR 0013 section 5.7) and finish inside the window and below the ceiling. A window is sized for its analysis as well as its sessions (section 10).
- **Not decided by C-44:** the in-test face re-checks (ADR 0013 `face-recheck`). They stay queued as today; the load test measures them (section 15).
- **Review.** The review UI shows "analysis pending" (ADR 0005 AI-3) until the jobs finish. No session reaches a verdict before its review (C-28).

### 4.5 Daily maintenance wake (C-47)

- **What it does.** About 15 minutes a day, at a fixed time: the retention tiers, R-9 and R-10, the erasure runs and their retries, the reminder emails, the lost-job catcher, the base backup (weekly) and the backup verification (ADR 0004 sections 9.2 to 9.5 and 9.7). All are idempotent and already retried the next day, so a missed wake only delays them.
- **Alarm.** The app logs a "maintenance complete" line; a log metric filter counts it, and a CloudWatch alarm that treats missing data as breaching emails the owner if no such line appears within 30 minutes of the scheduled start. The deadlines of retention (C-35, FR-704) and erasure (C-06, ADR 0004 section 9.5) hold even on a day with no slot.
- **Staff window.** The wake is also the window in which recruiters and reviewers can use the app on a day without a slot (4.6). Its length is a trade-off the owner set in C-47: it is not a work session.

### 4.6 Recruiter-picked slots and the static page (C-46)

- **The slot.** The recruiter picks the slot when creating the invitation. The invitation carries `window_start`, which is the moment the identity and system gate opens (30 minutes before the slot start), and `window_end`, the slot start plus 15 minutes, the last moment the timed test may start (FR-303; architect details, owner to confirm). The 45-minute early start of the instances leaves 15 minutes of warm-up before the gate opens. The two offsets are fixed per invitation when it is created, so the slot start of a row is its `window_start` plus the gate offset fixed for that invitation, and changing the configuration never moves an existing slot. Before `window_start` the API answers the link with the same neutral page as when the instances are off and sends no OTP; the gate opens only at `window_start`. There is no start window beyond this and no booking service. The candidate cannot self-book or reschedule. A reschedule request goes to the recruiter by email, who changes the slot in the next staff window (the app then replaces the schedules of 4.1).
- **Staff access while off.** Recruiters and reviewers can use the app only while the instances run: in the daily window, in a slot window, or in a review window (4.1). Nothing outside the running app can start the instances: a staff user cannot start them by hand.
- **The static page.** The invitation link opens a page on Cloudflare Pages. When the API does not answer, the page says the same neutral sentence for every link: "The test is not available right now. Your invitation email has the time." It shows no time (an architect detail for privacy and to avoid an oracle; C-43 asked for "the test opens at <time>"; owner to confirm). The invitation token travels in the URL fragment so it never reaches Cloudflare's logs, and the page sends it to the API only after an unauthenticated health route answers (FR-407). The page holds no candidate data, stores no token and shows no time: a time in the URL would put invitation data in a query string, and storing it for the page would be an always-on store. The email, sent by the app while it runs, gives the slot's start and end in UTC (a local time zone needs a stored time zone, a schema item of section 14 and FR-304).
- **Reminders.** Sent by the app while it runs, in the daily maintenance window before the slot, and at invitation time. A slot made after a day's window and starting before the next one gets only the invitation email (FR-304).

## 5. Data: S3, encryption, backups, restore

### 5.1 Buckets

Three buckets in us-east-1, created by the owner's template, each with Block Public Access, a TLS-only bucket policy, versioning off (or noncurrent versions expired within 1 day; ST-8 and ADR 0004 section 9.2), and no access from any role other than the ones named here:

| Bucket | Content | Written by | Read by | Lifecycle |
| --- | --- | --- | --- | --- |
| media | Recordings, identity images, evidence, reports, consent PDFs (ADR 0004 prefixes) | main instance role (and presigned PUT by candidates) | main instance role | By the retention jobs and the lifecycle rules agreed in C-43 |
| backups | WAL archive and nightly or shutdown dumps | main instance role (put, get and list; no delete) | the main instance role and the owner's restore role | Expire after 14 days (5.3) |
| releases | The signed release manifests (section 6), one prefix per instance | the CI deploy role (write on both prefixes) | the main instance role (its prefix) and the Judge0 instance role (its own prefix) | Keep the last 10 manifests per prefix |

### 5.2 Encryption (C-48)

- **One customer-managed KMS key (SSE-KMS)** encrypts the buckets that hold recordings, ID images, selfies and backups (media and backups), with S3 Bucket Keys on to keep request costs low. The key policy lets the owner administer it, lets the main instance role use it (`GenerateDataKey`, `Decrypt`), lets the owner's restore role decrypt, and gives CI and the Judge0 instance no access. The key costs about $1 a month plus requests (**Not verified**).
- **What it adds.** A second control on candidate recordings, so a mistake in a bucket policy does not by itself expose them; every decrypt is in CloudTrail; and disabling the key stops reads. Presigned PUT is expected to work with a bucket default of SSE-KMS (the signing role needs the key actions, ST-6; **Not verified**). The releases bucket holds no candidate data and may use SSE-S3.
- **EBS** volumes use the account's default EBS key (C-48).

### 5.3 Backups (C-49)

- **Two kinds, both to the backups bucket.** (a) Continuous WAL archiving with a tool such as pgBackRest or WAL-G (open source). The `postgres` container only writes to a host-mounted spool directory (its `archive_command` is a local copy), and a host systemd uploader pushes the spool and the dumps to S3 with the instance role, because host processes reach IMDS at hop limit 2 while the `postgres` container does not (the IMDS rule of section 3 exempts only `api`), with a weekly base backup in the daily window; (b) a logical `pg_dump` taken during shutdown (4.2) and before any schema migration at boot (section 6).
- **The physical backup method (ARC-05).** WAL archiving needs a physical base backup, which a logical dump cannot provide. The method is pgBackRest (or WAL-G): a full base backup weekly in the daily window and a differential or incremental backup on the other days if the owner wants a shorter replay, plus `archive_command` writing WAL to the host-mounted spool. The tool runs the base backup against the `postgres` container and writes it to the spool, and the host uploader pushes it to the `wal/` prefix of the backups bucket (Backend A's PR 1b keeps that prefix); the dump goes to the same bucket under its own prefix. The backups bucket stays one bucket; the media bucket is the single media bucket of ADR 0013 section 5.7 (DL-40). `infra/scripts/backup.sh` makes logical dumps only, so **the database track (Database A and B) owns the physical backup**: the pgBackRest or WAL-G configuration, the spool and uploader scripts, the retention (14 days, 5.3), the verification of a restorable base backup, and the restore drill of 5.4 with a point-in-time target. The backup bucket's lifecycle expires objects at 14 days; see section 14 item 6 for the stall case.
- **Why both.** WAL gives point-in-time recovery for a crash while running. The dump is portable across Postgres versions and is the one the restore drill and ADR 0004 section 9.7 use.
- **Nothing is written while the instance is off,** so the recovery point after a stop is the shutdown backup; after a crash while running it is the last archived WAL (the archive timeout is 60 seconds).
- **Backups expire after 14 days, as already decided** (ADR 0004 R-7, A-31, and database.md). C-43 leaves retention unchanged, so this ADR does not lengthen it. A backup contains candidate rows that an erasure removed after it was taken. ADR 0004 section 9.7 re-applies erasures after a restore from the erasure list kept outside the database backup, so a restore never resurrects erased data, and an erased person's rows leave the backups within 14 days.
- **Dumps hold the data as the schema holds it:** scores, no face embeddings (ADR 0004 C-18). Recordings are objects in the media bucket, not in the dump.

### 5.4 Restore drill (C-49)

- **When.** Before the pilot opens to real candidates (a gate for B-05), then every quarter and after any change to the backup tooling.
- **How.** The owner applies a throwaway instance template, restores the latest base backup and WAL, and separately the latest dump, into it, runs the application's migration check and a read-only smoke test, re-applies the erasure list, and destroys the instance. It runs on AWS, never on a developer machine (ADR 0009).
- **What it must prove.** The restore works from the archive alone; the time to restore is recorded and below the owner's target; an erased candidate does not reappear after re-application; the restored database passes `verify-schema`.

## 6. Deploy mechanism

SSM SendCommand and key pairs are denied today. Two ways remain.

| Option | How | For | Against |
| --- | --- | --- | --- |
| **a. The instance pulls a signed release at boot (recommended)** | CI builds the images, pushes them to a registry, and writes a release manifest (image digests, the migration list) to the releases bucket, signed with cosign keyless signing. The host trusts only the issuer, this repository's release workflow path and `refs/heads/main` (the Fulcio certificate may not carry the GitHub environment, **Not verified**; the environment is enforced by the OIDC role that writes the manifest). The manifest carries a monotonic sequence number, and the host refuses a lower one than it last applied, so an older signed manifest cannot be replayed. Verification works offline from a bundle with a cached trust root, so boot does not depend on the transparency log (**Not verified**). At boot a systemd unit verifies the signature and these identity checks, pulls the images by digest, takes a pre-migration dump if the manifest carries migrations, runs `prisma migrate deploy`, then starts Compose. The Judge0 instance pulls its own pinned image digest the same way, from its own signed manifest | CI has no command path into either host; no inbound access; no SSM; fits machines that are mostly off, because a release takes effect at the next start; the GitHub `pilot` environment's required reviewers are the human gate (the OIDC role trusts only that environment) | A release is live only after the next start; an urgent fix needs the next window; the trust-chain details are **Not verified** (section 15) |
| b. A narrow SendCommand | CI runs one SSM document on the one instance | An immediate deploy to a running instance | Needs the SSM agent and its role on the data host, gives CI command execution next to the data, and reverses today's denial |

- **Recommendation: a.** A compromised CI job can then at worst publish a manifest the host refuses to run, not run a command on the host.
- **Mutable tags are not used.** The manifest names digests.
- **Refusal.** If the manifest fails verification, the host keeps the last good release and alerts the owner. If there is none (the first start), it stays down until the ceiling.
- **Rollback.** CI writes the previous release as a new manifest with a higher sequence number; the next start applies it. A migration that cannot be undone needs the pre-migration dump (5.3) and the owner.
- **What is baked in, owner-applied.** The signing identity to trust, the releases bucket name and the registry. They are set in the instance template, never fetched from the release.
- **Secrets.** No secret in user-data or in the manifest (ADR 0016 section 3.5). The main instance reads them from Secrets Manager or SSM Parameter Store with its role at boot. The Judge0 instance reads only its own `AUTHN_TOKEN` and `AUTHZ_TOKEN` and its TLS leaf certificate and key (mode 0600), read with its own minimal role (section 3); never the CA private key, which stays offline with the owner (ADR 0016 section 4.3), and never an app secret (C-45). Which store is cheaper at this size is **Not verified**.

## 7. Owner and CI split

| Who | What |
| --- | --- |
| **Owner (applies the templates)** | The GitHub OIDC provider and the deploy role; the three buckets and their policies; the KMS key and its policy; the two instances, their security groups, roles and profiles, volumes and the shutdown behaviour; the Cloudflare API token for DNS (section 8); the two schedule groups, the three scheduler execution roles (start-only, stop-only and the probe's invoke-only role), the health probe, the DLQ and the alarms; Budgets and the SNS email; the restore role and the restore-drill template; the SES identity (ST-5, `.env.example`) |
| **CI (`codeproctor-pilot-deploy`, trusted only from `environment:pilot`)** | Push images to the registry; write the two release manifests (one prefix per instance) to the releases bucket, with `s3:PutObject` on those two prefixes only. Nothing else |
| **The app, on the main instance** | Presign uploads; create and delete start schedules in its own group and create (never update or delete) ceiling schedules in the ceiling group; read its own secrets including the DNS token; update its DNS record; send email; write logs |

- **Consequence for Backend A's template.** The deploy role in `github-oidc-roles.yaml` is broader (S3, KMS, Secrets Manager, Logs, alarms, SSM, SES, Budgets and a permissions boundary for roles it creates). Under this ADR the role does not create or change infrastructure: it needs only the registry push and `s3:PutObject` on the two manifest prefixes. If the owner keeps Terraform (P-36), the broader role stays but is applied only to stacks that exclude data, keys, the instances and the scheduler. I review that template against this ADR when its PR is opened.
- **Never in CI:** data buckets, KMS, the instances, the instance roles, `iam:*` beyond the boundary, `ec2:*`, `scheduler:*`.

## 8. IP, DNS and TLS (C-49)

- **No Elastic IP.** Since 2024 AWS charges for every public IPv4 address (about $0.005 an hour, **Not verified**). An Elastic IP on a stopped instance is charged all month; an auto-assigned address costs only while the instance runs.
- **DNS through the Cloudflare API.** At boot a unit on the main instance upserts the API record with the instance's current public IP. The record's TTL is 60 seconds. The token is a Cloudflare API token limited to editing DNS in the one zone, kept in Secrets Manager and read with the instance role.
- **Token risk (architect detail, owner to confirm).** A Cloudflare token cannot be limited to one record: a stolen token could change any record in its zone, including the Pages hostname. A token whose zone also serves the Pages or web hostname would let a compromised main host repoint the staff and candidate front end and obtain certificates for it, which is a credential-phishing path that outlives the instance. So the token's zone is required to be a separate zone, or a delegated subdomain zone, that holds only the pilot's API records, and the token is limited to that zone. If the owner wants a shared zone, the owner records written acceptance of the risk (the pattern of ADR 0013 control 0). This ties to the cookie domain (Q-44).
- **TLS.** Caddy obtains its certificate with HTTP-01 and keeps it on the volume. The first start after a new volume has the usual issuance delay.
- **The Judge0 instance** has no public name. The main instance reaches it by its private address (section 9).

## 9. Judge0 on its own instance (C-45)

- **Why.** Judge0 runs untrusted candidate code in privileged containers (TB-4, ADR 0016). A sandbox escape on a shared host reaches the database, the secrets, every recording the role can read and the schedule role. C-45 keeps ADR 0016's dedicated host (its option B).
- **What C-45 requires, and how it is met.**
  - No app secrets on the Judge0 instance: its minimal role (section 3) reads only its own Judge0 secrets, and it holds no app secret and no data-store credential.
  - No network access to Postgres, Redis or the media buckets: its security group allows inbound only the TLS port that `judge0-tls` publishes (ADR 0016 section 3; port 2358 itself is never published) from the main instance's security group, and outbound as set in section 3 (the S3 prefix list, Secrets Manager and the registry) plus what ADR 0016 section 3 allows (patching through its allowlist or a rebuilt image); no rule or route to the main instance's other ports, and no S3 gateway endpoint on this instance's route table that is open to the data buckets.
  - Neither instance can reach the other beyond that one path: the main instance's security group allows no inbound from the Judge0 instance.
- **Start and stop with the main instance.** The same schedules start and stop both (4.1, 4.3); the Judge0 host stops itself when the main host stops pinging it (4.2).
- **Instance metadata.** The Judge0 instance's role is minimal (section 3), and sandboxed code must never use it: its hop limit is 1 and a rule in `DOCKER-USER` drops traffic from the Judge0 networks to 169.254.169.254, tested in section 15.
- **Instance type.** A small x86 type that runs the sandbox (the cgroup and privileged requirements of ADR 0016). The type is sized by the spike and is **Not verified**; the cost is in section 10.
- **ADR 0016 changes.** Its recommended dedicated host stands; the pilot's single-host sizing (8 vCPU / 16 GiB) is replaced by the small instance until the spike shows otherwise; the co-located fallback is not used in the pilot; staging runs Judge0 in the local stack (section 12).

## 10. Cost estimate (**Not verified**; the owner checks it with the AWS pricing calculator)

The figures are the architect's estimates from list prices, to show where the budget of about $12 a month (C-49) goes, not a quote.

| Item | Basis | Per month |
| --- | --- | --- |
| Main instance, m7i.large | about $0.10 an hour; roughly 45 instance-hours: slot windows with the 45-minute early start, the analysis, and the daily wake (about 15 minutes, about 8 hours a month) | about $4.5 |
| Judge0 instance | a small x86 type, the same hours | about $1 |
| EBS, main volume (30 GB gp3, kept while stopped) and the Judge0 volume | storage only | about $3 |
| KMS key (C-48) | fixed | about $1 |
| S3 (recordings, backups, releases) | depends on volume and the lifecycle | $1 to $2 |
| Public IPv4 while running, CloudWatch logs and alarms, Scheduler, SNS, the probe | small | about $1 |

The total is close to $12. The hours are the lever: the monthly budget guard (4.1) and a Budgets alert at 80% make the limit enforced rather than hoped for. If real hours exceed the estimate, the choices are fewer or shorter windows, a shorter early start, or a smaller daily wake; none of them changes a security decision.

## 11. Failure modes

| Failure | Effect | Handling |
| --- | --- | --- |
| The start schedule fails or capacity is unavailable | The slot cannot open | Retry policy, the DLQ alarm, the health probe 5 minutes before the gate opens and the owner's email; the candidate sees the static page; the recruiter reschedules. The candidate's time is not consumed, because the session has not started |
| The host hangs or loops | Cost and risk | The ceiling stop (4.3) and the Budgets alert |
| The ceiling stops the instance during a session | An interruption | The same as a crash: resume (ADR 0002 L-1..L-5), and the sweeps at the next start; an alert |
| The daily wake does not run | Retention, erasure or reminders are late | The missing-data alarm (4.5); the jobs are idempotent and run the next day |
| A release is bad | The app does not start | The unit refuses an unsigned manifest; a bad signed one is rolled back by publishing the previous release as a new manifest with a higher sequence number and starting the instance |
| A volume or instance is lost | Data since the last backup | Restore (5.4); nothing was written while off, so the loss is bounded by the last archived WAL |
| The Judge0 instance is not up when the main one is | Run and submit fail | The probe before the gate opens checks both; the API reports the existing execution-unavailable error of ADR 0016 |
| DNS lags after a start | A slow first connection | TTL 60 s and the 45-minute early start |
| The Cloudflare DNS token is stolen | DNS changes in its zone | The zone scope of section 8; the token is rotated by the owner |

## 12. Updates to other documents (on acceptance)

- **docs/architecture.md, Deployment.** Staging row: "Local Docker Compose with synthetic data; a free-tier Supabase or Neon database is allowed; media on Cloudflare R2 (C-43). There is no AWS staging." Pilot row: "One scheduled x86 EC2 instance (m7i.large) running Docker Compose (api, worker, Postgres, Redis, Caddy) and one small dedicated Judge0 instance, both started and stopped around recruiter-picked slots (ADR 0017); real candidate data; recordings in AWS S3 under one customer-managed key; web on Cloudflare Pages." Production row: unchanged until the owner decides it.
- **ARC-05.** Decided here: Postgres on the instance (no RDS), S3 settings (5.1, 5.2), backups (5.3), the deploy mechanism, DNS and the IP approach. Still open: Cloudflare Pages CSP (R-08), the cookie domain (Q-44), the vault choice (the secrets store of section 6).
- **ADR 0001 OI-5.** "Decided (D-11, C-43..C-48, ADR 0017): the pilot runs on one scheduled instance with Postgres on it plus a dedicated Judge0 instance; S3 settings as ADR 0017 section 5; backups to S3; no AWS staging. Still open: the instance type and OS image of the Judge0 host (spike), the production layout." ST-6 is decided by 5.2.
- **ADR 0016.** Section 1 and row 3 of section 2: the pilot's Judge0 host is the small dedicated instance of ADR 0017 section 9. Row 4 (staging): "no AWS staging; Judge0 runs in the local stack". Owner question 1 is answered by C-45 (option B).
- **PA-07 / DEP-03.** Scope becomes "the pilot instances, buckets, key, schedule group and DNS as in ADR 0017"; DEP-01 becomes local and free-tier staging (C-43).
- **processors.md** (Delivery Lead): EventBridge Scheduler, KMS, SNS and the probe as AWS sub-services of the same processor. Cloudflare already hosts Pages; it also holds the DNS record and the API token, but no candidate data.

## 13. FSD changes (in the FSD PR)

- FR-303 and FR-304: the invitation carries a slot instead of a start window; reminders are timed to the slot.
- A new requirement: the staff schedule view and a reviewer's request for a review window; and the static "opens at" page.
- NFR-02: 5 concurrent candidates (the 200 concurrent target moves to production).
- NFR-03: availability applies to the scheduled windows of the two-instance pilot.
- FR-403: unchanged (C-44).
- FR-704 and NFR-05: no change expected; the backup retention of 5.3 is added to the retention text.
- ADR 0002 section 1 (timing windows) and TC cases for the static page and the schedule follow in the QA track.

## 14. Still open

1. **P-36: keep or drop the CI plan role and Terraform state (7).** Recommended: drop both for the pilot. With the instances, buckets and keys applied by the owner and CI limited to the registry push and the manifest, there is little for a plan role to plan.
2. **Interactive access (3).** Recommended: none for the pilot. The alternative is an Instance Connect Endpoint with a narrow policy, which reopens the denial of key pairs and SSM in a different form.
3. **Release gate (6).** Recommended: the GitHub `pilot` environment's required reviewers approve each release. Confirm who approves.
4. **Schedule storage (FR-307, 4.1, 4.3).** Review windows, the outstanding ceiling times (the stale-ceiling record), and the monthly instance-hours need storage that `database.md` does not have. Slots are in `invitations.window_start` and `window_end`; the rest needs one table (for example `scheduled_windows`: kind, starts_at, ends_at, ceiling_at, created_by, organization_id, status), which is an ADR 0008 delta and needs the owner. Until then the app cannot enforce the stale-ceiling and budget rules of FR-306. The invitation time zone (`invitations.time_zone`, FR-304) is a second schema item. Recommended: approve both deltas with this ADR. FR-306 and FR-307 come from the FSD PR (#236). The schedule table, or an equivalent store, is a gate before the first real candidate, next to the load test (section 15): without it a stale ceiling could stop a live session and take candidate time, including accommodated time (4.3).
5. **The DNS token zone (8).** Required: a separate or delegated zone holding only the pilot's API records, or the owner's written acceptance of a shared zone. Architect detail, owner to confirm.
6. **A stalled backup and the 14-day expiry (5.3).** If no backup completes for 14 days (for example no window ran), the S3 lifecycle rule would delete the last dump and the last base backup. Recommended: the expiry deletes an object only if a newer verified backup exists, so the app, not a plain lifecycle rule, deletes backups; the alternative is a plain lifecycle rule and an alarm when the newest backup is older than 7 days. Raised by the Delivery Lead (Q2).
7. **Credentials on the instance and presigned URLs (3, ST-5).** The app signs presigned URLs with the instance role, so a compromised main host can read every recording through that role or sign its own URLs, and URLs signed with role credentials die when the credentials rotate. Any design where the app serves media needs some such access; the alternatives (a separate signing service, an always-on signer) cost more and add a second host. Recommended: accept this residual exposure, limit it with the role's scope (3), the key policy (5.2) and an alert on bulk reads (KMS decrypt and S3 request metrics), and keep short URL lifetimes (60 seconds and 15 minutes, ST-5). The owner confirms. Raised by the Delivery Lead.

## 15. Verification and spike (before the pilot)

- **Load test (C-49 gate):** 5 concurrent candidates through TC-090 and TC-091 on the real m7i.large and the small Judge0 instance, with the face model running live and the post-session analysis in the same window. The pass criteria are those of NFR-01 and ADR 0016 section 11. Memory headroom at 8 GB is **Not verified**.
- **Start and stop:** a rehearsal of start, a 3-session window, analysis, self-stop and a ceiling stop, measuring the start-to-ready time. The 45-minute lead is the owner's value; the rehearsal checks that it is enough, including the first start after a new volume (certificate issuance).
- **Backup and restore:** the drill of 5.4.
- **Deploy:** an unsigned manifest is refused, a signed one runs, a rollback (re-signed as a new manifest with a higher sequence number) works, an older manifest is refused, and verification works offline from the bundle.
- **Scheduler and IAM conditions:** that the app role cannot delete or update a ceiling schedule, that `iam:PassedToService` holds, that each scheduler role's `aws:SourceArn` trust condition holds (including the probe role's) (the start-only role cannot be used from the ceiling group), that the stop function and the 6-hour backstop work, and that overwrite and delete are denied on the backups bucket (an IAM policy simulation and a live test).
- **Shutdown sequence:** that the host uploader, not a container, pushes the WAL spool and the dump, that the `postgres` container cannot reach IMDS, that the dump is uploaded, the final WAL archived and Redis saved before the halt, within the `stop_grace_period`, and that a ceiling stop leaves a restorable database.
- **Isolation:** `worker` and `caddy` cannot reach IMDS while `api` can; the Judge0 instance cannot reach Postgres, Redis or the buckets; IMDS is unreachable from containers; the instance roles' effective permissions (an IAM policy simulation); no inbound rule other than 80 and 443 on the main instance.
- **Prices and limits:** the section 10 estimate against the AWS calculator; the public IPv4 charge; the Scheduler and KMS prices.
- **Static page:** the invitation link while the instances are off shows the page and no data.
