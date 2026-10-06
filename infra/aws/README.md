# AWS: GitHub OIDC deploy role for the pilot (DEP-01 / DEP-03, PR 1)

Infrastructure code only. **No credentials, keys, tokens or account ids are in this directory, and
no agent session ever touches AWS.** The owner uploads the template to their own AWS account and
approves every apply. Nothing here runs in CI.

## Scope after the owner rescope

- The pilot is one x86 EC2 instance (about 2 vCPU and 8 GB) running API, worker, Judge0, Postgres
  and Redis through Docker Compose. It runs only in scheduled windows (EventBridge Scheduler starts
  and stops it). Nightly Postgres backups and the recordings go to encrypted S3 buckets under
  lifecycle rules. SES sends mail, CloudWatch holds logs and alarms.
- There is no RDS, NAT gateway or load balancer, and **no staging on AWS** (staging stays local and
  on free tiers). The template therefore knows one environment only: `pilot`.
- Single AWS account, no Organizations, region `us-east-1` (the template refuses any other region).
- This PR is the first of five. Later PRs are on hold (see the last section).

## What the stack creates

| Resource                  | Name                                                                        | Purpose                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| IAM OIDC provider         | `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`)        | Created only if `ExistingOidcProviderArn` is empty. IAM no longer validates the thumbprint for GitHub, so none is set |
| Role                      | `codeproctor-pilot-deploy`                                                  | Assumable only by the workflow job that uses the GitHub environment `pilot`                                           |
| Managed policies          | `codeproctor-pilot-deploy-core`, `-compute`, `-iam`, `-guard`, `-iamguard`  | The role's permissions. Managed, not inline, because of IAM size limits                                               |
| Managed policy            | `codeproctor-pilot-boundary`                                                | Permissions boundary for every role the deploy role creates                                                           |
| Role (optional)           | `codeproctor-pilot-plan` plus `-plan-read`, `-plan-guard`                   | Read-only plan role, only if `CreatePlanRole=true`                                                                    |
| S3 bucket, KMS key, alias | `codeproctor-pilot-tfstate-<account id>`, `alias/codeproctor-pilot-tfstate` | Optional Terraform state (see below)                                                                                  |

All roles and policies of the stack sit under the IAM path `/codeproctor-guardrails/`. Their ARNs
therefore never match the `codeproctor-pilot-*` allow patterns (the deploy role cannot edit itself),
and explicit denies cover them as well. The role name stays `codeproctor-pilot-deploy`; use the ARN
from the stack Outputs, which includes the path.

## Owner steps (AWS console)

You type the repository values yourself. This document uses the placeholders `<owner>` and `<repo>`.

1. Check whether the account already has the GitHub OIDC provider: IAM, Identity providers. If
   `token.actions.githubusercontent.com` is listed, copy its ARN for step 4. An account can have only one.
2. Sign in to the AWS console in **us-east-1** with your own admin identity (never paste credentials
   anywhere else).
3. CloudFormation, Create stack, With new resources. Upload the file `infra/aws/github-oidc-roles.yaml`.
4. Stack name: `codeproctor-github-oidc`. Parameters:
   - `GitHubOwner` = `<owner>` (your GitHub user or organisation)
   - `GitHubRepo` = `<repo>` (the repository name only, no owner)
   - `ExistingOidcProviderArn` = empty if there is no provider, otherwise the ARN from step 1
   - `CreatePlanRole` = `false` unless you decided to enable it (see "Plan role" below)
   - `AllowedInstanceTypes` = keep the default (`t3.large,t3a.large,m5.large,m6i.large`) or narrow it
5. On the capabilities page tick **I acknowledge that AWS CloudFormation might create IAM resources
   with custom names** (`CAPABILITY_NAMED_IAM`). Review the change, create the stack.
6. When the stack is `CREATE_COMPLETE`, open the Outputs tab. Copy `PilotDeployRoleArn`.
7. In GitHub, repository Settings, Environments: create the environment **`pilot`** and enable
   **Required reviewers** (you). Add the environment variable `AWS_ROLE_ARN` with the role ARN and
   `AWS_REGION` = `us-east-1`. Role ARNs are not secrets and no access keys exist, so there is no
   secret to create. Do not create a `staging` environment for AWS. If you enabled the plan role,
   add the repository variable `AWS_PLAN_ROLE_ARN` from the Outputs.
8. Verify with your own credentials (AWS CLI v2, an SSO or named profile). The script asks IAM
   itself and prints PASS or FAIL per case; it is the authoritative check:

   ```sh
   infra/aws/tests/simulate-principal-policy.sh --account-id <12 digits> --profile <profile>
   ```

9. Update: change the parameters or upload a new template with Update stack and read the change set.
   Rollback: CloudFormation rolls a failed update back automatically; to go back after a successful
   update, update with the previous template version. Delete: Delete stack. The state bucket and its
   key have `DeletionPolicy: Retain` and survive; empty and delete them by hand if you want them gone.
   The OIDC provider is deleted with the stack only if the stack created it.

Later, in PR 5, the Delivery Lead gives you the ordered manual steps for SES, the instance and the
rest. Do not run Terraform or deploy anything from this PR.

## How the deploy role is limited

Trust: only `sub` equal to `repo:<owner>/<repo>:environment:pilot` and `aud` equal to
`sts.amazonaws.com` (both `StringEquals`, no wildcards). Branches, pull requests, other repositories
and other environments cannot assume it. Required reviewers on the `pilot` environment mean a human
approves every job that assumes it.

Permissions: an Allow list that is as small as this design needs, restricted to names starting with
`codeproctor-pilot-` or resources tagged `Environment=pilot`, plus explicit denies. Anything with
another name, another tag value or no tag is not allowed.

| Service                                                              | Why it is there                                                                                | Control used                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EC2 (instance, EBS, security groups, VPC pieces, Elastic IP, tags)   | Run, start, stop and terminate the one instance                                                | Tags only: ids carry no names. `aws:RequestTag` on create, `aws:ResourceTag` on change and delete. RunInstances also requires IMDSv2, encrypted volumes and an instance type from `AllowedInstanceTypes`. `Describe*` has no resource-level support (known limitation) |
| EventBridge Scheduler                                                | Windows that start and stop the instance                                                       | ARN prefix: schedule group and schedules `codeproctor-pilot-*` (no tag support)                                                                                                                                                                                        |
| S3                                                                   | Backup and recordings buckets with lifecycle, encryption, public access block, TLS-only policy | ARN prefix `codeproctor-pilot-*`. The role configures buckets; it cannot read or write data objects (explicit deny), except the state bucket                                                                                                                           |
| KMS                                                                  | One pilot CMK and aliases                                                                      | Tags (`RequestTag` on CreateKey, `ResourceTag` on use) and alias prefix `alias/codeproctor-pilot-*`. `Decrypt` is denied except on the state key                                                                                                                       |
| SES                                                                  | Pilot sender identities and configuration sets                                                 | Tags only for identities (they are domains or addresses, not name-prefixed: the owner tags them `Environment=pilot`), prefix for configuration sets. Sending is denied to the deploy role                                                                              |
| CloudWatch Logs                                                      | Log groups                                                                                     | ARN prefix (`/codeproctor/pilot/*` or `codeproctor-pilot-*`) plus tags. Reading events is denied                                                                                                                                                                       |
| CloudWatch alarms                                                    | Alarms                                                                                         | ARN prefix only: updates cannot be tag-conditioned reliably                                                                                                                                                                                                            |
| Secrets Manager                                                      | Secret containers                                                                              | ARN prefix plus tags. Values can never be read (`GetSecretValue` denied)                                                                                                                                                                                               |
| SSM Parameter Store                                                  | Parameters under `/codeproctor/pilot/`                                                         | Path prefix. Write and delete only; reads denied. Instance access is through Session Manager (no SSH keys: key-pair creation is denied)                                                                                                                                |
| AWS Budgets                                                          | Cost alerts                                                                                    | ARN prefix `budget/codeproctor-pilot-*` (whether CreateBudget honours this ARN is unverified)                                                                                                                                                                          |
| IAM                                                                  | Instance role and profile, scheduler execution role, their policies                            | Prefix `codeproctor-pilot-*`, the boundary condition, the denies below                                                                                                                                                                                                 |
| RDS, load balancers, NAT gateways, VPC peering, transit gateway, VPN | Not used                                                                                       | **Explicit deny**: cost guard rails, so the cost design cannot be exceeded by mistake                                                                                                                                                                                  |

Also denied: Lambda, ECS, CloudFormation, CodeBuild, Glue, SageMaker, Batch, `sts:AssumeRole`.

### Why `iam:PassRole` allows two services

`ec2.amazonaws.com` for the instance profile role. `scheduler.amazonaws.com` for the EventBridge
Scheduler execution role, which must be passed to the schedule. The boundary lets that role do
nothing but `ec2:StartInstances` and `ec2:StopInstances` on instances tagged `Environment=pilot`
(plus whatever its own policy allows inside the boundary). The `monitoring.rds.amazonaws.com`
passing is not allowed because RDS is not used.

### IAM escalation paths considered

| Path                                                                                      | How it is closed                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a role without limits                                                              | `CreateRole` only with `iam:PermissionsBoundary` equal to the pilot boundary and prefix `codeproctor-pilot-*`; explicit deny when the boundary differs or is missing                                  |
| Remove or swap the boundary                                                               | `DeleteRolePermissionsBoundary` and `PutRolePermissionsBoundary` denied for all roles                                                                                                                 |
| Edit the boundary policy                                                                  | The boundary is under the guardrails path and covered by explicit deny on `iam:*` (path and bare ARNs); `CreatePolicyVersion`, `SetDefaultPolicyVersion`, `DeletePolicy` cannot match                 |
| Attach or put a policy on an unbounded role                                               | `AttachRolePolicy`, `PutRolePolicy` require the boundary condition on the target role                                                                                                                 |
| Attach AdministratorAccess or any AWS managed policy                                      | `AttachRolePolicy` only with `iam:PolicyARN` like `policy/codeproctor-pilot-*`                                                                                                                        |
| Attach the boundary or deploy policies as ordinary policies                               | Explicit deny on those policy ARNs                                                                                                                                                                    |
| Change the deploy role (trust, policies, delete, tags)                                    | Explicit `iam:*` deny on the deploy and plan roles and the guardrails path, under the path ARN and the bare name                                                                                      |
| Edit the deploy role's own policies through `CreatePolicyVersion`                         | They live under `/codeproctor-guardrails/`, which no allow matches, plus explicit deny; the reserved names `codeproctor-pilot-deploy-*` and `codeproctor-pilot-plan-*` are also denied                |
| New IAM user, access key, login profile, group, service credential, SAML or OIDC provider | Not allowed; explicit deny by wildcard (`iam:*User*`, `*AccessKey*`, ...). Changing the GitHub provider's thumbprint or client ids is denied too                                                      |
| Pass a powerful role to a code-running service                                            | `PassRole` only on `codeproctor-pilot-*` roles and only to `ec2` and `scheduler`; everything else denied. Lambda, ECS, CloudFormation, CodeBuild, Glue, SageMaker, Batch denied outright              |
| Service-linked roles                                                                      | `CreateServiceLinkedRole` denied (RDS, ELB not used)                                                                                                                                                  |
| Assume another role                                                                       | `sts:AssumeRole` denied                                                                                                                                                                               |
| Re-tag a resource into or out of scope                                                    | Explicit deny on any request that tags `Environment` with another value, on any resource tagged with another value, and on removing or re-writing the `Environment` tag of EC2 resources after create |
| Change state bucket or its key                                                            | Explicit deny, plus the bucket policy and key policy deny `codeproctor-*` roles that are not the deploy or plan role                                                                                  |

Residual risks, stated plainly:

- `iam:UpdateAssumeRolePolicy` and `CreateRole` allow a trust policy of the role's choice (IAM has no
  condition key for the trust document). A compromised pilot deploy job could create a
  `codeproctor-pilot-*` role trusting an outside principal. That role is still capped by the
  boundary (pilot data only). Mitigations: the `pilot` environment's required reviewers, CloudTrail
  alerting on `CreateRole` and `UpdateAssumeRolePolicy`.
- A deploy role that can launch an instance with a role and user data, or change an instance
  setting, can indirectly reach the pilot data that the instance role can reach. The role is
  isolated from everything else in the account, not from the pilot's own data.
- The same is true of other indirect routes inside the pilot (for example `ModifyInstanceAttribute`).
  The explicit data-plane denies stop mistakes and direct reads; they do not make the pilot deploy role
  harmless inside its own environment. Required reviewers are the control for that.
- `ec2:Describe*`, `ssm:DescribeParameters`, `scheduler:List*`, `cloudwatch:DescribeAlarms` and
  `kms:ListAliases` are account-wide metadata reads: IAM cannot filter them. The account holds only
  pilot resources by design; keep it that way (a separate account for anything else is the stronger
  isolation).
- `s3:ListBucket` is needed to configure buckets (HeadBucket) and also lists object keys. Candidate
  media keys are listed, never read.

## Optional: Terraform state

The state bucket `codeproctor-pilot-tfstate-<account id>` (S3 names are global, hence the account id
suffix; it still matches `codeproctor-pilot-*`) has versioning, SSE-KMS with its own CMK, Block
Public Access, ownership enforced, TLS-only, and a bucket policy that denies other `codeproctor-*`
roles (workload roles) object access and denies everyone deleting object versions. Locking uses
Terraform's native S3 lock file (`use_lockfile`, Terraform 1.10 or later, no DynamoDB table): the
lock object is `<key>.tflock` in the same bucket, which is why the roles may write and delete
`*.tflock` objects. The state key is tagged `Purpose=tfstate`; every other control keys off that.

PR 2 (Terraform) is on hold. The owner may decide not to use Terraform for a single instance: then
ignore this bucket (it costs almost nothing) or remove it from the template. No Terraform is
designed or written here.

## Optional: plan role (open question for the owner)

`CreatePlanRole` defaults to `false`. A GitHub environment with required reviewers makes every job
that uses it wait for approval, so the deploy role cannot run an automatic plan on pull requests.
`codeproctor-pilot-plan` is trusted for `repo:<owner>/<repo>:pull_request` and can read infrastructure
metadata and the state, and write only the `*.tflock` lock objects. It cannot read secrets, data
objects, log events or parameters, cannot decrypt any key except the state key, and cannot change
anything.

Residual risk: it is reachable from **any** `pull_request` workflow in this repository, including a
workflow file changed by the pull request's author. Such a workflow can read infrastructure metadata
and the state, and Terraform state can contain sensitive attributes. It can also write or delete
lock objects (a denial-of-service on applies, never data loss). Mitigations: secrets are generated
by AWS and never in Terraform, so state holds no secret values; branch protection and required
review of workflow changes; fork pull requests do not receive OIDC tokens by default. With staging
gone and Terraform on hold, the question is whether one read-only plan role is worth a role that
any pull request can reach. The recommended default is `false` until PR 2 exists.

## Offline test and its limits

```sh
python3 -m venv .venv && .venv/bin/pip install pyyaml
.venv/bin/python infra/aws/tests/test_isolation.py
```

It parses the template, resolves intrinsic functions (owner `example-owner`, repo `example-repo`,
account `111111111111`), and evaluates over 200 cases with explicit-deny-wins semantics, permissions
boundary intersection, bucket and key policies and the trust policy conditions. It exits non-zero on
any mismatch. It approximates IAM: it cannot model which actions honour which condition keys in
real services, eventual consistency of tag conditions, or multi-resource actions such as
`RunInstances` in full. **`simulate-principal-policy.sh`, run by the owner against the deployed
roles, is the authoritative check**, and the first real deploy is the final one. cfn-lint was run
offline with no findings (a dev tool, not a repository dependency).

## Known limitations and things to verify at the first apply

- Tag conditions for SES identities, CloudWatch Logs `CreateLogGroup` and Budgets ARNs are my reading
  of the AWS service authorization reference and are not verified against a live account.
- `ec2:RunInstances` requires tags on the instance, volume and network interface (tag
  specifications), subnets and security groups tagged `Environment=pilot`, encrypted volumes and
  IMDSv2. An untagged default subnet will be refused: use a tagged VPC or tag the subnet.
- Creating encrypted EBS volumes may need KMS actions that the data-plane denies block; if a launch
  fails with a KMS error, adjust deliberately rather than loosening the denies.
- `kms` tag conditions can lag a few seconds after tagging.
- Policy size: each managed policy stays under 6144 characters (checked by the test).

## On hold

PR 2 Terraform (owner may skip it), PR 3 deploy workflow (SSM or SSH, backups, schedule), PR 4
costs (the Delivery Lead writes the numbers), PR 5 the owner's ordered manual steps (SES
verification and tagging, S3 lifecycle, GitHub environment, first start).
