# AWS: GitHub OIDC deploy role for the pilot (DEP-01 / DEP-03, PR 1)

Infrastructure code only. **No credentials, keys, tokens or account ids are in this directory, and
no agent session ever touches AWS.** The owner uploads the templates to their own AWS account and
approves every apply. Nothing here runs in CI.

How the pilot is deployed (SSM, SSH or another mechanism) is open and belongs to **ADR 0017
(pending)**. This README does not decide it: `ssm:SendCommand` and `ssm:StartSession` are denied to the
deploy role until that ADR says otherwise.

## Scope

- One AWS account, no Organizations, region `us-east-1` (the template refuses any other region).
- One environment: `pilot`. Staging is not on AWS.
- The pilot runs on a small number of EC2 instances started and stopped by EventBridge Scheduler,
  with S3, SES and CloudWatch. No RDS, NAT gateway or load balancer (explicitly denied to CI).
- Two templates, applied by the owner in this order: PR 1 `github-oidc-roles.yaml` (this section),
  then PR 1b `pilot-data-buckets.yaml` (last section).

## What PR 1 creates

| Resource                             | Name                                                                        | Purpose                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IAM OIDC provider                    | `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`         | Created only if `ExistingOidcProviderArn` is empty. No thumbprint: IAM no longer validates it for GitHub                                                |
| Role                                 | `codeproctor-pilot-deploy`                                                  | Assumable only by a workflow job that uses the GitHub environment `pilot`                                                                               |
| Managed policies                     | `codeproctor-pilot-deploy-core`, `-compute`, `-iam`, `-guard`, `-iamguard`  | The role's permissions (managed, because inline policies are capped at 10240 characters per role)                                                       |
| Managed policy                       | `codeproctor-pilot-boundary`                                                | Permissions boundary for the instance role and other workload roles. Usable only with instance-profile credentials                                      |
| Managed policy                       | `codeproctor-pilot-boundary-scheduler`                                      | Separate boundary for the EventBridge Scheduler execution role: start and stop of the tagged instances only                                             |
| Managed policy                       | `codeproctor-pilot-instance-ssm`                                            | Session Manager and SSM agent permissions for the instance role. **Not attached by this stack.** Whether SSM is the deploy path is an ADR 0017 question |
| Role (optional)                      | `codeproctor-pilot-plan` with `-plan-read`, `-plan-guard`                   | Read-only plan role. `CreatePlanRole`, default `false`                                                                                                  |
| S3 bucket, KMS key, alias (optional) | `codeproctor-pilot-tfstate-<account id>`, `alias/codeproctor-pilot-tfstate` | Terraform state. `CreateStateBucket`, default `false`                                                                                                   |

Every role and policy of the stack sits under the IAM path `/codeproctor-guardrails/`. Their ARNs
therefore never match the `codeproctor-pilot-*` allow patterns (the deploy role cannot edit its own
policies), and explicit denies cover them as well. The role name stays `codeproctor-pilot-deploy`;
use the ARN from the stack Outputs, which includes the path. Reserved names (denied to CI):
`codeproctor-pilot-deploy`, `-plan`, `codeproctor-pilot-deploy-*`, `codeproctor-pilot-plan-*`,
`codeproctor-pilot-boundary*`.

## What CI can and cannot do

The deploy role deploys compute. It does **not** create or configure data stores.

| Allowed to CI (pilot only)                                                                                                                               | Never allowed to CI                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Start, stop, run and terminate the tagged instances; EBS volumes; security groups and VPC pieces; tags                                                   | Create or delete any bucket; change any bucket policy, ACL, Block Public Access, ownership, versioning, lifecycle, encryption or replication |
| EventBridge Scheduler: a schedule group and schedules named `codeproctor-pilot-*`                                                                        | Create a KMS key, change a key policy, disable, re-alias, re-tag or delete any key                                                           |
| Secrets Manager containers `codeproctor-pilot-*` (including the Cloudflare DNS API token as a secret). Values are written by the owner, never read by CI | Read a secret value; change a secret's resource policy; delete a secret without its recovery window                                          |
| IAM: instance role, instance profile and scheduler role named `codeproctor-pilot-*`, with a boundary, tagged `Environment=pilot`                         | Users, access keys, login profiles, SAML or OIDC providers; change the deploy role, the boundaries or their policies                         |
| CloudWatch log groups, alarms; SES identities and configuration sets (tags); AWS Budgets                                                                 | Read log events, SSM parameter values, object data; send mail; RDS, load balancers, NAT, peering, transit gateway, VPN                       |

The recordings and backup buckets, their policies, Block Public Access, lifecycle and the data CMK
are created by the owner in a separate owner-applied template (PR 1b, below), never by CI.

### Controls by service

| Service                                      | Why                                                                | Control used                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EC2                                          | Run, start, stop, terminate the instances                          | Tags only (ids carry no names): `aws:RequestTag` on create, `aws:ResourceTag` on change and delete. RunInstances also requires IMDSv2, encrypted volumes, Amazon-owned AMIs and an instance type from `AllowedInstanceTypes`; `ModifyInstanceAttribute` cannot switch to another type; volumes are gp3 and at most `MaxVolumeSizeGiB`; IMDSv2 cannot be weakened. `Describe*` is account-wide (known limitation) |
| EventBridge Scheduler                        | Start and stop windows                                             | ARN prefix on the schedule group and schedules (no tag support)                                                                                                                                                                                                                                                                                                                                                  |
| S3                                           | Read configuration of the pilot buckets; the optional state bucket | ARN prefix `codeproctor-pilot-*` plus `aws:ResourceAccount` equal to this account. All bucket control-plane writes denied. Object access only on the state bucket                                                                                                                                                                                                                                                |
| KMS                                          | Read key metadata; use the state key                               | Tags (`aws:ResourceTag`); `Decrypt` denied except the state key and calls made through EC2 (`kms:ViaService`)                                                                                                                                                                                                                                                                                                    |
| SES                                          | Identities and configuration sets                                  | Identities are not name-prefixed: tags only. Tag on create only inside `CreateEmailIdentity`; `TagResource` needs the identity to already carry `Environment=pilot`. Configuration sets by prefix. Sending denied to CI                                                                                                                                                                                          |
| CloudWatch Logs                              | Log groups                                                         | ARN prefix (`/codeproctor/pilot/*` or `codeproctor-pilot-*`) plus tags; `DescribeLogGroups` on `log-group:*`. Reading events denied                                                                                                                                                                                                                                                                              |
| CloudWatch alarms                            | Alarms                                                             | ARN prefix only (updates cannot be tag-conditioned reliably)                                                                                                                                                                                                                                                                                                                                                     |
| Secrets Manager                              | Containers (Cloudflare DNS token and others)                       | ARN prefix plus tags. `GetSecretValue`, resource policy changes and forced deletion denied                                                                                                                                                                                                                                                                                                                       |
| SSM Parameter Store                          | Parameters under `/codeproctor/pilot/`                             | Path prefix. Write and delete only; reads denied. `SendCommand` and `StartSession` denied (ADR 0017)                                                                                                                                                                                                                                                                                                             |
| AWS Budgets                                  | Cost alerts                                                        | ARN name prefix only. `ModifyBudget` covers create and update; there is no tag condition                                                                                                                                                                                                                                                                                                                         |
| IAM                                          | Instance role, scheduler role, policies                            | Prefix, boundary condition, tags, explicit denies                                                                                                                                                                                                                                                                                                                                                                |
| RDS, ELB, NAT, peering, transit gateway, VPN | Not used                                                           | Explicit deny (cost guard rails)                                                                                                                                                                                                                                                                                                                                                                                 |

Also denied: Lambda, ECS, CloudFormation, CodeBuild, Glue, SageMaker, Batch and `sts:AssumeRole`.

## Owner steps (AWS console)

You type the repository values yourself. This document uses the placeholders `<owner>` and `<repo>`.

1. IAM, Identity providers: check whether `token.actions.githubusercontent.com` already exists. If it
   does, copy its ARN for step 4 and make sure it lists `sts.amazonaws.com` as an audience. The ARN
   must be in this account (the template refuses another account's ARN).
2. Sign in to the AWS console in **us-east-1** with your own admin identity. Never paste credentials
   anywhere else.
3. CloudFormation, Create stack, With new resources. Upload `infra/aws/github-oidc-roles.yaml`.
4. Stack name `codeproctor-github-oidc`. Parameters:
   - `GitHubOwner` = `<owner>` and `GitHubRepo` = `<repo>` (repository name only)
   - `ExistingOidcProviderArn` = empty, or the ARN from step 1
   - `CreateStateBucket` = `false` and `CreatePlanRole` = `false` (recommended; see the optional sections)
   - `AllowedInstanceTypes` = default `m7i.large,t3.small,t3.medium`, or narrow it
   - `MaxVolumeSizeGiB` = default `100`
5. Tick **I acknowledge that AWS CloudFormation might create IAM resources with custom names**
   (`CAPABILITY_NAMED_IAM`). Review and create.
6. When the stack is `CREATE_COMPLETE`, open Outputs and copy `PilotDeployRoleArn`, the two boundary
   ARNs and `PilotInstanceSsmPolicyArn`.
7. GitHub, repository Settings, Environments: create **`pilot`** and set:
   - **Required reviewers**: you. Turn on **Prevent self-review** if there is a second reviewer.
   - **Deployment branches and tags**: **Selected branches and tags**, add `main` only (and make `main`
     a protected branch).
   - Do not allow administrators to bypass protection rules.
   - Variables: `AWS_ROLE_ARN` = the role ARN, `AWS_REGION` = `us-east-1`. Role ARNs are not secrets and
     no access keys exist, so there is no secret to create.
   - Do not create a `staging` environment for AWS.
8. Account-level protections (once per account, console):
   - S3, Block Public Access settings for this account: turn on all four.
   - IAM Access Analyzer: create an account analyzer for external access (us-east-1).
9. SES: request production access (leave the sandbox), verify the sender identity and tag the identity
   `Environment=pilot` (the boundary allows sending only from identities with that tag).
10. Apply PR 1b (below), then verify with your own credentials (AWS CLI v2, a named or SSO profile):

    ```sh
    infra/aws/tests/simulate-principal-policy.sh --account-id <12 digits> --profile <profile>
    ```

11. Update: Update stack, read the change set. Rollback: a failed update rolls back by itself; after a
    successful update, update again with the previous template. Delete: Delete stack. State bucket and
    key (if created) are retained. To remove the state bucket, first remove its bucket policy (it
    denies deleting object versions), then empty it, then delete it.

### About the trust policy

The `sub` claim of a job that uses an environment is `repo:<owner>/<repo>:environment:pilot` and
**carries no branch or ref**. The trust policy therefore cannot, by itself, stop a workflow on another
branch from assuming the role if that workflow job uses the `pilot` environment. The controls are on
the GitHub side: required reviewers and the "main only" deployment branch rule in step 7. A stricter
option is a custom `sub` claim template for the repository (GitHub's OIDC customisation) that includes
`ref`; then tighten the trust policy to match. That is not done here. Other repositories, `pull_request`
workflows and other environments cannot assume the role (tested).

## Explicit denies and escalation paths

| Path                                                                                        | How it is closed                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reconfigure a data bucket (policy, ACL, public access, ownership, versioning, lifecycle)    | Not allowed, and denied for every bucket                                                                                                               |
| Create a KMS key with a chosen policy, or change a key policy                               | `CreateKey` and `PutKeyPolicy` denied (IAM cannot inspect a caller-supplied policy)                                                                    |
| Re-tag a key `Purpose=tfstate` to unlock state decryption, or strip the tag                 | Explicit deny on `TagResource`, `UntagResource`, `CreateKey` touching `Purpose`; all key tagging denied                                                |
| Change a secret's resource policy                                                           | `PutResourcePolicy`, `DeleteResourcePolicy` denied                                                                                                     |
| Create a role without limits                                                                | `CreateRole` only with the pilot boundary or the scheduler boundary, prefix `codeproctor-pilot-*`, tag `Environment=pilot`; explicit deny otherwise    |
| Use a role from outside the instance                                                        | Every boundary allow requires `ec2:SourceInstanceARN`: a role assumed from elsewhere gets nothing                                                      |
| Edit an owner-made, untagged `codeproctor-pilot-*` role                                     | `UpdateAssumeRolePolicy`, `DeleteRole`, tagging, `PassRole` and instance-profile changes need `aws:ResourceTag/Environment=pilot` on the role          |
| Remove or swap the boundary, or edit it                                                     | `Put/DeleteRolePermissionsBoundary` denied; boundary policies are under the guardrails path with explicit `iam:*` denies                               |
| Attach AdministratorAccess or any AWS managed policy                                        | `AttachRolePolicy` only with `iam:PolicyARN` like `policy/codeproctor-pilot-*`, on bounded roles                                                       |
| Attach the boundary or deploy policies as ordinary policies                                 | Explicit deny on those policy ARNs                                                                                                                     |
| Change the deploy role, its policies or its trust                                           | Explicit `iam:*` deny, path ARN and bare name                                                                                                          |
| IAM users, access keys, login profiles, groups, service credentials, SAML or OIDC providers | Not allowed; explicit deny by wildcard                                                                                                                 |
| Pass a powerful role to a code-running service                                              | `PassRole` only to `ec2` and `scheduler`, on tagged `codeproctor-pilot-*` roles; Lambda, ECS, CloudFormation, CodeBuild, Glue, SageMaker, Batch denied |
| Service-linked roles, `sts:AssumeRole`                                                      | Denied                                                                                                                                                 |
| Re-tag a resource into or out of scope                                                      | Any request or resource with another `Environment` value is denied; the EC2 `Environment` tag cannot be removed or rewritten                           |
| Cost blow-out                                                                               | Explicit deny on RDS, ELB, NAT, peering, transit gateway, VPN, key pairs, other instance types, large or non-gp3 volumes                               |

### Scheduler role and `iam:PassRole`

`ec2.amazonaws.com` is for the instance-profile role. `scheduler.amazonaws.com` is for the EventBridge
Scheduler execution role. That role must use its own boundary, `codeproctor-pilot-boundary-scheduler`,
which allows only `ec2:StartInstances` and `ec2:StopInstances` on instances tagged `Environment=pilot`
and no data access. It does not share the data boundary. `monitoring.rds.amazonaws.com` is not allowed
because RDS is not used.

### Residual risks (stated plainly)

- **Trust documents.** `CreateRole` and `UpdateAssumeRolePolicy` let the caller choose a trust policy
  (IAM has no condition key for it). A compromised pilot deploy job could trust an outside principal
  with a pilot role. The role is still capped by its boundary and, for the data boundary, only usable from
  an instance. Mitigation: required reviewers, CloudTrail alerts on `CreateRole` and
  `UpdateAssumeRolePolicy`.
- **Data loss through compute.** CI can still terminate instances, delete EBS volumes (`Terminate`,
  `DeleteVolume`) and delete secrets within their recovery window. Bucket lifecycle and data
  configuration are out of CI's reach, but a terminated instance loses anything not on S3. Recommended:
  a CloudTrail alert (EventBridge rule to SNS) for `TerminateInstances`, `DeleteVolume`, `DeleteSecret`,
  `ScheduleKeyDeletion`, `PutBucketPolicy`, `PutLifecycleConfiguration`.
- **Indirect data access.** A deploy role that can launch an instance with a role and user data can
  indirectly reach what that role reaches. The deploy role is isolated from everything else in the
  account, not from the pilot's own data. Required reviewers are the control.
- **Account-wide metadata reads.** `ec2:Describe*`, `ssm:DescribeParameters`, `scheduler:List*`,
  `cloudwatch:DescribeAlarms`, `kms:ListAliases` cannot be filtered by IAM.
- **`s3:ListBucket`** is used to read bucket configuration and also lists object keys. Candidate media
  keys are listed, never read.

## Optional: Terraform state (`CreateStateBucket`, default false)

`codeproctor-pilot-tfstate-<account id>` (S3 names are global, hence the suffix; it still matches
`codeproctor-pilot-*`) has versioning, SSE-KMS with its own CMK `alias/codeproctor-pilot-tfstate`,
Block Public Access, TLS-only, and a bucket policy that denies other `codeproctor-*` roles object access
and everyone deleting object versions. Locking uses the native S3 lock file (`use_lockfile`, Terraform
1.10 or later, no DynamoDB): `<key>.tflock` in the same bucket, which is why the roles may write and
delete `*.tflock`. The state key prefix assumed by the plan role is `pilot/`. The key is tagged
`Purpose=tfstate`, which every other control keys off. PR 2 (Terraform) is on hold; the owner may
never use it. Recommended: leave it off.

## Optional: plan role (`CreatePlanRole`, default false; needs `CreateStateBucket=true`)

A GitHub environment with required reviewers makes every job that uses it wait for approval, so the
deploy role cannot run an automatic plan on pull requests. `codeproctor-pilot-plan` is trusted for
`repo:<owner>/<repo>:pull_request` and reads infrastructure metadata and the state; it writes only
`pilot/*.tflock` objects and can list only the state bucket. It cannot read secrets, data objects, log
events or parameters, cannot decrypt any key but the state key, and changes nothing.

Residual risk: it is reachable from **any** `pull_request` workflow in this repository, including a
workflow file changed by the pull request's author. Such a workflow can read infrastructure metadata and
the state, and state can contain sensitive attributes. It can also write or delete lock objects (a
denial of service on applies, never data loss). Mitigations: secrets are created by AWS or the owner and
are not in Terraform state; branch protection and required review of workflow changes; fork pull
requests do not receive OIDC tokens by default. The owner has not decided. Recommendation: off.

## Cost notes (decisions for PR 4)

- An Elastic IP costs about 3.65 USD per month. The compute design uses DNS updates instead; any
  Elastic IP is a PR 4 decision.
- Stopped instances still bill for their EBS volumes. Costs are written in PR 4, not here.

## Offline test and its limits

```sh
python3 -m venv .venv && .venv/bin/pip install pyyaml
.venv/bin/python infra/aws/tests/test_isolation.py
.venv/bin/python infra/aws/tests/test_data_buckets.py
```

`test_isolation.py` runs 288 cases (all pass) and 20 structural checks; `test_data_buckets.py` runs 134 cases and 45 structural checks. It parses the template, resolves intrinsic functions (owner `example-owner`, repo
`example-repo`, account `111111111111`), and evaluates each case with explicit-deny-wins semantics,
boundary intersection, bucket and key policies and the trust conditions. Each case table row lists the
context keys supplied by hand. It exits non-zero on any mismatch. TC IDs for these cases are for QA to
allocate (`docs/test-cases.md` has no DEP section).

It approximates IAM: it cannot model which actions honour which condition keys in real services, tag
propagation delay, or multi-resource actions in full. **`simulate-principal-policy.sh`, run by the
owner against the deployed roles, is the authoritative check**, and the first real deploy is the final
one. cfn-lint was run offline with no findings (a dev tool, not a repository dependency).

## Things to verify at the first apply

- Tag-condition support for SES identities and CloudWatch Logs `CreateLogGroup`; the `aws:ResourceTag`
  evaluation for `iam:PassRole`; `ec2:Owner` on AMIs.
- `ec2:RunInstances` needs tag specifications on the instance, volume and network interface, plus
  subnets and security groups tagged `Environment=pilot`. Encrypted volumes use the `aws/ebs` key.
- Presigned URLs: the boundary requires `ec2:SourceInstanceARN`, so URLs must be signed by code running
  with the instance role. Check at first deploy that upload and playback URLs still work.
- KMS tag conditions can lag a few seconds after tagging.
- Policy size: each managed policy stays under 6144 characters (checked by the test).

## Open items for the Delivery Lead

- The deploy mechanism (ADR 0017, pending): SSM or SSH, and what `codeproctor-pilot-instance-ssm` is for.
- PR 2 Terraform, PR 3 workflow, PR 4 costs and PR 5 ordered manual steps remain on hold or open.

## PR 1b: owner-applied data stores (`pilot-data-buckets.yaml`)

Apply **after** PR 1 (the deploy role's denies, which protect these resources, come from PR 1). Stack
name `codeproctor-pilot-data`, region us-east-1, parameters below, no IAM capability needed. CI never
applies it.

| Resource          | Name                                                                     | Holds                                                                                                  | Backstop expiry (source)                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bucket            | `codeproctor-pilot-media-<account id>`                                   | Recordings, room scans, ID images, selfies, evidence (keys under `orgs/<org>/sessions/`, ADR 0013 5.7) | `MediaExpiryDays` = 90 (C-04, C-27; retention schedule)                                                                                                         |
| Bucket            | `codeproctor-pilot-results-<account id>`                                 | Report PDFs                                                                                            | `ResultsExpiryDays` = 365 (C-26, ADR 0004 R-10)                                                                                                                 |
| Bucket            | `codeproctor-pilot-consent-<account id>`                                 | Signed consent PDFs (`orgs/<org>/consents/`)                                                           | `ConsentExpiryDays` = 1095 (C-04, C-17, ADR 0004 R-9)                                                                                                           |
| Bucket            | `codeproctor-pilot-backup-<account id>`                                  | Nightly dumps (`db/dumps/`, written by `infra/backup/backup.sh`) and WAL (`db/wal/`)                   | `BackupRetentionDays` = 14 (retention schedule); `WalRetentionDays` = 14 (**flagged**: the schedule does not name WAL; conservative default equal to the dumps) |
| KMS key and alias | `alias/codeproctor-pilot-data`, tags `Environment=pilot`, `Purpose=data` | One customer-managed key for all four buckets, rotation on, Bucket Keys on                             | none                                                                                                                                                            |

Every bucket: Block Public Access (all four), ownership enforced, TLS-only policy, default SSE-KMS with
the one key, abort-incomplete-multipart after 7 days, `Retain` on delete, no versioning.

- **No versioning, by design.** ADR 0004 9.2 makes RetentionService fail closed if versioning was ever
  on without a one-day noncurrent expiry, and noncurrent versions would break the 14 day backup rule.
- **The key.** The owner administers it through IAM (root delegation). The key policy lets only the
  instance role (`InstanceRoleName`, default `codeproctor-pilot-app`) use it, for `Decrypt`,
  `GenerateDataKey*` and `DescribeKey` through S3. Every other `codeproctor-*` role is denied use and
  administration, so CI cannot touch it. The tag `Purpose=data` and the alias match the PR 1 denies.
  The instance role need not exist yet (the key policy matches it by ARN condition, not as a named principal).
- **Bucket policies** deny object access to every `codeproctor-*` role except the instance role, and
  deny bucket configuration changes to every `codeproctor-*` role. You (the owner) are not one of them.
  The deploy role of PR 1 can still read configuration and list keys.
- **Lifecycle is a backstop.** RetentionService deletes on the real clocks (anchor plus
  `retention_days`, the face clock, review and appeal holds). Expiry by object age cannot see holds or an
  organisation's setting above 90 days.

### Blocker for the lifecycle rules: the API uses one media bucket today

`.env.example` has `S3_MEDIA_BUCKET` (media, IDs, report PDFs and consent PDFs together under
`orgs/<org>/...`) and `S3_BACKUP_BUCKET`. S3 lifecycle prefixes are literal, so media, results and
consent can only be expired separately in separate buckets. Until the API writes reports and consent
PDFs to their own buckets (a Backend and architect change, not in this PR), keep
`SeparateBucketsInUse=false`: the media, results and consent expiry rules are created **disabled** and
nothing is deleted early. Set it to `true` afterwards. With `false` the backup bucket rules (14 days)
still apply, because that bucket already exists in the API configuration. Also flagged: with holds,
a report can be needed after 365 days from its creation; consider `ResultsExpiryDays` of 400 or more.

### Owner steps for PR 1b

Apply order: (1) account-level S3 Block Public Access on and IAM Access Analyzer (step 8 above),
(2) PR 1 stack `codeproctor-github-oidc`, (3) PR 1b stack `codeproctor-pilot-data` with
`InstanceRoleName` matching the instance role you will create, `SeparateBucketsInUse` = `false`, the
other values as listed. Copy the bucket names from the Outputs into the pilot environment
configuration (`S3_MEDIA_BUCKET`, `S3_BACKUP_BUCKET`). Verify with
`simulate-principal-policy.sh` and the two offline tests. Presigned URLs: verify at first deploy that
upload and playback still work with the bucket policy (they are signed by the instance role).
