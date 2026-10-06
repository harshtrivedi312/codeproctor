# AWS: the CI deploy role and the pilot data stores (DEP-01 PR 1 and PR 1b)

Infrastructure code only. **No credentials, keys, tokens or account ids are in this directory, and no
agent session ever touches AWS.** The owner uploads the templates to their own AWS account and approves
every apply. Nothing here runs in CI.

This follows ADR 0017 (Proposed, approved in review; read at head b61b58e) sections 3, 5, 6, 7 and 8 and the
owner decisions C-49 to C-55 (PR #238; they replace the older C-43a wording). Where this README and the ADR
differ, the ADR wins; the differences are listed in "Open items".

## Scope

- One AWS account, no Organizations, region `us-east-1` (the templates refuse any other region).
- One environment, `pilot`. No staging on AWS. No Terraform, no plan role, no state bucket (C-54).
- **CI is narrow (ADR 0017 section 7).** The CI role `codeproctor-pilot-deploy` can push images to ECR
  repositories `codeproctor-pilot-*` (only if `UseEcr` is true) and `s3:PutObject` on the two release manifest
  prefixes. Nothing else. A compromised CI job can at worst publish a manifest that the hosts refuse to run
  (section 6: signed manifest pulled at boot, no SSM `SendCommand`, no key pairs).
- **Everything else is applied by the owner**, by hand, in templates of their own.

## What the owner applies (ADR 0017 section 7)

| Template                                  | Status                                   | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-oidc-roles.yaml` (PR 1)           | here                                     | The GitHub OIDC provider, the CI role and its policies, the unattached SSM instance policy                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pilot-data-buckets.yaml` (PR 1b)         | here                                     | The data KMS key, the media, backup and releases buckets and their policies, the backup expiry role, the backup alarms                                                                                                                                                                                                                                                                                                                                                                                                 |
| Hosted zone template                      | later (hub, ADR 0017 section 8)          | The `assess` public hosted zone and its static records                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Instance, roles and scheduler template(s) | later                                    | Instance roles and templates (IMDSv2, hop limit 2 on the main instance and 1 on Judge0, shutdown behaviour stop), the restore role and the restore drill template, the schedule groups and the three scheduler roles (start-only, stop-only, invoke-only, with `aws:SourceArn` trust), the create-only ceiling group and the backstop, the probe, the DLQ and SNS topic, the DNS reset rule and function, the owner's Session Manager role, log group and alert, the S3 gateway endpoint policy, the CloudTrail alerts |
| Backup expiry function and daily schedule | later (code owned by the database track) | The function that expires the physical backup repository. Its role is created in PR 1b                                                                                                                                                                                                                                                                                                                                                                                                                                 |

None of the instance roles, scheduler roles, profiles, boundaries or the instance's security groups exist in
these two templates, and CI has no IAM at all: **CI never creates a role**. Role names that PR 1b expects (you
type them as parameters, the roles are made by you in the later template, with path `/`, tagged
`Environment=pilot`): the main instance role (`InstanceRoleName`, default `codeproctor-pilot-app`), the Judge0
role (`Judge0RoleName`) and the restore role (`RestoreRoleName`). The Judge0 host must use a different role than
the main host.

## PR 1: what the stack creates

| Resource          | Name                                                                | Purpose                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IAM OIDC provider | `token.actions.githubusercontent.com`, audience `sts.amazonaws.com` | Only if `ExistingOidcProviderArn` is empty. No thumbprint (IAM no longer validates it for GitHub)                                                                                                                                                                                       |
| Role              | `codeproctor-pilot-deploy` (path `/codeproctor-guardrails/`)        | Assumable only by a workflow job that uses the GitHub environment `pilot`                                                                                                                                                                                                               |
| Managed policies  | `codeproctor-pilot-deploy-release`, `-ecr` (if `UseEcr`), `-guard`  | The Allow list and the explicit denies                                                                                                                                                                                                                                                  |
| Managed policy    | `codeproctor-pilot-instance-ssm`                                    | SSM agent registration plus the Session Manager channels only (`ssm:UpdateInstanceInformation`, `ssmmessages:*Channel`). Not attached by this stack; the owner attaches it to the instance roles. `ec2messages` is left out because Run Command is not used (verify at the first start) |

Parameters: `GitHubOwner`, `GitHubRepo` (no defaults), `ExistingOidcProviderArn`, `UseEcr` (owner decision:
`true` = ECR push, `false` = a registry that needs no AWS permission), `AssessHostedZoneId` (leave empty).

### What the CI role can and cannot do

| Allowed                                                                         | Denied (explicitly, on top of the missing Allow)                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s3:PutObject` on `codeproctor-pilot-releases-<account>/main/*` and `/judge0/*` | Reading, listing, deleting or tagging any object; any other prefix or bucket; every bucket control-plane action; Object Lock actions (`BypassGovernanceRetention`, retention, legal hold)                                          |
| ECR push on `repository/codeproctor-pilot-*` (if `UseEcr`)                      | Creating or administering repositories, any other repository                                                                                                                                                                       |
|                                                                                 | `ec2`, `scheduler`, `iam`, `kms`, `secretsmanager`, `ssm`, `logs`, `cloudwatch`, `events`, `sns`, `sqs`, `ses`, `budgets`, `rds`, load balancers, Lambda, ECS, CloudFormation, CodeBuild, Glue, SageMaker, Batch, `sts:AssumeRole` |
|                                                                                 | `route53:*` and `route53domains:*` on every hosted zone except `AssessHostedZoneId` (empty means none); `GetChange` and `ListHostedZonesByName` are denied too                                                                     |
|                                                                                 | Anything tagged or being tagged `Environment` with a value other than `pilot`                                                                                                                                                      |

The data buckets, the key and the instances are therefore unreachable to CI, whatever a workflow says.

### Trust policy and the GitHub environment (hard gate)

Trust is `StringEquals` on `sub` = `repo:<owner>/<repo>:environment:pilot` and `aud` = `sts.amazonaws.com`.
The `sub` claim of an environment job **carries no branch or ref**, so the trust policy cannot stop a workflow
on another branch that uses the `pilot` environment. The controls are on the GitHub side, and they are the
gate that protects this role. Before the first deploy:

- Environment `pilot`: the owner is the only **required reviewer**, **prevent self-review** on, **Deployment
  branches and tags** = Selected, `main` only (and `main` protected), **administrators cannot bypass**.
- Agent sessions use a **fine-grained token with no Actions, Deployments or Environments write and no push to
  `main`**, so an agent cannot start or approve a deploy.
- Approval is by the owner with MFA.
- A pilot environment whose only reviewer is the owner is a workflow change that goes through the hub.
- A stricter option is a custom `sub` claim template that includes `ref`, with a matching trust policy. Not
  done here.

## Owner steps and order

1. **Before any apply (once per account, console):** turn on **account-level S3 Block Public Access** (all
   four), create an **IAM Access Analyzer** (external access, us-east-1) and a **CloudTrail trail** (the
   EventBridge alerts of the later templates need it). Request **SES production access** early.
2. **GitHub:** create the `pilot` environment and the settings above. Add the environment variables
   `AWS_ROLE_ARN` (from the stack Outputs) and `AWS_REGION=us-east-1`. Role ARNs are not secrets and no access
   keys exist. Check the existing OIDC provider (IAM, Identity providers): if
   `token.actions.githubusercontent.com` exists, copy its ARN (it must be in this account and list
   `sts.amazonaws.com` as an audience).
3. **Apply in this order**, each as a CloudFormation stack in us-east-1:
   1. `github-oidc-roles.yaml`, stack name `codeproctor-github-oidc`, parameters `GitHubOwner=<owner>`,
      `GitHubRepo=<repo>`, `ExistingOidcProviderArn` (empty or the ARN), `UseEcr`, `AssessHostedZoneId` empty.
      Tick `CAPABILITY_NAMED_IAM`.
   2. `pilot-data-buckets.yaml`, stack name `codeproctor-pilot-data`: key, media, backup and releases buckets
      and the backup expiry role. Tick `CAPABILITY_NAMED_IAM`. Parameters: `AppOrigin`, the three role names,
      the alarm values. Leave `AlarmTopicArn` empty until the topic exists.
   3. The hosted-zone template (later), then add the NS delegation in the main zone **by hand**.
   4. The instance, roles and scheduler template (later). Then update the topic ARN in the data stack.
   5. Only then set `AssessHostedZoneId` by a stack update of `codeproctor-github-oidc`.
4. **Verify** with your own credentials (AWS CLI v2, a named or SSO profile):

   ```sh
   infra/aws/tests/simulate-principal-policy.sh --account-id <12 digits> --profile <profile> [--assess-zone-id <id>]
   ```

   It simulates the CI role, reads the live versioning and Object Lock settings and checks every
   `codeproctor-pilot-*` role is tagged `Environment=pilot` or `Environment=owner`. Set a CloudTrail or Access
   Analyzer alert on `UpdateAssumeRolePolicy` and `CreateRole` for `codeproctor-pilot-*`.

5. Update: Update stack and read the change set. Rollback: a failed update rolls back by itself. Delete: the
   data buckets and the key have `Retain` and survive a stack delete (without lifecycle and policy); to remove
   one, first remove its bucket policy.

## PR 1b: the data stack (`pilot-data-buckets.yaml`)

Apply after PR 1. CI cannot change any of this (its denies come from PR 1). Layout from ADR 0017 5.1 and
DL-40: one media bucket, one backup bucket, one releases bucket.

| Bucket                                                    | Content                                                                                                   | Written by                                                            | Read by                                              | Rules                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codeproctor-pilot-media-<account>` (`S3_MEDIA_BUCKET`)   | Recordings, images, evidence, reports, consent PDFs under `orgs/<org>/...`                                | main instance role (and candidates by presigned PUT)                  | main instance role                                   | **Unversioned** (RetentionService, ADR 0004 9.2). SSE-KMS with the data key and Bucket Keys. Abort incomplete multipart after 7 days. Objects tagged `RetentionClass=face` expire after **88 days** (C-27, C-35). Nothing else expires by age. CORS from `AppOrigin` |
| `codeproctor-pilot-backup-<account>` (`S3_BACKUP_BUCKET`) | `db/dump/latest.dump`, `db/wal/` (full base backups and WAL), `db/erasure-list/`, `db/erasure-completed/` | main instance role (put, get, list; **no delete, no delete version**) | main instance role, restore role (get, list)         | **Versioning ON and Object Lock enabled at creation**, GOVERNANCE, default 12 days. Dump lifecycle below. SSE-KMS with the data key                                                                                                                                  |
| `codeproctor-pilot-releases-<account>`                    | Signed release manifests under `main/` and `judge0/`                                                      | CI role (put on the two prefixes)                                     | main role reads `main/`, Judge0 role reads `judge0/` | Unversioned, SSE-S3 (no candidate data), no lifecycle (the owner prunes old manifests; "keep the last 10" is not expressible in lifecycle)                                                                                                                           |

Every bucket: Block Public Access (all four), ownership enforced, TLS-only, `Retain` on delete, and a bucket
policy that denies every other `codeproctor-*` role object access, listing and configuration changes.
Account administrators (you) are not `codeproctor-*` roles and keep access through IAM: the policies do not make
access instance-role-only.

### Backups (ADR 0017 5.3, C-55)

- **Dumps.** The instance writes every dump to the one key `db/dump/latest.dump` in a single `PutObject` that
  carries its checksum and row counts (`aws s3 cp` switches to multipart above 8 MB, so the uploader must use a
  single `put-object` or set the multipart threshold). Each overwrite leaves the previous version as a noncurrent version
  (the bucket is versioned, and the instance role cannot delete). The lifecycle rule on `db/dump/` has
  `NewerNoncurrentVersions` **2** and `NoncurrentDays` **1** and **no current-version expiry**: the current
  version plus the 2 newest noncurrent versions (the newest 3 dumps) survive at any age. An older dump goes at
  the later of its creation plus 12 days (Object Lock) and its replacement plus 1 day, plus S3's delay.
  There is **no day-30 expiry**: day 30 is the owner's decision (the 28 day alarm fires).
- **Object Lock.** GOVERNANCE, 12 days, set when the bucket is created. It needs versioning. **S3 has allowed
  enabling Object Lock on an existing versioned bucket since late 2023, but the cautious advice stays: if a
  backup bucket was ever made without it, replace it, do not reconfigure it.** An Object Lock bucket needs
  Content-MD5 or a checksum on every upload and every part. No role the instance or CI can assume holds
  `s3:BypassGovernanceRetention` (denied in the CI policy and, for every `codeproctor-*` role, in the bucket
  policy); only the owner's own principal can bypass. A lifecycle expiry of a locked version is skipped and
  happens once the lock ends (documented S3 behaviour: modelled offline, unverified, listed in the first-apply
  checks). **Limit:** the lock runs from each version's own creation, so it protects recent dumps only. If
  backups stalled for more than 12 days and 3 junk versions then displace the real dumps, the older displaced versions expire at once and the newest displaced one after 1 day; only the alarms below
  help (offline model case).
- **Physical repository (`db/wal/`).** No lifecycle rule. An owner-applied expiry function (never on the
  instance; role `codeproctor-pilot-backup-expiry` is created here) keeps everything younger than 12 days
  plus the newest 3 full base backups and the WAL from the oldest of them, and deletes the rest. Only full
  base backups are taken. The role can list the bucket and delete **only under `db/wal/`,
  `db/erasure-list/` and `db/erasure-completed/`**; a bucket-policy deny stops it deleting under `db/dump/`,
  which lifecycle owns. It also carries the Route 53 deny for every zone but the assess zone
  (`AssessHostedZoneId`). The function, its daily schedule and the code are a later owner template (database
  track). The same function prunes the erasure-list entries (the instance cannot delete).
- **Expiry role trust (not verified, may fail closed).** The trust names the Lambda service with
  `aws:SourceAccount` and `aws:SourceArn`. Lambda probably does not populate those keys when it assumes an
  execution role, so the condition may fail closed (the function cannot be created and backups never
  expire). If so, **the fallback is to remove the condition** (not to keep only `aws:SourceAccount`, which
  fails the same way). The real guard is then: **no `codeproctor-*` role may hold `iam:PassRole` on the expiry
  role, or `lambda:CreateFunction`, `UpdateFunctionCode` or `UpdateFunctionConfiguration`.** CI already denies
  `iam:*` and `lambda:*`; this is a requirement on the owner's later templates.
- **Alarms** (CloudWatch; they notify `AlarmTopicArn`, the owner's SNS email and SMS topic; with no topic the
  alarms exist without an action). **The threat is a compromised main instance, so the instance is not the
  producer of any alarmed metric.** The owner-applied expiry Lambda is the only producer of every metric in
  namespace `codeproctor-pilot`, all computed from `ListObjectVersions` on `db/dump/` and `db/wal/` (Size,
  LastModified):

  | Alarm                                            | Metric (producer)                                                           | Fires                                                              |
  | ------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
  | `codeproctor-pilot-backup-stale-2d`              | `NewestDumpAgeHours`, Maximum (expiry Lambda)                               | The newest dump is older than 48 hours (missing data breaches)     |
  | `codeproctor-pilot-backup-age-28d`               | `OldestKeptBackupAgeDays` (expiry Lambda)                                   | A kept backup reaches 28 days (the owner decides; nothing deletes) |
  | `codeproctor-pilot-backup-dump-size-anomaly`     | `DumpSizeChangeFactor` = max(new/old, old/new), always >= 1 (expiry Lambda) | More than `DumpSizeChangeFactor` (3)                               |
  | `codeproctor-pilot-backup-dump-versions-per-day` | `DumpVersionsPerDay` (expiry Lambda)                                        | More than `MaxDumpVersionsPerDay` (3) new dump versions in a day   |
  | `codeproctor-pilot-backup-base-backup-count`     | `FullBaseBackupCountChange`, the ABSOLUTE change (expiry Lambda)            | More than `MaxFullBaseBackupCountChange` (2) in a day, up or down  |
  | `codeproctor-pilot-backup-uploader-silent-2d`    | `BackupSuccess` in namespace `codeproctor-pilot-instance` (the uploader)    | Secondary signal only: no success reported for 2 days              |

  **Requirement for the owner's instance template:** the instance role's `cloudwatch:PutMetricData` carries
  the condition `cloudwatch:namespace` = `codeproctor-pilot-instance`, so the instance cannot inflate any
  alarmed metric. The Lambda is a dependency outside this template (database track): until it exists the
  freshness and age alarms sit in ALARM (missing data breaches), so the first email is expected. The
  anomaly alarms' design is not verified.

- **Erasure and the exception.** Kept backups can hold an erased person's rows beyond 14 days in a stall; ADR
  0004 9.7 re-applies the erasure list after a restore (DPIA note).

### The key

One customer-managed KMS key for the media and backup buckets, rotation on, Bucket Keys on, tags
`Environment=pilot` and `Purpose=data`, alias `alias/codeproctor-pilot-data`. You administer it through IAM. The
main instance role (through S3: `Decrypt`, `GenerateDataKey*`, `DescribeKey`) and the restore role (`Decrypt`
and `DescribeKey` through S3) may use it. Every other `codeproctor-*` role is denied use and administration, so
CI, Judge0 and the expiry role get nothing. Presigned URLs and the bucket policies: `PutObject` is denied for
any algorithm but `aws:kms`, any key but the data key, and `aws:kms` with no key id (that would use `aws/s3`);
a request with no encryption header uses the bucket default. `BACKUP_SSE` must be **empty** on pilot. The key id
condition matches the key ARN form, not an alias.

## Cost note

No Elastic IP (C-48, C-49): CI cannot allocate one and it is not in these templates. Costs are written
elsewhere.

## Offline tests and their limits

```sh
python3 -m venv .venv && .venv/bin/pip install pyyaml
.venv/bin/python infra/aws/tests/test_isolation.py
.venv/bin/python infra/aws/tests/test_data_buckets.py
```

`test_isolation.py` runs 154 cases and 16 structural checks on the CI role, the Route 53 guard and the trust
policy (a DENY expectation means an explicit deny, so removing a guard statement fails cases) (owner `example-owner`, repo `example-repo`, account `111111111111`). `test_data_buckets.py` runs 153 cases and 44 structural checks on the buckets, the key, the expiry role, the alarms, a model of the backup
lifecycle, and the proof (with the real CI policies) that CI can only put the two manifests. A case can expect
"no explicit deny" or "implicit deny" when the real allow is a policy the test does not model. Each case row
lists the context keys supplied by hand. TC IDs are for QA to allocate (`docs/test-cases.md` has no DEP
section). The tests approximate IAM and the lifecycle engine; **`simulate-principal-policy.sh`, run by the owner
against the deployed stacks, is the authoritative check**, and the first real apply is the final one. cfn-lint
was run offline with no findings (a dev tool, not a repository dependency).

## Things to verify at the first apply

See FU-QA-13 in `docs/followups/qa.md`. In short: ECR push and manifest put; Object Lock at creation with
versioning, and a skipped-then-expired locked version; the expiry role trust with `aws:SourceArn`; the alarms
and their producers; browser PUT through CORS with `x-amz-tagging`; the instance role starting with an encrypted
EBS volume; the `hostedzone/` sentinel for an empty `AssessHostedZoneId`; `RetentionService`'s startup checks;
presigned URLs; whether `ec2messages` is needed.

## Residual risks and notes

- **CI and images.** CI can push an image to the ECR repositories. The hosts run only digests named in a
  signed manifest and refuse anything else (ADR 0017 section 6); the signing identity is baked in by the owner.
- **Account-wide metadata.** `ec2:Describe*` and similar reads are not granted to CI at all.
- **Instance user data** is readable through `ec2:DescribeInstanceAttribute` by whoever has it: never put
  secrets in user data (ADR 0016 section 3.5).
- **The owner-made roles** must be tagged `Environment=pilot` (or `Environment=owner` for roles that are not
  part of the pilot). A role that carries the permissions of the instance but a trust policy that includes an
  outside principal is the owner's template to prevent; recommended alert on `UpdateAssumeRolePolicy`.
- **Role design choice (B3).** The earlier permissions boundaries, the scheduler boundary and the instance-role
  creation by CI are removed: the owner creates the roles, and CI has no IAM, so a boundary would only guard
  something CI can no longer do. A boundary kept as an owner-side guardrail would have to restate ADR 0017
  sections 3, 4.1 and 8 exactly (the old workload boundary could not host the main role: it allowed delete on
  every bucket, denied `iam:*` so `PassRole` to the scheduler roles was impossible, and had no ECR pull or
  Route 53 allow). The smallest correct template is none.

- **Signing is the real gate for deployed code.** CI can push images and write manifests; what stops CI from
  deciding which code reaches candidate data is who produces the manifest signature (ADR 0017 section 6). If
  signing is keyless inside CI, CI effectively decides what code runs: keep the identity check and the
  environment gate (above) as the control.

## Open items

- **Hub:** amend ADR 0017 wording where it differs (see FU-QA-20): 12 days (not 13 or 14) for the lock, the
  7 day against 2 day freshness alarm, 28 against 30 days for the second alarm.
- **Database track:** `infra/backup/backup.sh` and `erasure-list.sh prune` do not match section 5.3 (FU-QA-18,
  FU-QA-19); `docs/runbook.md` and FU-DBB-06 still recommend `AES256`.
- **Owner:** `UseEcr`; whether lifecycle may delete the last dump (it cannot: current versions never expire);
  day 30 handling; 88, 90 or 91 days for the face backstop; the optional "deny every principal except the
  instance role, restore role and a named owner-admin role" on the media and backup buckets (not done: it
  risks locking you out; it would need an owner-admin role name parameter).
- **Later templates:** the hosted zone, the instance, scheduler and restore templates, the expiry function and
  schedule, and the pilot environment workflow change.
