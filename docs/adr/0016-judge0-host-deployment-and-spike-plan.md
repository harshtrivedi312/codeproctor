# ADR 0016: Judge0 host, code-execution deployment and the spike plan

| Field | Value |
| --- | --- |
| Status | **Proposed** 2026-10-05. The owner accepts or amends. "(owner decision C-xx / D-xx)" marks what docs/compliance/decisions.md or status.md section 9 already decides. "(architect detail)" marks what this ADR adds, which the owner must confirm. "**Not verified**" marks external facts the architect could not confirm; section 10.1 lists what was checked and how. Owner questions are in section 13. Revised 2026-10-05 after review round 1 (blockers B1 to B4: host IAM and access, CI runner rules, egress, API-to-Judge0 TLS). |
| Author | architecture hub (task ARC-05, Judge0 part) |
| Decides | Where Judge0 CE runs in each environment and on what host; its network isolation, limits, authentication, secrets and patching; how long Judge0 keeps candidate code and test input; the load and security spike with pass/fail criteria; the interface BE-05 builds against |
| Does not decide | The rest of ARC-05 (the AWS layout ADR): RDS versus Postgres on EC2, S3 bucket settings, backups, Cloudflare Pages and CSP (R-08), the cookie domain (Q-44), the vault, the egress path of the AWS subnets. Those stay open in ADR 0001 OI-5 |
| Serves | FR-502, FR-503, FR-203, FR-506; NFR-01, NFR-02, NFR-03, NFR-04, NFR-05, NFR-09; TC-040..TC-044, TC-012, TC-091, TC-094. (TC-093, the OWASP scan of staging, is not served here: Judge0 is never internet-facing) |
| Builds on | ADR 0001 (TB-4, F3, C-4, C-5, C-11, section 7 "Judge0 host", OI-5), ADR 0004 section 9 (C-06, C-26, C-27), ADR 0009 (no staging or pilot credentials on developer machines, D-38), ADR 0013 (**Proposed**; owner decision C-23 accepts it once the hub reports a clean security review: 5.11 submit, CS-4.6 gate, CS-4.7 jobs, grading reconciler; owner question Q23 is on branch `arc/adr-0013-proctor-transport`, not yet on main). Where this ADR relies on ADR 0013, it relies on the Proposed text and changes with it |
| Amends (on acceptance) | PA-07 / DEP-03 scope and architecture.md Deployment (dedicated Judge0 host, section 3); ADR 0001 OI-5 (Judge0 part decided); the placeholder `RunResult` contract (section 8.3, through a hub PR to packages/shared) |

## 1. Context

- Judge0 CE runs untrusted candidate code (TB-4). It needs x86, privileged containers and, per its own guide for Ubuntu 22.04, cgroup v1 (`systemd.unified_cgroup_hierarchy=0`) (ADR 0001 section 7; re-verified, section 10).
- Hosting is AWS (owner decision D-04), in one US region, us-east-1 (owner decision C-03). The pilot has its own stack; staging holds synthetic data only (owner decision D-10). Staging stores media on Cloudflare R2, pilot and production on AWS S3 (owner decision D-11).
- The owner provides the AWS x86 host for the spike (build-plan ARC-05). Developer machines are Apple-silicon Macs (status.md R-01).
- Judge0 v1.13.1 (2024-04-18) is the latest release. It fixed three sandbox escapes rated CVSS 9.1 to 10.0 (CVE-2024-28185, CVE-2024-28189, CVE-2024-29021). One of them reached Judge0's own Postgres from a submission with networking turned on (section 10).
- Judge0 stores every submission (source code, stdin, expected output, stdout, stderr) in its own Postgres. It has no retention setting (section 10). ADR 0013 raised this as owner question Q23.
- NFR-01: code run result under 5 s p95. NFR-02: 200 concurrent candidates on the pilot. TC-091: 50 concurrent runs, p95 under 5 s. FR-502: 1 run per 5 s per candidate.

## 2. Decision summary

| # | Item | Decision | Marker |
| --- | --- | --- | --- |
| 1 | Version | Judge0 CE **1.13.1**, image pinned by digest (`judge0/judge0`), with its own Postgres and Redis as upstream ships them | architect detail |
| 2 | Host OS | **Ubuntu Server 22.04 LTS, amd64**, booted with cgroup v1. The kernel is pinned (`apt-mark hold`) to the version that passes the spike. Never 6.11 or newer (section 10, Judge0 issue #554) | architect detail |
| 3 | Pilot and production host | A **dedicated Judge0 EC2 instance** in us-east-1, separate from the app host, with no IAM role holding data access. Current-generation x86 compute-optimized class (c7i, c6i or c7a); start at 8 vCPU / 16 GiB and size from the spike | D-04, C-03 (owner); dedicated host: architect detail, **owner question 1** |
| 4 | Staging | Same topology as the pilot, on smaller instances (recommended). Fallback: Judge0 on the staging VM, same Compose networks | D-10, D-11 (owner); topology: **owner question 2** |
| 5 | Local dev and CI | No Judge0 on the Macs. Unit tests use a fake Judge0. Real-Judge0 tests (TC-042..TC-044, TC-012) run on an owner-provisioned x86 host registered as a self-hosted CI runner (`judge0-x86`), which is also the spike host | architect detail, **owner question 6** |
| 6 | Network | The Judge0 workers sit on a Compose network with `internal: true`, so they have no route out. Only a TLS terminator in front of the Judge0 server is reachable, only from apps/api. Networking inside the sandbox is off and cannot be turned on per request. The Judge0 security group denies outbound by default; patching goes through an allowlisting proxy or a rebuilt AMI. No data-store security group admits the Judge0 security group (section 3.7, binding on the layout ADR) | TB-4 (ADR 0001); details: architect detail |
| 6a | Transport | apps/api reaches Judge0 over **TLS 1.2+** only: Caddy on the Judge0 host terminates TLS with a per-environment certificate from a private CA, and apps/api pins that CA and checks the hostname (section 4.3) | NFR-04; option: architect detail |
| 6b | Host IAM and access | No instance profile on the Judge0 host. Admin access through EC2 Instance Connect Endpoint. If SSM is ever needed, a custom least-privilege policy with explicit denies replaces `AmazonSSMManagedInstanceCore`. No secret ever goes through EC2 user-data (section 3.5) | architect detail |
| 7 | Auth | `AUTHN_TOKEN` on every call (`X-Auth-Token`), and `AUTHZ_TOKEN` (`X-Auth-User`) for DELETE. Per environment, from the vault or GitHub Actions secrets, never on developer machines or in agent sessions | D-38, ADR 0009 (owner); tokens: architect detail |
| 8 | Data retention | Expected output is never sent to Judge0. apps/api deletes each Judge0 submission right after reading its result. A purge on the Judge0 host removes anything older than 1 hour. Judge0's database is never backed up | architect detail; answers ADR 0013 Q23 as recommended, **owner question 3** |
| 9 | Interface | Async batch submit and poll with backoff, no callbacks and no `wait=true`. One Judge0 submission per test case. apps/api compares output itself | architect detail |
| 10 | Failure mode | Run answers 503 `EXECUTION_UNAVAILABLE`. The run slot is given back only when the breaker refuses the run before any Judge0 call (an FR-502 deviation, **owner question 9**). Submit never calls Judge0 (ADR 0013 5.11). Grading retries a bounded number of times, then sends the question to manual review with an alert; an infrastructure error never scores a test as failed | ADR 0013 (Proposed, C-23); rest: architect detail |

## 3. Where Judge0 runs

### 3.1 Options considered

| Option | For | Against | Verdict |
| --- | --- | --- | --- |
| A. Judge0 on the app host (one VM per environment, as PA-07 and DEP-01 describe today) | One instance; cheapest; matches D-04's "one VM" and R-13 | Privileged containers running hostile code share a kernel with the API, which holds the session HMAC keys, the database credentials and an instance role that can read candidate media (ADR 0001 ST-5). The 2024 CVEs show escapes to root on the host. Judge0 CPU spikes also hit API latency (NFR-01: p95 under 300 ms) | Staging fallback only |
| B. **Dedicated Judge0 instance**, in the same VPC and region | An escape reaches a host with no candidate data, no app secrets and no data-access role. Judge0 load is isolated from the API. It scales on its own | One more instance per environment (cost, patching) | **Chosen for pilot and production** (owner question 1) |
| C. Hosted execution API (Judge0 on RapidAPI or Sulu, or others) | No host to run | Paid per call, and candidate code leaves our control. ADR 0001 section 6 already rejected it | Rejected |
| D. Run sandboxed code in the Python worker or a home-built sandbox | — | A home-built sandbox is risky (FR-503); ADR 0001 section 6 | Rejected |

### 3.2 Per environment

| Environment | Where | Instance class | OS and kernel | Data | Marker |
| --- | --- | --- | --- | --- | --- |
| Local (Apple silicon) | **No Judge0.** apps/api unit and contract tests use a fake Judge0 HTTP server that BE-05 writes (section 8.4) | — | — | — | architect detail |
| CI and spike | Owner-provisioned EC2 x86 host `judge0-x86` in us-east-1: a self-hosted GitHub Actions runner plus Judge0, under the runner rules in section 3.6. Stopped when idle | 4 vCPU / 8 GiB compute-optimized (c7i.xlarge class); upsized for the load spike | Ubuntu 22.04, cgroup v1, pinned kernel | Synthetic only. Its tokens are CI-only values | architect detail; owner question 6 |
| Staging | Recommended: its own Judge0 instance beside the staging VM, so the red team (QA-02) attacks the pilot topology. Fallback: on the staging VM | 2 vCPU / 4 GiB (c7i.large class) | as above | Synthetic only (D-10) | D-10 (owner); topology: owner question 2 |
| Pilot | Dedicated Judge0 instance in the pilot VPC, us-east-1 | Start at c7i.2xlarge class (8 vCPU / 16 GiB); the spike picks between that and 16 vCPU | as above | Real candidate code, deleted per section 6. The pilot-size instance used for spike S5 is never promoted as it is: the pilot Judge0 host is built fresh from a clean AMI with pilot-only secrets before any real data (D-10: no staging or spike state is reused) | C-03, D-10 (owner); size and rebuild: architect detail |
| Production | Same as the pilot. More capacity means a bigger instance first; more than one Judge0 host needs a later ADR, because each host has its own queue and database | from pilot measurements | as above | as pilot | architect detail |

### 3.3 Options rejected for local dev (Apple silicon)

| Option | Why not |
| --- | --- |
| Docker Desktop with amd64 emulation | Docker Desktop's Linux VM runs cgroup v2, and Judge0 1.13.1 needs v1. Judge0 says it "has only been tested on Linux", and the same failure is reported on WSL2 (cgroup v2 only). Also slow under emulation. **Not tried on the owner's machine**; expected to fail |
| Colima or UTM with a full x86 Ubuntu 22.04 VM | Works in principle, but full emulation is 5 to 20 times slower, so timing tests (TC-043, TLE) are unreliable. Optional for the owner; not required by any task |
| GitHub-hosted `ubuntu-22.04` runners | Reported to boot with cgroup v2, and boot parameters cannot be changed there (**not verified**; the spike confirms it in one short job, S0 below) |
| isolate 2.x (cgroup v2) or a community Judge0 fork | isolate 2.0 (2024-02-28) runs only on cgroup v2, but Judge0 1.13.1 bundles the v1-era isolate, and Judge0's cgroup v2 issue has been open since 2023-08-23. A fork would be ours to audit and patch. Revisit before production (section 11, R-new-3) |

### 3.4 OS choices

| OS | Verdict |
| --- | --- |
| **Ubuntu 22.04 LTS** (systemd 249) | **Chosen.** It is the OS Judge0's own guide documents. Standard support ends April 2027 (Canonical release cycle, **not rechecked today**). |
| Ubuntu 24.04 LTS (systemd 255) | Not chosen. cgroup v1 still boots, but Judge0 issue #554 (opened 2025-07-15, no maintainer reply) shows the sandbox failing on 24.04 with kernel 6.11, where `memory.use_hierarchy` is missing. |
| Ubuntu 26.04 or any distro with systemd 258 or later | Rejected. systemd 258 removed cgroup v1 (only a temporary force flag remains). |
| Amazon Linux 2023 | Rejected. It defaults to cgroup v2, and Judge0 does not document it. |

### 3.5 Host requirements (DEP-01, DEP-03; architect detail)

| Requirement | Value |
| --- | --- |
| Boot | `systemd.unified_cgroup_hierarchy=0` in `GRUB_CMDLINE_LINUX`, then reboot. A boot check (systemd unit or deploy step) refuses to start Judge0 unless `/sys/fs/cgroup/memory/memory.use_hierarchy` exists and `stat -fc %T /sys/fs/cgroup` is `tmpfs` (cgroup v1) |
| Kernel | Pinned with `apt-mark hold` to the version that passed the spike. A kernel change re-runs spike stages S1 to S3 on the CI host first. **Patch deadline:** after a kernel security notice (Ubuntu USN) for the pinned line, S1 to S3 run on the CI host within 3 working days, and the new kernel reaches staging and then the pilot outside test windows within 7 days of the notice (14 days for low severity). If S1 to S3 fail, the owner decides between running unpatched with the CVE recorded, or pausing test windows |
| Other packages | `unattended-upgrades` stays on for security updates of everything except the held kernel and the pinned Docker Engine |
| Docker Engine | Pinned version. Docker Engine 29 deprecated cgroup v1 but supports it until at least May 2029 on a maintained branch |
| Privileged | `privileged: true` on the Judge0 worker containers, as upstream ships it. Upstream also marks the server privileged; the spike tests the server without it (S1), and the flag is dropped if that works |
| IMDS | IMDSv2 required, hop limit 1, so containers cannot reach instance metadata |
| IAM | **No instance profile** on the Judge0 host (the default). The AWS-managed `AmazonSSMManagedInstanceCore` policy is **not** used: it allows `ssm:GetParameter` and `ssm:GetParameters` on `Resource: "*"` (verified, section 10.1), so an escape could read every SSM parameter in the account. If SSM or the CloudWatch agent is ever needed, a custom policy grants only the `ssmmessages:*`, `ec2messages:*` and `ssm:UpdateInstanceInformation` actions it needs (plus `logs:PutLogEvents` on the one log group, and `cloudwatch:PutMetricData` only with a `cloudwatch:namespace` condition naming the one namespace) and **explicitly denies** `ssm:GetParameter*`, `secretsmanager:*`, `kms:Decrypt`, `s3:*` and `ses:*`. That policy is an owner-approved change, reviewed by the architect |
| Admin access | EC2 Instance Connect Endpoint (no public IP, no SSM role, short-lived keys pushed per session). The owner or DEP uses it; agents never do |
| Deploy path | The deploy workflow (DEP-01, DEP-03) runs in its GitHub environment (`staging`, `pilot`) and assumes an AWS role through **GitHub OIDC**. **Trust policy:** principal `token.actions.githubusercontent.com`, with `StringEquals` on `token.actions.githubusercontent.com:aud` = `sts.amazonaws.com` and on `token.actions.githubusercontent.com:sub` = exactly `repo:harshtrivedi312/codeproctor:environment:<env>`. No wildcards and no `StringLike`; one role per environment. **Branch gate:** for an environment job the `sub` carries no branch, so the trust policy alone would let any branch pushed by an account with write access (agent sessions included) add a job with `environment: pilot` and get the role, which means root on a host holding in-flight candidate code, hidden-test stdin, the Judge0 tokens and the TLS key. The `pilot` and `production` environments therefore carry the **`main`-only deployment branch policy**, ideally with required reviewers (ADR 0013 section 6, control 1b, an owner action). ADR 0013 is **Proposed** (C-23), so this ADR depends on control 1b explicitly: **the pilot and production roles are not created until that policy is in place**. Staging gets the same policy (architect detail). **Permissions:** the role allows only `ec2-instance-connect:OpenTunnel` on that one Instance Connect Endpoint and `ec2-instance-connect:SendSSHPublicKey` on that one Judge0 instance (and the app host, if the same role deploys both). The role ARN and endpoint id live in that environment's secrets. No long-lived AWS key exists. The IAM action names are **not rechecked today**; DEP confirms them |
| Secrets delivery | **No secret ever goes through EC2 user-data** (Judge0 tokens, the TLS key, the Judge0 Postgres and Redis passwords): any root process on the host, including one that escaped the sandbox, can read user-data from IMDS. The deploy job writes `judge0.conf` and the TLS key over the admin path, mode 0600, owner root |
| Disk | EBS encrypted at rest. The Judge0 Postgres volume is excluded from every snapshot and backup plan |
| Inbound | Security group: the TLS port (section 4.3) only from the app host's security group, plus the EC2 Instance Connect Endpoint's security group on 22. No public inbound |
| Outbound (host) | Deny by default (section 3.7). Judge0 itself needs no outbound: callbacks and telemetry are off (section 4) |
| Clock | NTP (chrony), as ADR 0013 requires for every host |

### 3.6 Rules for the `judge0-x86` self-hosted runner (architect detail; binding on QA-01B and DEP-01)

| Rule | Detail |
| --- | --- |
| Triggers: no `pull_request` at all | The real-Judge0 workflow (TC-042..TC-044, TC-012, BE-05 integration) has **only** `push` (branches of this repository) and `workflow_dispatch` triggers. It has no `pull_request`, `pull_request_target` or `workflow_run` trigger. That is the enforcing mechanism: a condition inside the workflow cannot keep fork PRs out, because for `pull_request` the workflow file comes from the PR itself. Only accounts with write access can push or dispatch. PRs show the result of the branch's `push` run |
| Repository setting (second layer) | Private repository: "Run workflows from fork pull requests" stays **off**. Public repository: "Require approval for all outside collaborators" for fork PR workflows. Either way, the trigger rule above is what keeps fork code off the runner |
| Permissions | The workflow declares `permissions: contents: read` at the top level and nothing else. No job raises it |
| Label scope | The runner carries only the label `judge0-x86`. Runner groups limited to selected workflows are an organisation or enterprise feature; this repository belongs to a personal account (`harshtrivedi312`), so **any workflow in the repository can target the label**. The limit is therefore by review: code-reviewer and the architect refuse any other workflow that names `judge0-x86`, and a CI lint step fails when a workflow other than the real-Judge0 one contains the label (QA-01B). If the repository moves to an organisation, a runner group limited to that one workflow is added |
| No deploy or environment secrets | The workflow uses no GitHub environment. No staging, pilot or production secret, no deploy key, no AWS credential and no `MIGRATION_DATABASE_URL` is ever available to it (ADR 0009, D-38). It holds only the CI-only Judge0 tokens and the CI TLS material |
| Deploy workflows never target it | Deploy jobs (DEP-01, DEP-03) run on GitHub-hosted runners, never on `judge0-x86` |
| Shared host between rebuilds (accepted, R-new-4) | Registration is just-in-time or `--ephemeral` (one job per registration), but **jobs share the host** until it is rebuilt from a clean AMI, at least weekly and at once on any sign of sandbox escape. A rebuild per job is not chosen: each rebuild needs a reboot into cgroup v1 and minutes of setup. Because Docker access is root-equivalent, one malicious job could persist on the host, read later jobs' CI tokens and CI TLS key, or fake TC-042..TC-044 results. The exposure is limited to synthetic data and CI-only secrets, and only someone with write access can start a job. As an independent check, QA-02 re-runs the section 10 abuse checklist on the staging Judge0 host before the pilot. Recorded in R-new-4 for the owner |
| No AWS role | Same IAM rules as section 3.5: no instance profile |
| Network | Same egress rules as section 3.7. It never sits in the staging or pilot VPC |

### 3.7 Egress and data-store isolation (architect detail; binding on the layout ADR)

| Rule | Detail |
| --- | --- |
| Outbound deny by default | The Judge0 host's security group has **no** default `0.0.0.0/0` outbound rule; it allows only the patch path below, if any. Security groups do **not** filter traffic to the Amazon-provided DNS resolver or the Amazon Time Sync Service, so they are not the control for DNS and NTP (AWS documentation, not rechecked today). DNS is controlled by the next row |
| DNS | The VPC resolver would otherwise resolve any name, which is a DNS exfiltration channel. **The control is a Route 53 Resolver DNS Firewall** rule group with an allowlist that blocks every other name. Rule groups are associated **per VPC**, not per instance. So either Judge0 gets its own VPC with its own allowlist, or a shared pilot VPC's allowlist must also cover every name the app host needs (S3, SES, CloudWatch, RDS and the rest), which widens what the Judge0 host can resolve. The layout ADR decides; this ADR prefers a separate Judge0 VPC (or subnet-level separation plus its own VPC association). Staging and CI do the same where they use option 1 |
| Patch path, option 2: no internet (**pilot and production default**) | Patch by building a new AMI elsewhere and replacing the instance. The host then has no internet path at all |
| Patch path, option 1: allowlisting proxy (staging and CI) | A forward proxy (for example Squid, chosen in the layout ADR) that allows `CONNECT` only to named hosts. Base list: the Ubuntu archive and security mirrors, the registry that serves the pinned Judge0 and Caddy images, and the Docker apt repository. **CI adds** the GitHub Actions hosts the runner needs (the list in GitHub's self-hosted runner documentation) and the image pulls of the test workflow. An allowlisted host can still receive data, because an HTTPS tunnel hides the method. That channel is accepted for CI and staging only, which hold synthetic data |
| Data stores never admit Judge0 | The RDS (or EC2 Postgres), app-host, Redis and VPC-endpoint security groups **never** list the Judge0 security group as a source. A sandbox escape on the Judge0 host has no network path to any data store or AWS API endpoint |
| Binding | The layout ADR (rest of ARC-05) must keep these rules; changing them needs an amendment of this ADR |

## 4. Network isolation and Judge0 configuration

### 4.1 Compose topology (same on every host; architect detail)

| Network | Members | Property |
| --- | --- | --- |
| `judge0-internal` | judge0 server, judge0 workers, judge0 db, judge0 redis | `internal: true`: no route outside the network, no published ports |
| `judge0-edge` | judge0 server and `judge0-tls` (Caddy); in the co-located fallback also `api` | Port 2358 is never published. Only `judge0-tls` publishes its TLS port, on the host's **private** IP (dedicated host). Workers are never on this network, so a sandbox escape into a worker container cannot reach the API |

Defence in depth for TC-042 has three layers: (1) the sandbox has no network namespace access (`ENABLE_NETWORK=false`, `ALLOW_ENABLE_NETWORK=false`); (2) workers are on an internal network; (3) the host security group denies outbound by default (section 3.7). The Python worker never calls Judge0; only apps/api does (HTTP routes and its BullMQ Node consumers) (TB-4, owner-accepted ADR 0001).

### 4.2 `judge0.conf` settings

Rendered on the host at deploy time from secrets; the file is mode 0600 and never committed. Defaults are from upstream `judge0.conf` (verified, section 10).

| Setting | Upstream default | Ours | Why |
| --- | --- | --- | --- |
| `ENABLE_NETWORK` / `ALLOW_ENABLE_NETWORK` | false / **true** | false / **false** | TC-042. Closes the CVE-2024-29021 path |
| `ENABLE_CALLBACKS` | true | **false** | Judge0 never makes outbound requests (SSRF surface) |
| `ENABLE_WAIT_RESULT` | true | **false** | `wait=true` ties up server threads; we poll |
| `ENABLE_SUBMISSION_DELETE` | false | **true** | Delete after read (section 6) |
| `AUTHN_TOKEN` / `AUTHZ_TOKEN` | empty (off) | set per environment (format in section 4.4) | Section 5 |
| `ENABLE_COMPILER_OPTIONS` / `ENABLE_COMMAND_LINE_ARGUMENTS` | true / true | **false / false** | We never use them; less attack surface |
| `JUDGE0_TELEMETRY_ENABLE` | true | **false** | No instance id or version leaves the host (TELEMETRY.md) |
| `CPU_TIME_LIMIT` / `MAX_CPU_TIME_LIMIT` (s) | 5 / 15 | 2 / 10 | Per-question value is sent on every submission (section 7) |
| `WALL_TIME_LIMIT` / `MAX_WALL_TIME_LIMIT` (s) | 10 / 20 | 5 / 20 | as above; Judge0 requires a wall limit of at least 1 s |
| `MEMORY_LIMIT` / `MAX_MEMORY_LIMIT` (KB) | 128000 / 512000 | 262144 / 524288 | database.md default `memory_kb` is 262144 |
| `STACK_LIMIT` (KB) | 64000 | 64000 | upstream default |
| `MAX_PROCESSES_AND_OR_THREADS` | 60 | 60, raised only if Java fails S1 | TC-044 fork bomb |
| `MAX_FILE_SIZE` (KB) | 1024 | 1024 | Bounds output and files written in the box |
| `ENABLE_PER_PROCESS_AND_THREAD_TIME_LIMIT` / `..._MEMORY_LIMIT` | false / false | false / false | Limits apply to the whole program |
| `ENABLE_BATCHED_SUBMISSIONS` / `MAX_SUBMISSION_BATCH_SIZE` | true / 20 | true / 20 | One batch per question run |
| `COUNT` (workers) | 2 × nproc | nproc to start; the spike compares nproc and 2 × nproc | Timing stability under load |
| `MAX_QUEUE_SIZE` | 100 | 500 to start; set from the spike | Judge0 answers 503 when full |
| `ALLOW_IP` | empty | the fixed address of `judge0-tls` on `judge0-edge` | Only Caddy may call the server. Caddy itself accepts only the app host's private IP (the `api` container's fixed address in the co-located fallback) through its `remote_ip` matcher, behind the security group |
| `REDIS_PASSWORD` / `POSTGRES_PASSWORD` | must be set | random per environment | CVE-2024-29021 relied on a default password |
| `USE_DOCS_AS_HOMEPAGE` | false | false | |

### 4.3 Transport between apps/api and Judge0 (NFR-04: TLS 1.2+)

Judge0 serves plain HTTP on 2358, and every call carries the auth token, candidate code and hidden-test stdin.

| Option | For | Against | Verdict |
| --- | --- | --- | --- |
| a. **Caddy TLS terminator on the Judge0 host, private CA pinned by apps/api** | Works on any instance type and in the co-located fallback; one code path; we control it; Caddy is already in the stack (Apache 2.0) | A private CA and certificate per environment to issue and rotate | **Chosen** |
| b. Nitro in-transit encryption between instance types that support it | No certificates to manage | Holds only when **both** the app host and the Judge0 host are in supported families, in the same VPC, and never across the co-located fallback or a proxy. That support list and its exact conditions are **not verified**. It is invisible to apps/api, so nothing fails if an unsupported type is chosen later | Rejected as the control; may be kept as an extra layer |
| c. Plain HTTP inside the VPC | Simplest | Fails NFR-04 | Rejected |

Rules for option a (architect detail):
- A private CA per environment (staging, pilot, production, CI), created by the owner or DEP outside any agent session. The CA private key never sits on the Judge0 host or the app host; only the leaf certificate and key are on the Judge0 host (mode 0600), and only the CA certificate is in apps/api.
- Caddy listens on 8443 on the private IP, accepts TLS 1.2 and 1.3 only, and proxies to `server:2358` on `judge0-edge`. Automatic HTTPS and ACME are **off** (`auto_https off` globally); the site uses an explicit `tls <cert> <key>` with the leaf certificate, so Caddy never tries to reach a certificate authority.
- apps/api uses an HTTP client with `ca` set to the environment's CA certificate (the system trust store is not used for this client) and checks the hostname (`judge0.internal` or the host's private DNS name). `JUDGE0_URL` is `https://…:8443`; plain `http://` is refused at startup outside local tests.
- Leaf certificates last at most 1 year and are rotated by the deploy job; the CA certificate is valid for 5 years.

### 4.4 Token format

`AUTHN_TOKEN` and `AUTHZ_TOKEN` are each 32 random bytes from a CSPRNG, encoded as 64 lowercase hex characters (header-safe). Whether Judge0 compares tokens in constant time is **not verified** (section 10.1). TLS and the private network are the main protection against a network-level guessing attack; Judge0 only ever listens behind Caddy.

## 5. Authentication and secrets

| Secret | Holder | Where it lives | Marker |
| --- | --- | --- | --- |
| `JUDGE0_AUTH_TOKEN` (Judge0 `AUTHN_TOKEN`) | apps/api and the Judge0 host | Vault or GitHub Actions secrets; rendered into env on the hosts at deploy | architect detail |
| `JUDGE0_AUTHZ_TOKEN` (Judge0 `AUTHZ_TOKEN`, for DELETE) | apps/api and the Judge0 host | as above | architect detail |
| Judge0 Postgres and Redis passwords | Judge0 host only | as above; never in apps/api | architect detail |
| TLS leaf key and certificate (section 4.3) | Judge0 host only; apps/api holds only the CA certificate (not a secret) | as above; the CA private key stays offline with the owner | architect detail |
| Staging and pilot values of all of the above | never on developer machines or in agent sessions | GitHub Actions secrets and the servers | D-38, ADR 0009 (owner) |
| CI-host values | CI runner host only | GitHub Actions secrets of the CI job | architect detail |
| Local values | not needed (no local Judge0) | `.env.example` gets `JUDGE0_URL`, `JUDGE0_AUTH_TOKEN`, `JUDGE0_AUTHZ_TOKEN` as empty placeholders | architect detail |

- Tokens go only in headers, never in the URL (Judge0 docs say the same).
- Never log the tokens, source code, stdin, stdout of hidden tests, or Judge0 submission tokens (CLAUDE.md, ADR 0001 C-5). pino redaction covers `x-auth-token` and `x-auth-user`.
- The Judge0 HTTP client's error serialiser strips request headers and request and response bodies. A failed call logs only the method, the path without query string, the HTTP status, the Judge0 status id and the duration. Judge0 response bodies are never logged, and neither are BullMQ `failedReason` values built from them (ADR 0013 CS-4.7).
- Rotation: generate a new value, deploy it to Judge0 and apps/api in the same deploy, then restart both. Whether `AUTHN_TOKEN` accepts several values for a no-downtime rotation is **not verified**; until it is, rotate outside test windows.

## 6. Judge0's own data: retention and erasure (answers ADR 0013 Q23)

### 6.1 Options considered

| Option | Verdict |
| --- | --- |
| a. Keep Judge0 rows with the results tier (1 year, C-26) | Rejected. A second, unmanaged copy of code and hidden-test input; erasure (C-06) would have to reach into Judge0's schema |
| b. **Delete each submission right after its result is read, with a purge backstop and no backups** | **Chosen** (owner question 3) |
| c. Judge0 Postgres on tmpfs (nothing on disk) | Not chosen for now. Whether Judge0 re-creates its schema on start is **not verified**. The spike may try it (S4b); if it works, it removes the disk residue noted below |

### 6.2 Rules (architect detail)

| Rule | Detail |
| --- | --- |
| No expected output to Judge0 | apps/api sends only `source_code`, `language_id`, `stdin` and limits. It never sends `expected_output`, so hidden expected outputs never reach Judge0, and Judge0 never reports status 4 (Wrong Answer). apps/api compares the output itself |
| No identifiers to Judge0 | No candidate, session, question or org id goes to Judge0. Its rows cannot be linked to a person without our database |
| Delete after read | After a terminal result is read, apps/api calls `DELETE /submissions/{token}` (`X-Auth-User`). Judge0 refuses DELETE while a submission is In Queue or Processing; those are left to the purge |
| Purge backstop | A cron container on the Judge0 host runs every 10 minutes: `DELETE FROM submissions WHERE created_at < now() - interval '1 hour'` against Judge0's own database. Table and column names are checked in the spike (S4) |
| Bound | Code and test input stay in Judge0 for seconds normally, and **at most 1 hour plus 10 minutes** |
| Backups | Judge0's Postgres and Redis are never backed up or snapshotted. Upstream runs its Redis with `--appendonly no` |
| Logs | Judge0 container logs never go to CloudWatch (C-32 covers our logs only). The Judge0 server and worker containers use the Docker logging driver **`none`** by default. Only after spike S4 proves that neither writes request bodies, code, stdin or output may they move to the `local` driver with a small size cap. Health comes from the probe and apps/api metrics, not from Judge0 logs |
| Disk residue | Deleted Postgres rows stay in data pages until autovacuum reuses them. The volume is encrypted (EBS) and never backed up. Recorded as a known limit, not a breach of the bound |

**Effect on the clocks.** The C-06 erasure deadline (30 days), the C-26 results clock (1 year) and the C-27 face-image cap (90 days) need no Judge0 step: every Judge0 row is gone within about 70 minutes. Our own copy of the code (`submissions.source_code`, `session_questions.final_code`) is governed by ADR 0004 R-6 and R-10, unchanged (owner decisions C-06, C-26).

## 7. Resource limits, queueing and FR-502

| Limit | Value | Source |
| --- | --- | --- |
| CPU time, wall time, memory per test | `question_versions.limits` (default `cpu_ms` 2000, `wall_ms` 5000, `memory_kb` 262144) | database.md |
| Language run command (Java) | If S1 shows JVM warnings on stdout, language 91's run command in the Judge0 language configuration (applied by DEP-01 on top of the pinned upstream image; a custom compilers image remains owner question 4 and would need its own ADR) adds `-XX:-UsePerfData -Xlog:disable -Xlog:all=warning:stderr` before the main class (for example `java -XX:-UsePerfData -Xlog:disable -Xlog:all=warning:stderr Main`): `-XX:-UsePerfData` removes the hsperfdata warning itself, and `-Xlog:disable` clears HotSpot's default warnings-to-stdout output, because `-Xlog:all=warning:stderr` alone only adds a second output (JEP 158). S1 also checks that a JVM warning, if one occurs, appears on stderr only. The change lives in Judge0's languages configuration, so DEP-01 re-applies it on every deploy or boot (a re-seeded Judge0 database, S4b or a fresh pilot rebuild, would lose it) and the S1 clean-stdout check is re-run after every rebuild; per-submission command-line arguments stay disabled. The API never changes it per submission, and graders are never weakened (no stdout filtering or fuzzy matching). Publish validation (ADR 0007) runs the reference solution through Judge0, so a language-config problem that turns correct output wrong shows up before a candidate sees the question | architect detail (Database A's seed-test finding, 2026-10-06) |
| Per-language floor | `memory_kb = max(question, floor[language])`, and the same for time. Floors are set from spike S1 (the JVM may need more address space and time than Python) | architect detail |
| Upper caps | `cpu_ms` ≤ 10000, `wall_ms` ≤ 20000, `memory_kb` ≤ 524288; BE-04 validates them at authoring time | architect detail |
| Processes and threads | 60 | section 4.2 |
| Output | `MAX_FILE_SIZE` 1 MiB in the box; apps/api truncates each stream to 64 KiB before showing a Run result | architect detail |
| Sample tests per Run | at most 10, one batch | architect detail |
| Run rate | 1 per 5 s per session (Redis `SET NX PX 5000`). FR-502 says "per candidate"; a candidate has one live session at a time, so per session enforces it. Checked after the role, session and org guards and the open-section gate (ADR 0013 CS-4.6), and before any Judge0 call. The slot is released **only** when the breaker refuses the run before any Judge0 call. Once a batch was sent to Judge0, a 503 still uses up the slot, so a failing Judge0 cannot be hammered | FR-502; the release is an FR-502 deviation, architect detail, **owner question 9** |
| In flight to Judge0 | A Redis counter caps executions in flight. Run may use the whole cap; grading and validation (FR-203) together use at most 25 % of it, so Run latency comes first during test windows | architect detail |
| Poll | `GET /submissions/batch?tokens=…&base64_encoded=true&fields=token,status,stdout,stderr,compile_output,time,wall_time,memory,exit_code,exit_signal`, backoff 100 ms doubling to 1 s. Deadline: 15 s for Run, 120 s per batch for grading | architect detail |

**Load arithmetic (architect detail, to be measured).** 200 candidates at the FR-502 maximum would mean 40 runs per second, which no single host should be sized for. The assumed profile is one run per candidate per minute (about 3.3 runs per second), 3 sample tests each, and a language mix of 40 % Python, 40 % JavaScript and 20 % Java. Java compiles once per test, because each test case is its own Judge0 submission, so it dominates CPU. Above capacity, admission control answers 503 quickly instead of letting the queue grow.

## 8. Interface BE-05 builds against

### 8.1 ExecutionService (apps/api; architect detail)

```ts
type ExecPurpose = 'RUN' | 'GRADE' | 'VALIDATE';
type CaseOutcome =
  | 'ok' | 'compile_error' | 'runtime_error' | 'time_limit_exceeded'
  | 'memory_limit_exceeded' | 'output_limit_exceeded' | 'internal_error';

interface ExecCase { id: string; stdin: string }
interface ExecLimits { cpuMs: number; wallMs: number; memoryKb: number }
interface CaseResult {
  caseId: string; outcome: CaseOutcome;
  stdout?: string;        // every purpose, in memory only; see the rules below
  stderr?: string; compileOutput?: string; // RUN and VALIDATE only, truncated
  timeMs: number | null; wallMs: number | null; memoryKb: number | null;
}
interface ExecutionService {
  execute(req: { language: CodeLanguage; source: string; cases: ExecCase[];
                 limits: ExecLimits; purpose: ExecPurpose }): Promise<CaseResult[]>;
}
```

- The caller decides `passed`: normalise both sides (trim trailing whitespace on each line and at the end, as backend.md Step 5 says) and compare with the expected output. Only `ok` can pass.
- **`stdout` handling.** For `GRADE`, `stdout` exists only in memory for that comparison and is dropped right after. It is never persisted (the ADR 0013 `SUBMIT` results shape is unchanged), never logged, and never put in a BullMQ return value or `failedReason`. For `RUN`, only sample-test output reaches the candidate, truncated (section 7). For `VALIDATE`, the validation report keeps pass/fail per variant and test, not output.
- Language ids are read from `GET /languages` and matched by name: Python 3.8.1, JavaScript (Node.js 12.14.0), Java (OpenJDK 13.0.1) on 1.13.1. Ids are not hard-coded, because the public ce.judge0.com service lists newer runtimes with other ids than the self-hosted 1.13.1 image. The lookup is **lazy**, behind the breaker (section 9), and cached once it succeeds. apps/api **never fails to start** because Judge0 is unreachable: only Run, grading and validation fail, as section 9 describes. If Judge0 answers but one of the three languages is missing, that is a hard configuration error: the breaker stays open, every execution fails, and an alarm fires.
- `source` and `stdin` are sent base64-encoded (`base64_encoded=true`).
- No transaction is held while Judge0 runs (ADR 0013 "short transactions"). The `RUN` row (ADR 0013 CS-4.4) is written after the result.
- **Grading** (`grade-session`, ADR 0013 CS-4.7): any `internal_error` is retried once for that case. If it fails again, the job throws and writes nothing; recovery follows ADR 0013 (the grading reconciler re-creates the flow for SUBMITTED sessions older than 10 minutes, every 5 minutes). A case is never scored as failed because of an infrastructure error. A `time_limit_exceeded` whose CPU time is below half the limit (wall-clock time out under contention) is also retried once.
- **Retry cap for status 13 and 14.** Judge0 down (breaker open, timeouts, 5xx) is retried without limit, because the reconciler covers it. Status 13 (Internal Error) or 14 (Exec Format Error) on the **same** case, while Judge0 is otherwise healthy, can be deterministic, so it is capped: after 3 grading runs that end that way (counted in Redis per session question, TTL 7 days), `grade-session` stops running that question. It sets `scoring = 'MANUAL_PENDING'`, `score` NULL and a `scoring_note` saying execution failed, and fires an alarm. The rest of the session grades normally: `grade-session` makes the SUBMITTED → GRADED compare-and-set (ADR 0013 5.11), and `route-session` then moves GRADED → UNDER_REVIEW (ADR 0014, Proposed, on branch `arc/adr-0014-worker-api-contract`; C-28: every session is reviewed). The verdict is blocked until a person scores the question (ADR 0007 §5, as for short answers). Using MANUAL_PENDING for a coding question is new, with no schema change (**owner question 10**).

### 8.2 Judge0 status mapping (ids verified against `/statuses`)

| Judge0 status | `CaseOutcome` |
| --- | --- |
| 3 Accepted | `ok` |
| 4 Wrong Answer | not expected (no expected output is sent); treated as `ok`, and apps/api compares |
| 5 Time Limit Exceeded | `time_limit_exceeded` (TC-043) |
| 6 Compilation Error | `compile_error` (all cases) |
| 8 Runtime Error (SIGXFSZ) | `output_limit_exceeded` (to be confirmed in S3) |
| 7 SIGSEGV, 9 SIGFPE, 10 SIGABRT, 11 NZEC, 12 Other | `runtime_error`, or `memory_limit_exceeded` when memory used is at least 95 % of the limit or stderr shows the language's out-of-memory error (`MemoryError`, `OutOfMemoryError`, the JavaScript heap message). Judge0 has no memory status of its own, so this is a heuristic, calibrated in S3 (TC-044) |
| 13 Internal Error, 14 Exec Format Error, still 1 or 2 at the deadline, HTTP 5xx or timeout | `internal_error` |

### 8.3 Candidate contract change (packages/shared, through a hub PR after acceptance)

- `RunResult.outcome`: `completed | compile_error` plus the first failing execution outcome in test order (`runtime_error | time_limit_exceeded | memory_limit_exceeded | output_limit_exceeded`). This closes the follow-up "`RunResult.outcome` is narrower than Judge0" (docs/followups/architecture.md).
- `SampleTestResult.status`: `passed | failed | runtime_error | time_limit_exceeded | memory_limit_exceeded | output_limit_exceeded`.
- `internal_error` is never shown to the candidate. Run answers **503 `EXECUTION_UNAVAILABLE` with `Retry-After`**. The submit route is unchanged: it never calls Judge0 (ADR 0013 5.11).
- `submissions.results` for `SUBMIT` rows keeps the pinned shape `{ testCaseId, passed, status, timeMs, memoryKb }` (ADR 0013). `status` takes the `CaseOutcome` values except `internal_error`. No schema change.

### 8.4 Fake Judge0 for unit tests

BE-05 writes a fake that implements only the endpoints in use (`POST /submissions/batch`, `GET /submissions/batch`, `DELETE /submissions/{token}`, `GET /languages`), with scripted statuses, delays and 5xx. Contract tests run it on the Macs. Integration tests TC-042..TC-044 and TC-012 run only against real Judge0 on `judge0-x86`; their titles follow C-11 (`TC-042 FR-503 …`).

## 9. Failure modes and degraded mode

| Failure | Behaviour | Marker |
| --- | --- | --- |
| Judge0 down or unreachable | A health probe (`GET /about` over TLS, with `X-Auth-Token`, 1 s timeout, every 15 s) sets a Redis breaker; the probe also performs the lazy language lookup (8.1). While the breaker is open, Run answers 503 `EXECUTION_UNAVAILABLE` at once and gives the run slot back (section 7). The candidate sees "The code runner is temporarily unavailable. Your code is saved and will be graded." Autosave, draft and submit keep working (submit never needs Judge0) | architect detail |
| Judge0 queue full (HTTP 503 from Judge0) | Same as down, for that request only | architect detail |
| Grading during an outage | `grade-session` throws without writing scores. The grading reconciler re-creates the flow for SUBMITTED sessions older than 10 minutes, every 5 minutes, so grading resumes when Judge0 is back. A session stuck more than 1 hour raises the existing alert (ADR 0013, ADR 0004 9.4). While the breaker is open, the job may re-delay itself instead of failing (architect detail). Repeated status 13 or 14 on one case follows the cap in 8.1 | ADR 0013 (Proposed, C-23) |
| End-of-window grading burst | Grading may run behind; it is not latency-bound. S5 sets the pass bound | architect detail |
| Worker hang or one bad submission | The wall-time limit stops it; Judge0 restarts the worker container (`restart: always`) | upstream |
| Cgroup or kernel drift after patching | The boot check (section 3.5) keeps Judge0 down, which looks like "Judge0 down" above. The CloudWatch alarm fires | architect detail |
| Alerting | CloudWatch alarms on: breaker open for more than 2 minutes, Run p95 over 5 s for 5 minutes, any `internal_error` in grading, Judge0 host CPU over 85 % for 10 minutes, and disk or memory over 80 % | C-32 (owner); thresholds: architect detail |
| How host metrics leave the host | **From outside, with no IAM on the Judge0 host.** CPU comes from the standard EC2 `CPUUtilization` metric, which needs no agent. For disk and memory, a host cron writes a small JSON status file (percent used only) every minute. Caddy serves **exactly that one file** at `/_status`, from a dedicated directory that holds nothing else, with no directory browsing and no other path served from it, behind the same TLS and IP rule. The apps/api health probe reads it with a 4 KiB size cap and parses it with a strict zod schema: known keys only, numbers only, percentages from 0 to 100, a timestamp no older than 3 minutes. Anything else counts as unhealthy, and the content is never logged. apps/api then publishes the CloudWatch metrics from the app host. Its `cloudwatch:PutMetricData` grant is limited by a `cloudwatch:namespace` condition to the app's own namespace (for example `CodeProctor/Judge0`). The CloudWatch agent with the custom policy from section 3.5 (with the same namespace condition) is the fallback if this proves too thin | architect detail |

Time lost to an outage is not credited automatically (owner question 7).

## 10. Spike plan (on `judge0-x86`, then on the pilot-size instance)

Owner provisions the host; DEP runs the stages; the architect reviews results. Synthetic code and data only. The pilot-size instance used for S5 is discarded afterwards; the pilot Judge0 host is built fresh (section 3.2).

| Stage | What | Pass criteria |
| --- | --- | --- |
| S0 | One job on a GitHub-hosted `ubuntu-22.04` runner: start Judge0, run hello world | Record the result only. If it works, CI may use hosted runners and owner question 6 shrinks |
| S1 Bring-up | Ubuntu 22.04, cgroup v1, Judge0 1.13.1 by digest, section 4.2 settings. Hello world, stdin echo and a 1 s CPU loop in all three languages. Server tried without `privileged` | Cgroup v1 and `memory.use_hierarchy` present; 3/3 languages `Accepted`; `uname -r` recorded; per-language floor values recorded; **stdout is clean:** a correct Java reference solution that prints only its answer returns exactly that on stdout (no JVM warning such as the HotSpot `hsperfdata` message, which unified logging writes to stdout by default), in the sandbox as configured (memory limit, read-only filesystem), and the same check passes for Python and JavaScript |
| S2 Config | Request without a token; with a wrong token; with `enable_network: true`; with `callback_url`; with `wait=true`; DELETE without `X-Auth-User`; ports 2358 and 8443 probed from outside the VPC and from a non-app host inside it; plain HTTP to 8443; TLS 1.1 to 8443; a certificate from another environment's CA presented to apps/api; from the host shell, HTTPS to a host not on the proxy allowlist; from the host and a worker container, TCP to the app host, the database and an AWS API endpoint | 401, 401, network still off, callback never made, 400, 403, ports closed, refused, refused, apps/api refuses, refused, all refused (section 3.7) |
| S3 Abuse | The checklist below, each case run while a canary submission runs at the same time | Every expected result met; the canary's verdict is unchanged and its time is within 2 × idle; no host OOM-killer entries outside the box (`dmesg`); host stays responsive |
| S4 Retention | Submit runs containing a marker string in the code and stdin; read; DELETE; wait for the purge | Judge0 `submissions` row count 0 after DELETE (or after the purge for undeletable ones); with the `local` driver switched on for this test only, marker not found in Judge0 container logs (server and workers), Redis keys, or the isolate box directories inside the worker containers after the run (the box root path is recorded in S1); table and column names for the purge confirmed. Only if all pass may the logging driver move from `none` to `local` (section 6.2) |
| S4b (optional) | Judge0 Postgres on tmpfs; restart the stack | Judge0 starts with an empty database and passes S1 |
| S5 Load | k6 (scripts shared with BE-15A) against the API's Run route and directly against Judge0: profile of section 7 for 30 minutes at 200 virtual candidates; TC-091 burst of 50 concurrent runs; then 200 sessions submitted at once and graded (4 coding questions, 10 hidden tests each); then a ramp until p95 passes 5 s | Run p95 < 5 s end to end (NFR-01) and TC-091 p95 < 5 s; 0 `internal_error`; reference solutions give the same verdicts under load as at idle; Judge0 host CPU < 80 % sustained and memory headroom > 25 %; API p95 for other routes < 300 ms; grading backlog drained within 30 minutes; the ramp's knee recorded and used to size the pilot instance |

**S3 abuse checklist** (TC-042..TC-044 plus):

| Attack | Expected |
| --- | --- |
| TCP to 1.1.1.1:443, DNS lookup, HTTP to `db:5432`, `redis:6379`, `server:2358`, the app host, and 169.254.169.254 | All fail; tcpdump on the host shows no packets from the box (TC-042) |
| `while(true)` and `sleep(100)` | `time_limit_exceeded` at the CPU and wall limits; worker free afterwards (TC-043) |
| Fork bomb (Python `os.fork` loop, Java thread loop, Node `child_process`) | Stopped by the process limit; `runtime_error` or `time_limit_exceeded`; other sessions unaffected (TC-044) |
| Allocate 2 GiB | `memory_limit_exceeded` per the heuristic; no host OOM (TC-044) |
| Print 1 GiB; write a 1 GiB file | `output_limit_exceeded` within the wall limit; host disk unchanged; API response truncated |
| Read `/judge0.conf`, `/proc/1/environ`, `/etc/shadow`, `/var/run/docker.sock`, another box's directory | Not present or denied |
| Symlink out of the box before the run (CVE-2024-28185 and CVE-2024-28189 regression); `chown` tricks | No effect outside the box |
| `id`, setuid binaries, `ptrace` or `kill` of other processes | Unprivileged uid; denied |
| Write a file in run A, read it in run B | Absent |
| 100,000-character source (`MAX_SOURCE_CODE_LENGTH`); a Java class with a huge constant table | Compiles or fails within the limits; no worker stall |

### 10.1 What was verified for this ADR (2026-10-05)

| Fact | Status |
| --- | --- |
| Latest release is v1.13.1 (2024-04-18); it fixes CVE-2024-28185, CVE-2024-28189 and CVE-2024-29021; Ubuntu 22.04 with `systemd.unified_cgroup_hierarchy=0`; "only been tested on Linux" | Verified (judge0 CHANGELOG.md and GitHub releases page) |
| CVE-2024-29021 reached Judge0's Postgres through a networked submission and an unchanged default password; turning off `ALLOW_ENABLE_NETWORK` prevents it | Verified (Tanto Security write-up; press coverage) |
| `judge0.conf` names and defaults in section 4.2 | Verified (upstream `judge0.conf` on master) |
| Telemetry sends the instance id and version every 12 hours; `JUDGE0_TELEMETRY_ENABLE=false` turns it off | Verified (TELEMETRY.md) |
| Upstream compose: server and workers `privileged: true`; Postgres 16.2; Redis 7.2.4 with `--appendonly no` | Verified (docker-compose.yml on master). Redis 7.2 predates the 7.4 licence change |
| DELETE needs authorization and `ENABLE_SUBMISSION_DELETE`; refused for In Queue and Processing; batch GET supports `fields` and `base64_encoded`; callbacks are a PUT; `wait` can be disabled; no retention or auto-delete documented | Verified (ce.judge0.com API docs) |
| Status ids 1 to 14 | Verified (`/statuses`) |
| Self-hosted master languages: Python 3.8.1 (71), Node.js 12.14.0 (63), OpenJDK 13.0.1 (62) only; ce.judge0.com lists newer runtimes | Verified (`db/languages/active.rb` on master; ce.judge0.com `/languages`) |
| Judge0 cgroup v2 issue open since 2023-08-23; issue #554 (24.04, kernel 6.11) | Verified (search results and the issue page) |
| isolate 2.0 (2024-02-28) needs cgroup v2 | Verified (isolate NEWS, via search) |
| systemd 258 removed cgroup v1; Docker Engine 29 deprecated v1, supported until at least May 2029 | Verified (systemd v258 release notes, Docker release notes, via search) |
| AWS-managed `AmazonSSMManagedInstanceCore` (policy v2) allows `ssm:GetParameter` and `ssm:GetParameters` on `Resource: "*"` | Verified (AWS Managed Policy Reference, policy JSON read directly) |
| EC2 Instance Connect Endpoint gives SSH to instances without a public IP or an instance role | **Not rechecked today** (AWS feature since 2023) |
| Nitro in-transit encryption: which instance families support it, and under what conditions | **Not verified**; not relied on (section 4.3) |
| Judge0 compares `AUTHN_TOKEN` and `AUTHZ_TOKEN` in constant time | **Not verified** (section 4.4) |
| Ubuntu 22.04 standard support ends April 2027 | **Not rechecked today** |
| Docker Desktop on Apple silicon cannot run the sandbox; GitHub-hosted runners boot cgroup v2 | **Not verified** (S0 checks the second) |
| `AUTHN_TOKEN` accepts several tokens; Judge0 recreates its schema on an empty database; server works unprivileged; SIGXFSZ for output over the limit; memory heuristic; Judge0 logs contain request bodies; the purge's table and columns; the Java floor; instance prices | **Not verified**; each is a spike stage |

## 11. Consequences

- **Positive.** A sandbox escape on the pilot reaches a host with no stored candidate media, no app secrets, no IAM role and no network path to any data store. Judge0 keeps candidate code for minutes, not forever, and never sees expected outputs. Submit and autosave keep working when Judge0 is down. BE-05 can start now against the fake.
- **Residual risk (R-new-5).** The Judge0 host still holds candidate data and question-bank data while it works: in-flight candidate code and hidden-test stdin, normally for seconds and at most about 70 minutes (section 6.2), plus the Postgres disk residue. An escape could read them, and through the Judge0 tokens and TLS key on the host it could read or delete other in-flight submissions. It cannot reach stored media, the database or the app secrets. Remaining exfiltration channels, and how they are narrowed: (1) **DNS through the VPC resolver**, closed by the Route 53 Resolver DNS Firewall allowlist (section 3.7); (2) **hosts on a proxy allowlist**, which can receive data through an HTTPS tunnel. That is why pilot and production default to no-internet patching (option 2), leaving no proxy on those hosts. Accepted for the pilot, for the owner to confirm with question 1.
- **Negative and risks** (for the Delivery Lead to register):
  - R-new-1: one more instance per environment, and its patching.
  - R-new-2: Judge0 has had no release since April 2024. Its runtimes are end-of-life (Python 3.8, Node 12, OpenJDK 13), which limits language features for candidates (FU-DB-39 already writes seeds for them) and means unpatched runtime bugs inside the sandbox.
  - R-new-3: the design rests on cgroup v1: Ubuntu 22.04 support ends April 2027 and systemd and Docker are dropping v1. Before production, choose Ubuntu Pro (ESM) or a move to an isolate 2.x (cgroup v2) based runner, in a new ADR.
  - R-new-4: real-Judge0 tests run only on one self-hosted runner, so CI depends on that host being up. Jobs also share that host between weekly rebuilds (section 3.6). A malicious job from an account with write access could persist, read later jobs' CI-only tokens and TLS key, or fake TC-042..TC-044 results. The exposure is synthetic data and CI-only secrets; QA-02's re-run on staging is the independent check. For the owner to accept.
  - R-13 shrinks: Judge0 leaves the app host on pilot and production.

## 12. Agents affected

| Agent / task | Must do |
| --- | --- |
| backend-engineer BE-05 | ExecutionService (8.1), status mapping (8.2), fake Judge0 (8.4), delete-after-read, admission counter, breaker, language lookup by name; Judge0 in `infra/docker-compose.yml` under a Compose profile `judge0` with the networks of 4.1 (not started by `pnpm dev:infra`; Linux x86 only); `infra/judge0/` conf template with placeholders only; validate job (FR-203, TC-012); TC-042..TC-044 on `judge0-x86` |
| backend-engineer BE-04 | The limit caps in section 7 in the question DTO |
| backend-engineer BE-07, BE-11 | Run route: 503 `EXECUTION_UNAVAILABLE`, slot release only on a breaker short-circuit, `RUN` row after the result; `grade-session` retry rules and the status 13/14 cap with MANUAL_PENDING (8.1); in-memory-only `stdout` for grading |
| backend-engineer BE-15A | k6 scripts for S5 |
| backend-engineer DEP-01, DEP-03 (architect review, D-26) | Hosts per 3.2 and 3.5 (no instance profile, EC2 Instance Connect Endpoint, no secrets in user-data). The GitHub OIDC deploy role per 3.5: exact `aud` and `sub`, no wildcards, created **only after** the owner has set the `main`-only deployment branch policy (and required reviewers) on `pilot` and `production` (ADR 0013 control 1b); DEP-03 records that check in its PR. Then: egress per 3.7 (no-internet patching and the DNS Firewall allowlist on the pilot), host metrics through `/_status` (section 9), Caddy TLS and the private CA per 4.3, `judge0.conf` per 4.2 rendered from secrets, purge cron, `none` logging driver, boot check, alarms (section 9), runbook pages: kernel hold and patch deadline, cgroup check, Judge0 patching, token and certificate rotation. DEP-01 still needs the layout ADR for the other ARC-05 items, and that ADR must keep section 3.7 |
| backend-engineer DEP-02 | Checklist: spike results, R-new-2 and R-new-3, Judge0 data bound |
| qa-engineer QA-01B, QA-02 | The real-Judge0 workflow under the runner rules of 3.6 (push and `workflow_dispatch` only, `contents: read`, and a lint that fails any other workflow naming `judge0-x86`; the owner sets the fork PR repository setting); S3 checklist in the red team; TC-091 in the load run; propose TCs for `output_limit_exceeded`, 503 on Run and "never scored as failed on internal error" |
| frontend-engineer | Run panel shows the new outcomes and the 503 message (after the shared change) |
| architecture hub | After acceptance: `RunResult` change in packages/shared and the generated contract; architecture.md Deployment rows; ADR 0001 OI-5 (Judge0 part decided); ADR 0013 Q23 answered; the layout ADR (rest of ARC-05) |
| Delivery Lead | status.md R-01 mitigation and R-new-1..5; build-plan ARC-05 split (this ADR, then the layout ADR); PA-07 scope wording if owner question 1 is accepted. **retention-schedule.md (C-05) and dpia.md** list the transient copy of candidate code and test input in Judge0 (seconds, at most about 70 minutes, never backed up) and the Postgres disk residue (section 6.2), for owner approval |
| db-engineer, integrity-engineer | No change. No schema change |

## 13. Owner questions

1. **Dedicated Judge0 host for pilot and production** (section 3.1, option B; recommended). This changes PA-07 / DEP-03 ("its own AWS x86 instance running api, worker, redis, judge0 and caddy") and costs one more instance. Accept, or keep option A with its larger blast radius?
2. **Staging topology**: mirror the pilot with a small Judge0 instance (recommended, so the red team tests the real layout), or co-locate on the staging VM (D-04's one VM)?
3. **ADR 0013 Q23**: delete Judge0 submissions right after reading, purge at 1 hour, never back up (recommended), instead of keeping them with the 1-year results tier?
4. **Runtimes**: are Python 3.8.1, Node.js 12.14.0 and OpenJDK 13.0.1 acceptable for the pilot? The alternative is a custom compilers image (new ADR, our maintenance).
5. **Before production**: Ubuntu Pro (ESM) after April 2027, or plan the move to a cgroup v2 sandbox (R-new-3)?
6. **CI and spike host**: please provision one EC2 x86 instance in us-east-1 (Ubuntu 22.04 amd64, about 4 vCPU / 8 GiB, **no instance profile**, IMDSv2 hop limit 1, egress per section 3.7, access through EC2 Instance Connect Endpoint) and register it as an ephemeral self-hosted runner under the rules in section 3.6: label `judge0-x86`, used only by the real-Judge0 workflow (push and `workflow_dispatch` triggers only, `permissions: contents: read`), no environment or deploy secrets, fork PR workflows off (private) or approval required for all outside collaborators (public), rebuilt from a clean AMI at least weekly. Please also accept R-new-4 (jobs share the host between rebuilds). No credentials go into any agent session; DEP and the owner do this.
7. **Outage during a live test**: no automatic time credit (recommended; the recruiter can re-invite), or should the server pause the session while Judge0 is down?
8. **Load profile**: confirm the assumptions in section 7 (one run per minute, 3 sample tests, the language mix), or give better numbers.
9. **FR-502 deviation**: give the run slot back when the breaker refuses a run before any Judge0 call (recommended, so an outage does not also cost the candidate 5 s per attempt), or keep FR-502 strict? A run that reached Judge0 always uses the slot.
10. **Persistent execution errors in grading**: after 3 grading runs end with Judge0 status 13 or 14 on the same question, send that coding question to MANUAL_PENDING with an alarm (recommended, section 8.1), instead of retrying forever?
