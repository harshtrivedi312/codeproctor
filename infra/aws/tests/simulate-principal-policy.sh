#!/usr/bin/env bash
# Owner check after the CloudFormation stacks are created: asks IAM itself (iam:SimulatePrincipalPolicy)
# whether the deployed CI role allows or denies the key actions, and reads the live bucket settings.
# This is the authoritative check; test_isolation.py and test_data_buckets.py are offline approximations.
#
# Run it yourself with your own AWS credentials (an AWS CLI profile, e.g. from SSO). It takes the
# account id and the profile name as arguments, never embeds or prints credentials, and is not run
# in CI or by any agent.
#
#   infra/aws/tests/simulate-principal-policy.sh --account-id <12 digits> --profile <profile> [--assess-zone-id <id>]
#
# Needs: aws CLI v2, permissions iam:SimulatePrincipalPolicy, iam:GetRole, iam:ListRoles,
# iam:ListRoleTags, s3:GetBucketVersioning, s3:GetObjectLockConfiguration. Exit code 1 on any mismatch.
# Simulation does not model resource policies (bucket and key policies) or session policies: those cases
# are covered by test_data_buckets.py.
set -u

ACCOUNT=""; PROFILE=""; ZONE_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --account-id) ACCOUNT="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --assess-zone-id) ZONE_ID="$2"; shift 2 ;;
    *) echo "usage: $0 --account-id <12 digits> --profile <profile> [--assess-zone-id <id>]" >&2; exit 2 ;;
  esac
done
case "$ACCOUNT" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) echo "error: --account-id must be 12 digits" >&2; exit 2 ;; esac
[ -n "$PROFILE" ] || { echo "error: --profile is required" >&2; exit 2; }

REGION=us-east-1
DEPLOY="arn:aws:iam::${ACCOUNT}:role/codeproctor-guardrails/codeproctor-pilot-deploy"
REL="arn:aws:s3:::codeproctor-pilot-releases-${ACCOUNT}"
MEDIA="arn:aws:s3:::codeproctor-pilot-media-${ACCOUNT}"
BACKUP="arn:aws:s3:::codeproctor-pilot-backup-${ACCOUNT}"
ECR="arn:aws:ecr:${REGION}:${ACCOUNT}:repository/codeproctor-pilot-api"
pass=0; fail=0

# check <expect allowed|denied|explicit|implicit|notexplicit> <name> <action> <resource> [Key=Value ...]
check() {
  expect="$1"; name="$2"; action="$3"; resource="$4"; shift 4
  entries=()
  for kv in "$@"; do
    entries+=("ContextKeyName=${kv%%=*},ContextKeyValues=${kv#*=},ContextKeyType=string")
  done
  args=(iam simulate-principal-policy --profile "$PROFILE" --region "$REGION" --policy-source-arn "$DEPLOY"
        --action-names "$action" --resource-arns "$resource" --query 'EvaluationResults[0].EvalDecision' --output text)
  if [ ${#entries[@]} -gt 0 ]; then args+=(--context-entries "${entries[@]}"); fi
  errfile="$(mktemp)"
  got="$(aws "${args[@]}" 2>"$errfile")" || got="ERROR"
  firsterr="$(head -n 1 "$errfile")"; rm -f "$errfile"
  case "$got" in allowed) actual=allowed ;; explicitDeny) actual=explicit ;; implicitDeny) actual=implicit ;; *) actual="$got" ;; esac
  ok=0
  case "$expect" in
    allowed) [ "$actual" = allowed ] && ok=1 ;;
    denied) { [ "$actual" = explicit ] || [ "$actual" = implicit ]; } && ok=1 ;;
    notexplicit) { [ "$actual" = allowed ] || [ "$actual" = implicit ]; } && ok=1 ;;
    explicit|implicit) [ "$actual" = "$expect" ] && ok=1 ;;
  esac
  if [ "$ok" -eq 1 ]; then pass=$((pass+1)); printf 'PASS  %-70s %s\n' "$name" "$expect"
  else
    fail=$((fail+1)); printf 'FAIL  %-70s expected %s, got %s (%s)\n' "$name" "$expect" "$actual" "$got"
    if [ -n "$firsterr" ]; then printf '      aws said: %s\n' "$firsterr"; fi
  fi
}
live() { # live <name> <expected text> <command output>
  if [ "$3" = "$2" ]; then pass=$((pass+1)); printf 'PASS  %-70s %s\n' "$1" "$2"; else fail=$((fail+1)); printf 'FAIL  %-70s expected "%s", got "%s"\n' "$1" "$2" "$3"; fi
}

echo "CI role: ${DEPLOY}"
AC="aws:ResourceAccount=${ACCOUNT}"
check allowed "Releases: put a manifest under main/" s3:PutObject "${REL}/main/manifest-000001.json" "$AC"
check allowed "Releases: put a manifest under judge0/" s3:PutObject "${REL}/judge0/manifest-000001.json" "$AC"
check denied  "Releases: put under another prefix" s3:PutObject "${REL}/other/x" "$AC"
check denied  "Releases: read a manifest" s3:GetObject "${REL}/main/manifest-000001.json" "$AC"
check denied  "Releases: delete a manifest" s3:DeleteObject "${REL}/main/manifest-000001.json" "$AC"
check denied  "Releases: list the bucket" s3:ListBucket "$REL" "$AC"
check allowed "ECR: push an image to codeproctor-pilot-api (UseEcr=true only)" ecr:PutImage "$ECR"
check denied  "ECR: push to another repository" ecr:PutImage "arn:aws:ecr:${REGION}:${ACCOUNT}:repository/other"
for b in "$MEDIA" "$BACKUP" "$REL"; do
  check denied "S3 PutBucketPolicy on ${b##*:::}" s3:PutBucketPolicy "$b" "$AC"
  check denied "S3 PutLifecycleConfiguration on ${b##*:::}" s3:PutLifecycleConfiguration "$b" "$AC"
done
for b in "$MEDIA" "$BACKUP"; do
  check denied "S3 GetObject on ${b##*:::}" s3:GetObject "${b}/orgs/o/x" "$AC"
  check denied "S3 PutObject on ${b##*:::}" s3:PutObject "${b}/orgs/o/x" "$AC"
  check denied "S3 ListBucket on ${b##*:::}" s3:ListBucket "$b" "$AC"
done
check explicit "Backup: BypassGovernanceRetention" s3:BypassGovernanceRetention "${BACKUP}/db/dump/latest.dump" "$AC"
check explicit "Backup: PutObjectRetention" s3:PutObjectRetention "${BACKUP}/db/dump/latest.dump" "$AC"
check denied  "Backup: DeleteObjectVersion" s3:DeleteObjectVersion "${BACKUP}/db/dump/latest.dump" "$AC"
check denied  "KMS: Decrypt with the data key" kms:Decrypt "arn:aws:kms:${REGION}:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000" "aws:ResourceTag/Environment=pilot" "aws:ResourceTag/Purpose=data"
check denied  "KMS: PutKeyPolicy" kms:PutKeyPolicy "arn:aws:kms:${REGION}:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000"
check denied  "KMS: CreateKey" kms:CreateKey "*"
check denied  "Secrets: GetSecretValue" secretsmanager:GetSecretValue "arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:codeproctor-pilot-x-AbCdEf"
for act in ec2:RunInstances ec2:StartInstances ec2:StopInstances ec2:TerminateInstances ec2:ModifyInstanceAttribute ec2:AllocateAddress ec2:AttachVolume ec2:ImportKeyPair; do
  check explicit "EC2: ${act}" "$act" "arn:aws:ec2:${REGION}:${ACCOUNT}:instance/i-0123456789abcdef0"
done
check denied  "Scheduler: CreateSchedule" scheduler:CreateSchedule "arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule/codeproctor-pilot-slots/start"
check denied  "SSM: StartSession" ssm:StartSession "arn:aws:ec2:${REGION}:${ACCOUNT}:instance/i-0123456789abcdef0"
check denied  "SSM: SendCommand" ssm:SendCommand "arn:aws:ec2:${REGION}:${ACCOUNT}:instance/i-0123456789abcdef0"
check denied  "SES: SendEmail" ses:SendEmail "arn:aws:ses:${REGION}:${ACCOUNT}:identity/example.org"
check denied  "Logs: GetLogEvents" logs:GetLogEvents "arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/codeproctor/pilot/api:log-stream:s"
check denied  "RDS: CreateDBInstance" rds:CreateDBInstance "arn:aws:rds:${REGION}:${ACCOUNT}:db:x"
for act in iam:CreateRole iam:PassRole iam:UpdateAssumeRolePolicy iam:CreateUser iam:CreateAccessKey iam:CreateOpenIDConnectProvider iam:AttachRolePolicy; do
  check explicit "IAM: ${act}" "$act" "arn:aws:iam::${ACCOUNT}:role/codeproctor-pilot-app"
done
check explicit "Route 53: ListHostedZones on *" route53:ListHostedZones "*"
check explicit "Route 53: another hosted zone" route53:ChangeResourceRecordSets "arn:aws:route53:::hostedzone/Z0OTHERZONE0000"
check explicit "Route 53: create hosted zone" route53:CreateHostedZone "*"
if [ -n "$ZONE_ID" ]; then
  check implicit "Route 53: assess zone ${ZONE_ID} is implicitly denied (no allow, not an explicit deny)" route53:ChangeResourceRecordSets "arn:aws:route53:::hostedzone/${ZONE_ID}"
fi

echo "Live bucket settings"
live "Backup bucket versioning" "Enabled" "$(aws s3api get-bucket-versioning --profile "$PROFILE" --bucket "codeproctor-pilot-backup-${ACCOUNT}" --query Status --output text 2>/dev/null)"
live "Backup bucket Object Lock mode" "GOVERNANCE" "$(aws s3api get-object-lock-configuration --profile "$PROFILE" --bucket "codeproctor-pilot-backup-${ACCOUNT}" --query 'ObjectLockConfiguration.Rule.DefaultRetention.Mode' --output text 2>/dev/null)"
live "Backup bucket Object Lock days" "12" "$(aws s3api get-object-lock-configuration --profile "$PROFILE" --bucket "codeproctor-pilot-backup-${ACCOUNT}" --query 'ObjectLockConfiguration.Rule.DefaultRetention.Days' --output text 2>/dev/null)"
for b in media releases; do
  v="$(aws s3api get-bucket-versioning --profile "$PROFILE" --bucket "codeproctor-pilot-${b}-${ACCOUNT}" --query Status --output text 2>/dev/null)"
  case "$v" in None|"") pass=$((pass+1)); printf 'PASS  %-70s unversioned\n' "${b} bucket versioning" ;; *) fail=$((fail+1)); printf 'FAIL  %-70s expected unversioned, got "%s"\n' "${b} bucket versioning" "$v" ;; esac
done

echo "Every codeproctor-pilot-* role must be tagged Environment=pilot (made by CI or the owner template) or Environment=owner"
for r in $(aws iam list-roles --profile "$PROFILE" --query "Roles[?starts_with(RoleName, 'codeproctor-pilot-')].RoleName" --output text 2>/dev/null); do
  env="$(aws iam list-role-tags --profile "$PROFILE" --role-name "$r" --query "Tags[?Key=='Environment']|[0].Value" --output text 2>/dev/null)"
  rpath="$(aws iam get-role --profile "$PROFILE" --role-name "$r" --query 'Role.Path' --output text 2>/dev/null)"
  case "$env" in pilot|owner) pass=$((pass+1)); printf 'PASS  %-70s tag=%s path=%s\n' "role $r" "$env" "$rpath" ;; *) fail=$((fail+1)); printf 'FAIL  %-70s Environment tag is "%s"\n' "role $r" "$env" ;; esac
done

echo "passed: ${pass}, failed: ${fail}"
[ "$fail" -eq 0 ]
