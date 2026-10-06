#!/usr/bin/env bash
# Owner check after the CloudFormation stack is created: asks IAM itself (iam:SimulatePrincipalPolicy)
# whether the deployed pilot roles allow or deny the key actions. This is the authoritative check;
# test_isolation.py is only an offline approximation.
#
# Run it yourself with your own AWS credentials (an AWS CLI profile, e.g. from SSO). It takes the
# account id and the profile name as arguments, never embeds or prints credentials, and is not run
# in CI or by any agent.
#
#   infra/aws/tests/simulate-principal-policy.sh --account-id <12 digits> --profile <profile>
#
# Needs: aws CLI v2, permission iam:SimulatePrincipalPolicy and iam:GetRole. Exit code 1 on any
# mismatch. Simulation does not model resource policies (bucket and key policies) or session
# policies, and ec2:RunInstances needs several resources: those cases are covered by test_isolation.py
# and by the first real deploy.
set -u

ACCOUNT=""; PROFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --account-id) ACCOUNT="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    *) echo "usage: $0 --account-id <12 digits> --profile <profile>" >&2; exit 2 ;;
  esac
done
case "$ACCOUNT" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) echo "error: --account-id must be 12 digits" >&2; exit 2 ;; esac
[ -n "$PROFILE" ] || { echo "error: --profile is required" >&2; exit 2; }

REGION=us-east-1
DEPLOY="arn:aws:iam::${ACCOUNT}:role/codeproctor-guardrails/codeproctor-pilot-deploy"
PLAN="arn:aws:iam::${ACCOUNT}:role/codeproctor-guardrails/codeproctor-pilot-plan"
BOUNDARY="arn:aws:iam::${ACCOUNT}:policy/codeproctor-guardrails/codeproctor-pilot-boundary"
TF="arn:aws:s3:::codeproctor-pilot-tfstate-${ACCOUNT}"
pass=0; fail=0

# check <role-arn> <expect allowed|denied> <name> <action> <resource> [Key=Value ...]
check() {
  role="$1"; expect="$2"; name="$3"; action="$4"; resource="$5"; shift 5
  entries=()
  for kv in "$@"; do
    entries+=("ContextKeyName=${kv%%=*},ContextKeyValues=${kv#*=},ContextKeyType=string")
  done
  args=(iam simulate-principal-policy --profile "$PROFILE" --region "$REGION" --policy-source-arn "$role"
        --action-names "$action" --resource-arns "$resource" --query 'EvaluationResults[0].EvalDecision' --output text)
  if [ ${#entries[@]} -gt 0 ]; then args+=(--context-entries "${entries[@]}"); fi
  errfile="$(mktemp)"
  got="$(aws "${args[@]}" 2>"$errfile")" || got="ERROR"
  firsterr="$(head -n 1 "$errfile")"; rm -f "$errfile"
  if [ "$got" = "allowed" ]; then actual=allowed; elif [ "$got" = "ERROR" ]; then actual=ERROR; else actual=denied; fi
  if [ "$actual" = "$expect" ]; then pass=$((pass+1)); printf 'PASS  %-62s %s\n' "$name" "$expect"
  else
    fail=$((fail+1)); printf 'FAIL  %-62s expected %s, got %s (%s)\n' "$name" "$expect" "$actual" "$got"
    if [ -n "$firsterr" ]; then printf '      aws said: %s\n' "$firsterr"; fi
  fi
}

PILOT_TAG="aws:ResourceTag/Environment=pilot"
REQ_TAG="aws:RequestTag/Environment=pilot"
INST="arn:aws:ec2:${REGION}:${ACCOUNT}:instance/i-0123456789abcdef0"
ROLE_APP="arn:aws:iam::${ACCOUNT}:role/codeproctor-pilot-app"

echo "Deploy role: ${DEPLOY}"
check "$DEPLOY" denied  "S3 create bucket (owner template only)" s3:CreateBucket "arn:aws:s3:::codeproctor-pilot-x" "$REQ_TAG"
for act in PutBucketPolicy DeleteBucketPolicy PutBucketAcl PutBucketPublicAccessBlock PutBucketOwnershipControls PutBucketVersioning PutLifecycleConfiguration; do
  check "$DEPLOY" denied "S3 ${act} on pilot backups bucket" "s3:${act}" "arn:aws:s3:::codeproctor-pilot-backups"
done
check "$DEPLOY" allowed "S3 read bucket policy of pilot backups" s3:GetBucketPolicy "arn:aws:s3:::codeproctor-pilot-backups" "aws:ResourceAccount=${ACCOUNT}"
for b in media results consent backup; do
  check "$DEPLOY" denied "S3 PutBucketPolicy on ${b} bucket (PR 1b)" s3:PutBucketPolicy "arn:aws:s3:::codeproctor-pilot-${b}-${ACCOUNT}"
  check "$DEPLOY" denied "S3 GetObject on ${b} bucket (PR 1b)" s3:GetObject "arn:aws:s3:::codeproctor-pilot-${b}-${ACCOUNT}/orgs/o/x"
done
check "$DEPLOY" denied  "KMS PutKeyPolicy on the data key (PR 1b)" kms:PutKeyPolicy "arn:aws:kms:${REGION}:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000" "$PILOT_TAG" "aws:ResourceTag/Purpose=data"
check "$DEPLOY" denied  "KMS alias update on the data key (PR 1b)" kms:UpdateAlias "arn:aws:kms:${REGION}:${ACCOUNT}:alias/codeproctor-pilot-data"
check "$DEPLOY" denied  "KMS create key" kms:CreateKey "*" "$REQ_TAG"
check "$DEPLOY" denied  "KMS put key policy" kms:PutKeyPolicy "arn:aws:kms:${REGION}:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000" "$PILOT_TAG"
check "$DEPLOY" denied  "Secrets put resource policy" secretsmanager:PutResourcePolicy "arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:codeproctor-pilot-db-AbCdEf" "$PILOT_TAG"
check "$DEPLOY" denied  "Secrets forced deletion" secretsmanager:DeleteSecret "arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:codeproctor-pilot-db-AbCdEf" "$PILOT_TAG" "secretsmanager:ForceDeleteWithoutRecovery=true"
check "$DEPLOY" denied  "KMS key deletion, 7 day window" kms:ScheduleKeyDeletion "arn:aws:kms:${REGION}:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000" "$PILOT_TAG" "kms:ScheduleKeyDeletionPendingWindowInDays=7"
check "$DEPLOY" denied  "EC2 modify instance type to a huge type" ec2:ModifyInstanceAttribute "$INST" "$PILOT_TAG" "ec2:InstanceType=m5.24xlarge"
check "$DEPLOY" denied  "IAM update trust of untagged owner-made role" iam:UpdateAssumeRolePolicy "$ROLE_APP"
check "$DEPLOY" denied  "S3 create bucket other name" s3:CreateBucket "arn:aws:s3:::codeproctor-staging-x" "$REQ_TAG"
check "$DEPLOY" denied  "S3 read object in pilot data bucket" s3:GetObject "arn:aws:s3:::codeproctor-pilot-recordings/a.webm"
check "$DEPLOY" denied  "S3 read object in other bucket" s3:GetObject "arn:aws:s3:::other-bucket/a"
if aws s3api head-bucket --profile "$PROFILE" --bucket "codeproctor-pilot-tfstate-${ACCOUNT}" >/dev/null 2>&1; then
  check "$DEPLOY" allowed "State object read" s3:GetObject "${TF}/pilot/terraform.tfstate" "aws:ResourceAccount=${ACCOUNT}"
  check "$DEPLOY" denied  "State bucket policy change" s3:PutBucketPolicy "$TF"
fi
check "$DEPLOY" allowed "EC2 start tagged instance" ec2:StartInstances "$INST" "$PILOT_TAG"
check "$DEPLOY" allowed "EC2 stop tagged instance" ec2:StopInstances "$INST" "$PILOT_TAG"
check "$DEPLOY" denied  "EC2 terminate untagged instance" ec2:TerminateInstances "$INST"
check "$DEPLOY" denied  "EC2 terminate instance tagged other" ec2:TerminateInstances "$INST" "aws:ResourceTag/Environment=staging"
check "$DEPLOY" denied  "EC2 create NAT gateway" ec2:CreateNatGateway "arn:aws:ec2:${REGION}:${ACCOUNT}:natgateway/nat-1" "$REQ_TAG"
check "$DEPLOY" denied  "RDS create instance" rds:CreateDBInstance "arn:aws:rds:${REGION}:${ACCOUNT}:db:codeproctor-pilot-db" "$REQ_TAG"
check "$DEPLOY" denied  "ELB create load balancer" elasticloadbalancing:CreateLoadBalancer "*"
check "$DEPLOY" allowed "Scheduler create schedule in pilot group" scheduler:CreateSchedule "arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule/codeproctor-pilot-windows/start"
check "$DEPLOY" denied  "Scheduler create schedule in default group" scheduler:CreateSchedule "arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule/default/start"
check "$DEPLOY" denied  "Secret value read" secretsmanager:GetSecretValue "arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:codeproctor-pilot-db-AbCdEf" "$PILOT_TAG"
check "$DEPLOY" denied  "KMS decrypt with a tagged data key" kms:Decrypt "arn:aws:kms:${REGION}:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000" "$PILOT_TAG" "aws:ResourceTag/Purpose=data"
check "$DEPLOY" denied  "SES send" ses:SendEmail "arn:aws:ses:${REGION}:${ACCOUNT}:identity/example.org" "$PILOT_TAG"
check "$DEPLOY" allowed "IAM create role with boundary" iam:CreateRole "$ROLE_APP" "iam:PermissionsBoundary=${BOUNDARY}" "$REQ_TAG"
check "$DEPLOY" denied  "IAM create role without boundary" iam:CreateRole "$ROLE_APP" "$REQ_TAG"
check "$DEPLOY" denied  "IAM create role with another boundary" iam:CreateRole "$ROLE_APP" "iam:PermissionsBoundary=arn:aws:iam::${ACCOUNT}:policy/other" "$REQ_TAG"
check "$DEPLOY" denied  "IAM create role wrong prefix" iam:CreateRole "arn:aws:iam::${ACCOUNT}:role/admin" "iam:PermissionsBoundary=${BOUNDARY}" "$REQ_TAG"
check "$DEPLOY" denied  "IAM change trust of the deploy role" iam:UpdateAssumeRolePolicy "$DEPLOY"
check "$DEPLOY" denied  "IAM change the boundary policy" iam:CreatePolicyVersion "$BOUNDARY"
check "$DEPLOY" denied  "IAM remove a role boundary" iam:DeleteRolePermissionsBoundary "$ROLE_APP"
check "$DEPLOY" denied  "IAM create user" iam:CreateUser "arn:aws:iam::${ACCOUNT}:user/x"
check "$DEPLOY" denied  "IAM create access key" iam:CreateAccessKey "arn:aws:iam::${ACCOUNT}:user/x"
check "$DEPLOY" denied  "IAM create OIDC provider" iam:CreateOpenIDConnectProvider "arn:aws:iam::${ACCOUNT}:oidc-provider/evil.example"
check "$DEPLOY" allowed "IAM pass tagged pilot role to ec2" iam:PassRole "$ROLE_APP" "iam:PassedToService=ec2.amazonaws.com" "$PILOT_TAG"
check "$DEPLOY" allowed "IAM pass tagged scheduler role to scheduler" iam:PassRole "arn:aws:iam::${ACCOUNT}:role/codeproctor-pilot-scheduler" "iam:PassedToService=scheduler.amazonaws.com" "$PILOT_TAG"
check "$DEPLOY" denied  "IAM pass pilot role to lambda" iam:PassRole "$ROLE_APP" "iam:PassedToService=lambda.amazonaws.com"
check "$DEPLOY" denied  "IAM pass other role to ec2" iam:PassRole "arn:aws:iam::${ACCOUNT}:role/admin" "iam:PassedToService=ec2.amazonaws.com"

if aws iam get-role --profile "$PROFILE" --role-name codeproctor-pilot-plan --query 'Role.Arn' --output text >/dev/null 2>&1; then
  echo "Plan role: ${PLAN}"
  check "$PLAN" allowed "State read" s3:GetObject "${TF}/pilot/terraform.tfstate" "aws:ResourceAccount=${ACCOUNT}"
  check "$PLAN" allowed "Lock object write" s3:PutObject "${TF}/pilot/terraform.tfstate.tflock" "aws:ResourceAccount=${ACCOUNT}"
  check "$PLAN" denied  "State write" s3:PutObject "${TF}/pilot/terraform.tfstate" "aws:ResourceAccount=${ACCOUNT}"
  check "$PLAN" denied  "Data object read" s3:GetObject "arn:aws:s3:::codeproctor-pilot-recordings/a.webm"
  check "$PLAN" denied  "Secret value read" secretsmanager:GetSecretValue "arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:codeproctor-pilot-db-AbCdEf" "$PILOT_TAG"
  check "$PLAN" denied  "KMS decrypt with a data key" kms:Decrypt "arn:aws:kms:${REGION}:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000" "$PILOT_TAG" "aws:ResourceTag/Purpose=data"
  check "$PLAN" denied  "Log events read" logs:GetLogEvents "arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/codeproctor/pilot/api:log-stream:s"
  check "$PLAN" denied  "EC2 terminate" ec2:TerminateInstances "$INST" "$PILOT_TAG"
  check "$PLAN" denied  "IAM create role" iam:CreateRole "$ROLE_APP"
else
  echo "Plan role not deployed (CreatePlanRole=false): plan checks skipped"
fi

echo "passed: ${pass}, failed: ${fail}"
[ "$fail" -eq 0 ]
