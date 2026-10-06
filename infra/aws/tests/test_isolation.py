#!/usr/bin/env python3
"""Offline isolation test for infra/aws/github-oidc-roles.yaml (DEP-01 PR 1).

Parses the CloudFormation template, resolves intrinsic functions with fixed test values, and
evaluates a matrix of (principal, action, resource, context) against the identity policies, the
permissions boundary, the state bucket policy, the state key policy and the role trust policies,
using a small implementation of IAM evaluation semantics (explicit Deny wins, implicit deny,
wildcards, condition operators, boundary intersection, resource-policy deny).

It approximates IAM. It cannot model every service-specific behaviour (for example which actions
really support a condition key). The owner script simulate-principal-policy.sh, run against the
deployed roles, is the authoritative check.

Run: python3 infra/aws/tests/test_isolation.py   (needs PyYAML: pip install pyyaml)
Exit code is non-zero on any mismatch. No AWS call, no credentials.
"""
import json
import os
import re
import sys

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is required: python3 -m venv .venv && .venv/bin/pip install pyyaml")

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "..", "github-oidc-roles.yaml")
ACCT = "111111111111"
REGION = "us-east-1"
OIDC_ARN = f"arn:aws:iam::{ACCT}:oidc-provider/token.actions.githubusercontent.com"

# ---------------------------------------------------------------- template loading
class Loader(yaml.SafeLoader):
    pass


def _tag(name):
    def ctor(loader, node):
        if isinstance(node, yaml.ScalarNode):
            v = loader.construct_scalar(node)
        elif isinstance(node, yaml.SequenceNode):
            v = loader.construct_sequence(node, deep=True)
        else:
            v = loader.construct_mapping(node, deep=True)
        if name == "GetAtt" and isinstance(v, str):
            v = v.split(".", 1)
        return {("Ref" if name == "Ref" else "Fn::" + name): v}
    return ctor


for _n in ("Ref", "Sub", "GetAtt", "If", "Equals", "Not", "Join", "Select", "Split", "FindInMap"):
    Loader.add_constructor("!" + _n, _tag(_n))


class Resolver:
    def __init__(self, tpl, params):
        self.tpl = tpl
        self.params = params
        self.pseudo = {"AWS::AccountId": ACCT, "AWS::Region": REGION, "AWS::Partition": "aws"}
        self.conds = {}
        for k, v in tpl.get("Conditions", {}).items():
            self.conds[k] = self.r(v)

    def ref(self, name):
        if name in self.pseudo:
            return self.pseudo[name]
        if name in self.params:
            return self.params[name]
        if name == "GitHubOidcProvider":
            return OIDC_ARN
        if name in self.tpl["Resources"]:
            return "ref:" + name
        raise KeyError(name)

    def r(self, n):
        if isinstance(n, list):
            return [self.r(x) for x in n]
        if not isinstance(n, dict):
            return n
        if len(n) == 1:
            (k, v), = n.items()
            if k == "Ref":
                return self.ref(v)
            if k == "Fn::Sub":
                s = v if isinstance(v, str) else v[0]
                return re.sub(r"\$\{([^}]+)\}", lambda m: str(self.ref(m.group(1))), s)
            if k == "Fn::GetAtt":
                return "getatt:" + ".".join(v)
            if k == "Fn::Equals":
                a, b = self.r(v)
                return a == b
            if k == "Fn::Not":
                return not self.r(v)[0]
            if k == "Fn::If":
                c, a, b = v
                return self.r(a) if self.conds[c] else self.r(b)
            if k == "Fn::Join":
                return v[0].join(self.r(v[1]))
            if k == "Fn::Select":
                return self.r(v[1])[int(self.r(v[0]))]
            if k == "Fn::Split":
                return self.r(v[1]).split(v[0])
            if k == "Condition":
                return self.conds[v]
        return {kk: self.r(vv) for kk, vv in n.items()}


def load(create_plan="true"):
    raw = yaml.load(open(TEMPLATE), Loader)
    params = {
        "GitHubOwner": "example-owner",
        "GitHubRepo": "example-repo",
        "ExistingOidcProviderArn": "",
        "CreatePlanRole": create_plan,
        "AllowedInstanceTypes": ["t3.large", "t3a.large", "m5.large", "m6i.large"],
    }
    rs = Resolver(raw, params)
    res = {}
    for k, v in raw["Resources"].items():
        c = v.get("Condition")
        if c and not rs.conds[c]:
            continue
        res[k] = rs.r(v)
    return raw, res


# ---------------------------------------------------------------- IAM evaluation
def glob(pattern, value):
    rx = "".join(".*" if ch == "*" else "." if ch == "?" else re.escape(ch) for ch in pattern)
    return re.fullmatch(rx, value, re.S) is not None


def glob_i(pattern, value):
    return glob(pattern.lower(), value.lower())


def aslist(x):
    return x if isinstance(x, list) else [x]


NEGATED = {"StringNotEquals", "StringNotLike", "ArnNotEquals", "ArnNotLike"}


def one(base, cv, v):
    v = str(v)
    cv = str(cv)
    if base in ("StringEquals", "StringNotEquals"):
        return cv == v
    if base in ("StringLike", "StringNotLike", "ArnLike", "ArnNotLike", "ArnEquals", "ArnNotEquals"):
        return glob(v, cv)
    if base == "Bool":
        return cv.lower() == v.lower()
    raise ValueError("operator not implemented: " + base)


def cond_ok(cond, ctx):
    for op, kv in (cond or {}).items():
        setop = None
        base = op
        if ":" in op:
            setop, base = op.split(":", 1)
        ifex = base.endswith("IfExists")
        if ifex:
            base = base[: -len("IfExists")]
        for key, vals in kv.items():
            vals = aslist(vals)
            cvs = ctx.get(key.lower())
            if base == "Null":
                want = str(vals[0]).lower() == "true"
                if (cvs is None) != want:
                    return False
                continue
            if cvs is None:
                if ifex or setop == "ForAllValues" or (setop is None and base in NEGATED):
                    continue
                return False
            cvs = aslist(cvs)
            neg = base in NEGATED

            def elem(cv):
                m = any(one(base, cv, v) for v in vals)
                return (not m) if neg else m

            if setop == "ForAnyValue":
                ok = any(elem(c) for c in cvs)
            elif setop == "ForAllValues":
                ok = all(elem(c) for c in cvs)
            else:
                ok = all(elem(c) for c in cvs) if neg else any(elem(c) for c in cvs)
            if not ok:
                return False
    return True


def principal_ok(st, parn):
    if "Principal" not in st:
        return True  # identity-based
    p = st["Principal"]
    if p == "*":
        return "any"
    vals = []
    for k, v in p.items():
        if k == "AWS" and v == "*":
            return "any"
        vals += aslist(v)
    for v in vals:
        if v == parn:
            return "direct"
        if v.endswith(":root") and v.split(":")[4] == parn.split(":")[4]:
            return "delegation"
    return False


def stmt_matches(st, action, resource, ctx, parn, federated=None):
    pm = principal_ok(st, parn) if federated is None else False
    if federated is not None:
        fed = st.get("Principal", {}).get("Federated")
        pm = "direct" if fed == federated else False
    if not pm:
        return False
    if "Action" in st:
        if not any(glob_i(a, action) for a in aslist(st["Action"])):
            return False
    elif "NotAction" in st:
        if any(glob_i(a, action) for a in aslist(st["NotAction"])):
            return False
    if "Resource" in st:
        if not any(glob(r, resource) for r in aslist(st["Resource"])):
            return False
    elif "NotResource" in st:
        if any(glob(r, resource) for r in aslist(st["NotResource"])):
            return False
    return cond_ok(st.get("Condition"), ctx)


def evaluate(identity, boundary, resource_pols, parn, action, resource, ctx):
    ctx = {k.lower(): v for k, v in ctx.items()}
    ctx.setdefault("aws:principalarn", parn)
    ctx.setdefault("aws:securetransport", "true")
    for d in identity + ([boundary] if boundary else []) + resource_pols:
        for st in aslist(d["Statement"]):
            if st["Effect"] == "Deny" and stmt_matches(st, action, resource, ctx, parn):
                return "DENY", "explicit deny " + st.get("Sid", "?")
    ident = any(stmt_matches(st, action, resource, ctx, parn)
                for d in identity for st in aslist(d["Statement"]) if st["Effect"] == "Allow")
    bnd = True
    if boundary:
        bnd = any(stmt_matches(st, action, resource, ctx, parn)
                  for st in aslist(boundary["Statement"]) if st["Effect"] == "Allow")
    direct = any(st["Effect"] == "Allow" and principal_ok(st, parn) in ("direct", "any")
                 and stmt_matches(st, action, resource, ctx, parn)
                 for d in resource_pols for st in aslist(d["Statement"]))
    if (ident and bnd) or direct:
        return "ALLOW", "allowed"
    return "DENY", "implicit deny"


def trust_decision(doc, token):
    ctx = {k.lower(): v for k, v in token.items()}
    for st in aslist(doc["Statement"]):
        if st["Effect"] == "Allow" and stmt_matches(
                st, "sts:AssumeRoleWithWebIdentity", "*", ctx, "", federated=OIDC_ARN) \
                and st["Action"] == "sts:AssumeRoleWithWebIdentity":
            return "ALLOW"
    return "DENY"


# ---------------------------------------------------------------- build the world
def build(res):
    pols = {}
    for k, v in res.items():
        if v["Type"] == "AWS::IAM::ManagedPolicy":
            p = v["Properties"]
            pols[k] = p
    by_role = {}
    for k, p in pols.items():
        for r in p.get("Roles", []):
            by_role.setdefault(r.replace("ref:", ""), []).append(p["PolicyDocument"])
    boundary = pols["PilotBoundaryPolicy"]["PolicyDocument"]
    bucket_pol = res["PilotStateBucketPolicy"]["Properties"]["PolicyDocument"]
    key_pol = res["PilotStateKey"]["Properties"]["KeyPolicy"]
    return pols, by_role, boundary, bucket_pol, key_pol


A = ACCT
def arn(svc, rest, region=REGION, acct=A):
    return f"arn:aws:{svc}:{region}:{acct}:{rest}"

TF = "arn:aws:s3:::codeproctor-pilot-tfstate-" + A
DEPLOY = f"arn:aws:iam::{A}:role/codeproctor-guardrails/codeproctor-pilot-deploy"
PLAN = f"arn:aws:iam::{A}:role/codeproctor-guardrails/codeproctor-pilot-plan"
APP = f"arn:aws:iam::{A}:role/codeproctor-pilot-app"
BOUNDARY = f"arn:aws:iam::{A}:policy/codeproctor-guardrails/codeproctor-pilot-boundary"
OTHER_BOUNDARY = f"arn:aws:iam::{A}:policy/some-other-boundary"
OWNER = f"arn:aws:iam::{A}:user/owner"
P = {"aws:RequestTag/Environment": "pilot"}
T = {"aws:ResourceTag/Environment": "pilot"}
def tag(**kw):
    return {"aws:ResourceTag/" + k: v for k, v in kw.items()}

def key(id_="k1"):
    return arn("kms", "key/" + id_)

# (name, principal, action, resource, ctx, expected)
def cases():
    c = []
    def add(n, pr, act, res, ctx, exp):
        c.append((n, pr, act, res, ctx or {}, exp))
    D = "deploy"
    # --- nothing outside codeproctor-pilot-* / Environment=pilot is touchable
    add("S3 create bucket codeproctor-pilot-x", D, "s3:CreateBucket", "arn:aws:s3:::codeproctor-pilot-x", P, "ALLOW")
    add("S3 create bucket codeproctor-pilot-x tagged other", D, "s3:CreateBucket", "arn:aws:s3:::codeproctor-pilot-x", {"aws:RequestTag/Environment": "staging"}, "DENY")
    add("S3 create bucket other name", D, "s3:CreateBucket", "arn:aws:s3:::codeproctor-staging-x", P, "DENY")
    add("S3 create bucket unrelated name", D, "s3:CreateBucket", "arn:aws:s3:::my-bucket", {}, "DENY")
    add("S3 delete bucket other name", D, "s3:DeleteBucket", "arn:aws:s3:::codeproctor-staging-x", {}, "DENY")
    add("S3 put lifecycle on pilot backup bucket", D, "s3:PutLifecycleConfiguration", "arn:aws:s3:::codeproctor-pilot-backups", {}, "ALLOW")
    add("S3 put bucket policy on pilot recordings bucket", D, "s3:PutBucketPolicy", "arn:aws:s3:::codeproctor-pilot-recordings", {}, "ALLOW")
    add("S3 get object in pilot recordings (data)", D, "s3:GetObject", "arn:aws:s3:::codeproctor-pilot-recordings/a/b.webm", {}, "DENY")
    add("S3 put object in pilot backups (data)", D, "s3:PutObject", "arn:aws:s3:::codeproctor-pilot-backups/db.dump", {}, "DENY")
    add("S3 get object in other bucket", D, "s3:GetObject", "arn:aws:s3:::codeproctor-staging-x/k", {}, "DENY")
    add("State: get state object", D, "s3:GetObject", TF + "/pilot/terraform.tfstate", {}, "ALLOW")
    add("State: put state lock object", D, "s3:PutObject", TF + "/pilot/terraform.tfstate.tflock", {}, "ALLOW")
    add("State: delete lock object", D, "s3:DeleteObject", TF + "/pilot/terraform.tfstate.tflock", {}, "ALLOW")
    add("State: delete state object itself", D, "s3:DeleteObject", TF + "/pilot/terraform.tfstate", {}, "DENY")
    add("State: delete object version", D, "s3:DeleteObjectVersion", TF + "/pilot/terraform.tfstate", {}, "DENY")
    add("State: change bucket policy", D, "s3:PutBucketPolicy", TF, {}, "DENY")
    add("State: disable versioning", D, "s3:PutBucketVersioning", TF, {}, "DENY")
    add("State: delete bucket", D, "s3:DeleteBucket", TF, {}, "DENY")
    # KMS
    add("KMS create key tagged pilot", D, "kms:CreateKey", "*", P, "ALLOW")
    add("KMS create key tagged other", D, "kms:CreateKey", "*", {"aws:RequestTag/Environment": "staging"}, "DENY")
    add("KMS create key untagged", D, "kms:CreateKey", "*", {}, "DENY")
    add("KMS describe key tagged pilot", D, "kms:DescribeKey", key(), T, "ALLOW")
    add("KMS describe key tagged other", D, "kms:DescribeKey", key(), tag(Environment="staging"), "DENY")
    add("KMS describe key untagged", D, "kms:DescribeKey", key(), {}, "DENY")
    add("KMS schedule deletion of pilot data key", D, "kms:ScheduleKeyDeletion", key(), {**T, **tag(Purpose="data")}, "ALLOW")
    add("KMS schedule deletion of state key", D, "kms:ScheduleKeyDeletion", key(), {**T, **tag(Purpose="tfstate")}, "DENY")
    add("KMS decrypt with pilot data key", D, "kms:Decrypt", key(), {**T, **tag(Purpose="data")}, "DENY")
    add("KMS decrypt with state key", D, "kms:Decrypt", key(), {**T, **tag(Purpose="tfstate")}, "ALLOW")
    add("KMS create grant for AWS service", D, "kms:CreateGrant", key(), {**T, "kms:GrantIsForAWSResource": "true"}, "ALLOW")
    add("KMS create grant for a principal", D, "kms:CreateGrant", key(), {**T, "kms:GrantIsForAWSResource": "false"}, "DENY")
    add("KMS create alias codeproctor-pilot-data", D, "kms:CreateAlias", arn("kms", "alias/codeproctor-pilot-data"), {}, "ALLOW")
    add("KMS create alias other name", D, "kms:CreateAlias", arn("kms", "alias/codeproctor-staging-data"), {}, "DENY")
    # Secrets
    add("Secrets create codeproctor-pilot-db tagged", D, "secretsmanager:CreateSecret", arn("secretsmanager", "secret:codeproctor-pilot-db-AbCdEf"), P, "ALLOW")
    add("Secrets create untagged", D, "secretsmanager:CreateSecret", arn("secretsmanager", "secret:codeproctor-pilot-db-AbCdEf"), {}, "DENY")
    add("Secrets create other name", D, "secretsmanager:CreateSecret", arn("secretsmanager", "secret:prod-db-AbCdEf"), P, "DENY")
    add("Secrets get value of pilot secret", D, "secretsmanager:GetSecretValue", arn("secretsmanager", "secret:codeproctor-pilot-db-AbCdEf"), T, "DENY")
    add("Secrets describe pilot secret", D, "secretsmanager:DescribeSecret", arn("secretsmanager", "secret:codeproctor-pilot-db-AbCdEf"), T, "ALLOW")
    add("Secrets delete other secret", D, "secretsmanager:DeleteSecret", arn("secretsmanager", "secret:other-AbCdEf"), tag(Environment="staging"), "DENY")
    # Logs
    add("Logs create group /codeproctor/pilot/api", D, "logs:CreateLogGroup", arn("logs", "log-group:/codeproctor/pilot/api"), P, "ALLOW")
    add("Logs create group codeproctor-pilot-api", D, "logs:CreateLogGroup", arn("logs", "log-group:codeproctor-pilot-api"), P, "ALLOW")
    add("Logs create group /other", D, "logs:CreateLogGroup", arn("logs", "log-group:/other"), P, "DENY")
    add("Logs read events of pilot group", D, "logs:GetLogEvents", arn("logs", "log-group:/codeproctor/pilot/api:log-stream:s"), {}, "DENY")
    add("Logs delete other group", D, "logs:DeleteLogGroup", arn("logs", "log-group:/aws/lambda/x"), {}, "DENY")
    # SSM / SES / alarms / budgets / scheduler
    add("SSM put parameter /codeproctor/pilot/x", D, "ssm:PutParameter", arn("ssm", "parameter/codeproctor/pilot/x"), {}, "ALLOW")
    add("SSM put parameter /codeproctor/other/x", D, "ssm:PutParameter", arn("ssm", "parameter/codeproctor/other/x"), {}, "DENY")
    add("SSM get parameter pilot (value read)", D, "ssm:GetParameter", arn("ssm", "parameter/codeproctor/pilot/x"), {}, "DENY")
    add("SES create identity tagged pilot", D, "ses:CreateEmailIdentity", arn("ses", "identity/example.org"), P, "ALLOW")
    add("SES create identity untagged", D, "ses:CreateEmailIdentity", arn("ses", "identity/example.org"), {}, "DENY")
    add("SES delete identity tagged other", D, "ses:DeleteEmailIdentity", arn("ses", "identity/example.org"), tag(Environment="staging"), "DENY")
    add("SES delete identity untagged", D, "ses:DeleteEmailIdentity", arn("ses", "identity/example.org"), {}, "DENY")
    add("SES send email (deploy never sends)", D, "ses:SendEmail", arn("ses", "identity/example.org"), T, "DENY")
    add("Alarm put codeproctor-pilot-cpu", D, "cloudwatch:PutMetricAlarm", arn("cloudwatch", "alarm:codeproctor-pilot-cpu"), {}, "ALLOW")
    add("Alarm put other name", D, "cloudwatch:PutMetricAlarm", arn("cloudwatch", "alarm:other"), {}, "DENY")
    add("Budget modify codeproctor-pilot-monthly", D, "budgets:ModifyBudget", f"arn:aws:budgets::{A}:budget/codeproctor-pilot-monthly", {}, "ALLOW")
    add("Budget modify other", D, "budgets:ModifyBudget", f"arn:aws:budgets::{A}:budget/other", {}, "DENY")
    add("Scheduler create schedule in pilot group", D, "scheduler:CreateSchedule", arn("scheduler", "schedule/codeproctor-pilot-windows/start"), {}, "ALLOW")
    add("Scheduler create schedule in default group", D, "scheduler:CreateSchedule", arn("scheduler", "schedule/default/start"), {}, "DENY")
    add("Scheduler delete schedule in other group", D, "scheduler:DeleteSchedule", arn("scheduler", "schedule/other/x"), {}, "DENY")
    # EC2
    inst = arn("ec2", "instance/i-0abc")
    add("EC2 run instance tagged, IMDSv2, allowed type", D, "ec2:RunInstances", inst, {**P, "ec2:MetadataHttpTokens": "required", "ec2:InstanceType": "t3.large"}, "ALLOW")
    add("EC2 run instance tagged other", D, "ec2:RunInstances", inst, {"aws:RequestTag/Environment": "staging", "ec2:MetadataHttpTokens": "required", "ec2:InstanceType": "t3.large"}, "DENY")
    add("EC2 run instance untagged", D, "ec2:RunInstances", inst, {"ec2:MetadataHttpTokens": "required", "ec2:InstanceType": "t3.large"}, "DENY")
    add("EC2 run instance without IMDSv2", D, "ec2:RunInstances", inst, {**P, "ec2:MetadataHttpTokens": "optional", "ec2:InstanceType": "t3.large"}, "DENY")
    add("EC2 run instance type m5.24xlarge (cost)", D, "ec2:RunInstances", inst, {**P, "ec2:MetadataHttpTokens": "required", "ec2:InstanceType": "m5.24xlarge"}, "DENY")
    add("EC2 run encrypted volume tagged", D, "ec2:RunInstances", arn("ec2", "volume/*"), {**P, "ec2:Encrypted": "true"}, "ALLOW")
    add("EC2 run unencrypted volume", D, "ec2:RunInstances", arn("ec2", "volume/*"), {**P, "ec2:Encrypted": "false"}, "DENY")
    add("EC2 run into untagged subnet", D, "ec2:RunInstances", arn("ec2", "subnet/subnet-1"), {}, "DENY")
    add("EC2 run into subnet tagged pilot", D, "ec2:RunInstances", arn("ec2", "subnet/subnet-1"), T, "ALLOW")
    add("EC2 start tagged pilot instance", D, "ec2:StartInstances", inst, T, "ALLOW")
    add("EC2 stop tagged pilot instance", D, "ec2:StopInstances", inst, T, "ALLOW")
    add("EC2 terminate tagged pilot instance", D, "ec2:TerminateInstances", inst, T, "ALLOW")
    add("EC2 terminate untagged instance", D, "ec2:TerminateInstances", inst, {}, "DENY")
    add("EC2 terminate instance tagged other", D, "ec2:TerminateInstances", inst, tag(Environment="staging"), "DENY")
    add("EC2 stop instance tagged other", D, "ec2:StopInstances", inst, tag(Environment="staging"), "DENY")
    add("EC2 delete volume tagged other", D, "ec2:DeleteVolume", arn("ec2", "volume/vol-1"), tag(Environment="prod"), "DENY")
    add("EC2 security group ingress, tagged pilot", D, "ec2:AuthorizeSecurityGroupIngress", arn("ec2", "security-group/sg-1"), T, "ALLOW")
    add("EC2 security group ingress, untagged", D, "ec2:AuthorizeSecurityGroupIngress", arn("ec2", "security-group/sg-1"), {}, "DENY")
    add("EC2 remove Environment tag", D, "ec2:DeleteTags", inst, {**T, "aws:TagKeys": ["Environment"]}, "DENY")
    add("EC2 re-tag Environment after create", D, "ec2:CreateTags", inst, {**T, **P, "aws:TagKeys": ["Environment"]}, "DENY")
    add("EC2 tag on create (RunInstances)", D, "ec2:CreateTags", inst, {**P, "ec2:CreateAction": "RunInstances", "aws:TagKeys": ["Environment"]}, "ALLOW")
    add("EC2 add Name tag to pilot instance", D, "ec2:CreateTags", inst, {**T, "aws:TagKeys": ["Name"]}, "ALLOW")
    add("EC2 describe instances (known limitation: no resource-level support)", D, "ec2:DescribeInstances", "*", {}, "ALLOW")
    add("EC2 create NAT gateway (cost)", D, "ec2:CreateNatGateway", arn("ec2", "natgateway/nat-1"), P, "DENY")
    add("EC2 create VPC peering (cost)", D, "ec2:CreateVpcPeeringConnection", arn("ec2", "vpc-peering-connection/*"), P, "DENY")
    add("EC2 create transit gateway (cost)", D, "ec2:CreateTransitGateway", "*", P, "DENY")
    add("EC2 import key pair (no SSH keys)", D, "ec2:ImportKeyPair", arn("ec2", "key-pair/k"), P, "DENY")
    add("EC2 allocate Elastic IP tagged", D, "ec2:AllocateAddress", arn("ec2", "elastic-ip/*"), P, "ALLOW")
    # cost guard: RDS, ELB
    add("RDS create DB instance", D, "rds:CreateDBInstance", arn("rds", "db:codeproctor-pilot-db"), P, "DENY")
    add("RDS describe DB instances", D, "rds:DescribeDBInstances", arn("rds", "db:codeproctor-pilot-db"), {}, "DENY")
    add("ELB create load balancer", D, "elasticloadbalancing:CreateLoadBalancer", "*", P, "DENY")
    add("Lambda create function", D, "lambda:CreateFunction", arn("lambda", "function:codeproctor-pilot-f"), P, "DENY")
    add("CloudFormation create stack", D, "cloudformation:CreateStack", "*", {}, "DENY")
    # IAM
    rolepilot = f"arn:aws:iam::{A}:role/codeproctor-pilot-app"
    ok_b = {"iam:PermissionsBoundary": BOUNDARY}
    add("IAM create role codeproctor-pilot-app with boundary", D, "iam:CreateRole", rolepilot, {**ok_b, **P}, "ALLOW")
    add("IAM create role without boundary", D, "iam:CreateRole", rolepilot, P, "DENY")
    add("IAM create role with another boundary", D, "iam:CreateRole", rolepilot, {"iam:PermissionsBoundary": OTHER_BOUNDARY, **P}, "DENY")
    add("IAM create role wrong prefix", D, "iam:CreateRole", f"arn:aws:iam::{A}:role/admin-role", {**ok_b, **P}, "DENY")
    add("IAM create role with boundary but tagged other", D, "iam:CreateRole", rolepilot, {**ok_b, "aws:RequestTag/Environment": "staging"}, "DENY")
    add("IAM create role named like the deploy role", D, "iam:CreateRole", f"arn:aws:iam::{A}:role/codeproctor-pilot-deploy", {**ok_b, **P}, "DENY")
    add("IAM attach custom pilot policy to bounded pilot role", D, "iam:AttachRolePolicy", rolepilot, {**ok_b, "iam:PolicyARN": f"arn:aws:iam::{A}:policy/codeproctor-pilot-app"}, "ALLOW")
    add("IAM attach AdministratorAccess to pilot role", D, "iam:AttachRolePolicy", rolepilot, {**ok_b, "iam:PolicyARN": "arn:aws:iam::aws:policy/AdministratorAccess"}, "DENY")
    add("IAM attach policy to role without boundary", D, "iam:AttachRolePolicy", rolepilot, {"iam:PolicyARN": f"arn:aws:iam::{A}:policy/codeproctor-pilot-app"}, "DENY")
    add("IAM attach boundary policy as a normal policy", D, "iam:AttachRolePolicy", rolepilot, {**ok_b, "iam:PolicyARN": BOUNDARY}, "DENY")
    add("IAM put inline policy on bounded pilot role", D, "iam:PutRolePolicy", rolepilot, ok_b, "ALLOW")
    add("IAM put inline policy on unbounded role", D, "iam:PutRolePolicy", rolepilot, {}, "DENY")
    add("IAM update trust of pilot app role", D, "iam:UpdateAssumeRolePolicy", rolepilot, {}, "ALLOW")
    add("IAM update trust of deploy role (self)", D, "iam:UpdateAssumeRolePolicy", DEPLOY, {}, "DENY")
    add("IAM update trust of deploy role (bare name)", D, "iam:UpdateAssumeRolePolicy", f"arn:aws:iam::{A}:role/codeproctor-pilot-deploy", {}, "DENY")
    add("IAM attach policy to deploy role", D, "iam:AttachRolePolicy", DEPLOY, {**ok_b, "iam:PolicyARN": f"arn:aws:iam::{A}:policy/codeproctor-pilot-app"}, "DENY")
    add("IAM put inline policy on plan role", D, "iam:PutRolePolicy", PLAN, ok_b, "DENY")
    add("IAM delete deploy role", D, "iam:DeleteRole", DEPLOY, {}, "DENY")
    add("IAM create policy version of boundary", D, "iam:CreatePolicyVersion", BOUNDARY, {}, "DENY")
    add("IAM create policy version of boundary (bare ARN)", D, "iam:CreatePolicyVersion", f"arn:aws:iam::{A}:policy/codeproctor-pilot-boundary", {}, "DENY")
    add("IAM delete boundary policy", D, "iam:DeletePolicy", BOUNDARY, {}, "DENY")
    add("IAM set default version of deploy-core policy", D, "iam:SetDefaultPolicyVersion", f"arn:aws:iam::{A}:policy/codeproctor-guardrails/codeproctor-pilot-deploy-core", {}, "DENY")
    add("IAM create policy codeproctor-pilot-app", D, "iam:CreatePolicy", f"arn:aws:iam::{A}:policy/codeproctor-pilot-app", {}, "ALLOW")
    add("IAM create policy codeproctor-pilot-deploy-evil", D, "iam:CreatePolicy", f"arn:aws:iam::{A}:policy/codeproctor-pilot-deploy-evil", {}, "DENY")
    add("IAM create policy other name", D, "iam:CreatePolicy", f"arn:aws:iam::{A}:policy/other", {}, "DENY")
    add("IAM delete role permissions boundary", D, "iam:DeleteRolePermissionsBoundary", rolepilot, ok_b, "DENY")
    add("IAM put role permissions boundary (other)", D, "iam:PutRolePermissionsBoundary", rolepilot, {"iam:PermissionsBoundary": OTHER_BOUNDARY}, "DENY")
    add("IAM put role permissions boundary (same)", D, "iam:PutRolePermissionsBoundary", rolepilot, ok_b, "DENY")
    add("IAM create user", D, "iam:CreateUser", f"arn:aws:iam::{A}:user/codeproctor-pilot-u", {}, "DENY")
    add("IAM create access key", D, "iam:CreateAccessKey", f"arn:aws:iam::{A}:user/codeproctor-pilot-u", {}, "DENY")
    add("IAM create login profile", D, "iam:CreateLoginProfile", f"arn:aws:iam::{A}:user/codeproctor-pilot-u", {}, "DENY")
    add("IAM create OIDC provider", D, "iam:CreateOpenIDConnectProvider", f"arn:aws:iam::{A}:oidc-provider/evil.example", {}, "DENY")
    add("IAM update thumbprint of GitHub OIDC provider", D, "iam:UpdateOpenIDConnectProviderThumbprint", OIDC_ARN, {}, "DENY")
    add("IAM create SAML provider", D, "iam:CreateSAMLProvider", f"arn:aws:iam::{A}:saml-provider/x", {}, "DENY")
    add("IAM create instance profile codeproctor-pilot-app", D, "iam:CreateInstanceProfile", f"arn:aws:iam::{A}:instance-profile/codeproctor-pilot-app", {}, "ALLOW")
    add("IAM create instance profile other name", D, "iam:CreateInstanceProfile", f"arn:aws:iam::{A}:instance-profile/other", {}, "DENY")
    add("IAM pass pilot role to ec2", D, "iam:PassRole", rolepilot, {"iam:PassedToService": "ec2.amazonaws.com"}, "ALLOW")
    add("IAM pass pilot role to scheduler", D, "iam:PassRole", f"arn:aws:iam::{A}:role/codeproctor-pilot-scheduler", {"iam:PassedToService": "scheduler.amazonaws.com"}, "ALLOW")
    add("IAM pass pilot role to lambda", D, "iam:PassRole", rolepilot, {"iam:PassedToService": "lambda.amazonaws.com"}, "DENY")
    add("IAM pass pilot role to ecs-tasks", D, "iam:PassRole", rolepilot, {"iam:PassedToService": "ecs-tasks.amazonaws.com"}, "DENY")
    add("IAM pass pilot role to cloudformation", D, "iam:PassRole", rolepilot, {"iam:PassedToService": "cloudformation.amazonaws.com"}, "DENY")
    add("IAM pass role without service condition", D, "iam:PassRole", rolepilot, {}, "DENY")
    add("IAM pass role other name to ec2", D, "iam:PassRole", f"arn:aws:iam::{A}:role/admin", {"iam:PassedToService": "ec2.amazonaws.com"}, "DENY")
    add("IAM pass deploy role to ec2", D, "iam:PassRole", DEPLOY, {"iam:PassedToService": "ec2.amazonaws.com"}, "DENY")
    add("IAM create service-linked role for RDS", D, "iam:CreateServiceLinkedRole", f"arn:aws:iam::{A}:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS", {}, "DENY")
    add("STS assume another role", D, "sts:AssumeRole", f"arn:aws:iam::{A}:role/OrganizationAccountAccessRole", {}, "DENY")
    # --- plan role
    PL = "plan"
    add("Plan: get state object", PL, "s3:GetObject", TF + "/pilot/terraform.tfstate", {}, "ALLOW")
    add("Plan: write state object", PL, "s3:PutObject", TF + "/pilot/terraform.tfstate", {}, "DENY")
    add("Plan: write lock object", PL, "s3:PutObject", TF + "/pilot/terraform.tfstate.tflock", {}, "ALLOW")
    add("Plan: delete lock object", PL, "s3:DeleteObject", TF + "/pilot/terraform.tfstate.tflock", {}, "ALLOW")
    add("Plan: delete state object", PL, "s3:DeleteObject", TF + "/pilot/terraform.tfstate", {}, "DENY")
    add("Plan: read data bucket object", PL, "s3:GetObject", "arn:aws:s3:::codeproctor-pilot-recordings/a.webm", {}, "DENY")
    add("Plan: read bucket config", PL, "s3:GetBucketPolicy", "arn:aws:s3:::codeproctor-pilot-recordings", {}, "ALLOW")
    add("Plan: change bucket config", PL, "s3:PutBucketPolicy", "arn:aws:s3:::codeproctor-pilot-recordings", {}, "DENY")
    add("Plan: read other bucket", PL, "s3:GetBucketPolicy", "arn:aws:s3:::other", {}, "DENY")
    add("Plan: secret value", PL, "secretsmanager:GetSecretValue", arn("secretsmanager", "secret:codeproctor-pilot-db-AbCdEf"), T, "DENY")
    add("Plan: describe secret", PL, "secretsmanager:DescribeSecret", arn("secretsmanager", "secret:codeproctor-pilot-db-AbCdEf"), T, "ALLOW")
    add("Plan: kms decrypt data key", PL, "kms:Decrypt", key(), {**T, **tag(Purpose="data")}, "DENY")
    add("Plan: kms decrypt state key", PL, "kms:Decrypt", key(), {**T, **tag(Purpose="tfstate")}, "ALLOW")
    add("Plan: ssm get parameter", PL, "ssm:GetParameter", arn("ssm", "parameter/codeproctor/pilot/x"), {}, "DENY")
    add("Plan: read log events", PL, "logs:GetLogEvents", arn("logs", "log-group:/codeproctor/pilot/api:log-stream:s"), {}, "DENY")
    add("Plan: ses send", PL, "ses:SendEmail", arn("ses", "identity/example.org"), T, "DENY")
    add("Plan: rds-data statement", PL, "rds-data:ExecuteStatement", "*", {}, "DENY")
    add("Plan: describe instances", PL, "ec2:DescribeInstances", "*", {}, "ALLOW")
    add("Plan: terminate pilot instance", PL, "ec2:TerminateInstances", arn("ec2", "instance/i-1"), T, "DENY")
    add("Plan: run instance", PL, "ec2:RunInstances", arn("ec2", "instance/i-1"), P, "DENY")
    add("Plan: create role", PL, "iam:CreateRole", rolepilot, {}, "DENY")
    add("Plan: read pilot role", PL, "iam:GetRole", rolepilot, {}, "ALLOW")
    add("Plan: pass role", PL, "iam:PassRole", rolepilot, {"iam:PassedToService": "ec2.amazonaws.com"}, "DENY")
    # --- workloads (role created with the boundary, worst case identity policy Allow */*)
    W = "workload"
    add("Boundary: read pilot recordings object", W, "s3:GetObject", "arn:aws:s3:::codeproctor-pilot-recordings/a.webm", {}, "ALLOW")
    add("Boundary: write pilot backup object", W, "s3:PutObject", "arn:aws:s3:::codeproctor-pilot-backups/db.dump", {}, "ALLOW")
    add("Boundary: read other bucket object", W, "s3:GetObject", "arn:aws:s3:::other-bucket/a", {}, "DENY")
    add("Boundary: read state object", W, "s3:GetObject", TF + "/pilot/terraform.tfstate", {}, "DENY")
    add("Boundary: decrypt with pilot key", W, "kms:Decrypt", key(), {**T, **tag(Purpose="data")}, "ALLOW")
    add("Boundary: decrypt with untagged key", W, "kms:Decrypt", key(), {}, "DENY")
    add("Boundary: decrypt with state key", W, "kms:Decrypt", key(), {**T, **tag(Purpose="tfstate")}, "DENY")
    add("Boundary: read pilot secret", W, "secretsmanager:GetSecretValue", arn("secretsmanager", "secret:codeproctor-pilot-db-AbCdEf"), {}, "ALLOW")
    add("Boundary: read other secret", W, "secretsmanager:GetSecretValue", arn("secretsmanager", "secret:other-AbCdEf"), {}, "DENY")
    add("Boundary: send mail from pilot identity", W, "ses:SendEmail", arn("ses", "identity/example.org"), T, "ALLOW")
    add("Boundary: send mail from untagged identity", W, "ses:SendEmail", arn("ses", "identity/example.org"), {}, "DENY")
    add("Boundary: read pilot parameter", W, "ssm:GetParameter", arn("ssm", "parameter/codeproctor/pilot/x"), {}, "ALLOW")
    add("Boundary: read other parameter", W, "ssm:GetParameter", arn("ssm", "parameter/other/x"), {}, "DENY")
    add("Boundary: put pilot logs", W, "logs:PutLogEvents", arn("logs", "log-group:/codeproctor/pilot/api:log-stream:s"), {}, "ALLOW")
    add("Boundary: scheduler start pilot instance", W, "ec2:StartInstances", arn("ec2", "instance/i-1"), T, "ALLOW")
    add("Boundary: scheduler stop untagged instance", W, "ec2:StopInstances", arn("ec2", "instance/i-1"), {}, "DENY")
    add("Boundary: scheduler terminate pilot instance", W, "ec2:TerminateInstances", arn("ec2", "instance/i-1"), T, "DENY")
    add("Boundary: create IAM user", W, "iam:CreateUser", f"arn:aws:iam::{A}:user/x", {}, "DENY")
    add("Boundary: assume role", W, "sts:AssumeRole", f"arn:aws:iam::{A}:role/x", {}, "DENY")
    add("Boundary: create RDS", W, "rds:CreateDBInstance", arn("rds", "db:x"), {}, "DENY")
    # --- resource policies of the state bucket / key (principals with admin identity policies)
    add("Bucket policy: app role reads state (admin identity)", "app-admin", "s3:GetObject", TF + "/pilot/terraform.tfstate", {}, "DENY")
    add("Bucket policy: app role changes state bucket config", "app-admin", "s3:PutBucketPolicy", TF, {}, "DENY")
    add("Bucket policy: non-TLS request by deploy role", D, "s3:GetObject", TF + "/pilot/terraform.tfstate", {"aws:SecureTransport": "false"}, "DENY")
    add("Bucket policy: owner (human admin) reads state over TLS", "owner", "s3:GetObject", TF + "/pilot/terraform.tfstate", {}, "ALLOW")
    add("Bucket policy: owner deletes object versions", "owner", "s3:DeleteObjectVersion", TF + "/pilot/terraform.tfstate", {}, "DENY")
    add("Key policy: app role decrypts state key (admin identity)", "app-admin", "kms:Decrypt", key(), {**T, **tag(Purpose="tfstate")}, "DENY")
    add("Key policy: owner decrypts state key", "owner", "kms:Decrypt", key(), {**T, **tag(Purpose="tfstate")}, "ALLOW")
    return c


# trust: (name, role, token claims, expected)
def trust_cases():
    def tok(sub, aud="sts.amazonaws.com"):
        return {"token.actions.githubusercontent.com:sub": sub, "token.actions.githubusercontent.com:aud": aud}
    R = "repo:example-owner/example-repo"
    return [
        ("Trust deploy: environment:pilot", "PilotDeployRole", tok(R + ":environment:pilot"), "ALLOW"),
        ("Trust deploy: environment:staging", "PilotDeployRole", tok(R + ":environment:staging"), "DENY"),
        ("Trust deploy: environment:pilot-evil", "PilotDeployRole", tok(R + ":environment:pilot-evil"), "DENY"),
        ("Trust deploy: another repo", "PilotDeployRole", tok("repo:example-owner/other-repo:environment:pilot"), "DENY"),
        ("Trust deploy: repo with same prefix", "PilotDeployRole", tok("repo:example-owner/example-repo-evil:environment:pilot"), "DENY"),
        ("Trust deploy: another owner", "PilotDeployRole", tok("repo:evil-owner/example-repo:environment:pilot"), "DENY"),
        ("Trust deploy: branch ref", "PilotDeployRole", tok(R + ":ref:refs/heads/main"), "DENY"),
        ("Trust deploy: pull_request", "PilotDeployRole", tok(R + ":pull_request"), "DENY"),
        ("Trust deploy: wrong audience", "PilotDeployRole", tok(R + ":environment:pilot", "sts.evil.example"), "DENY"),
        ("Trust deploy: missing audience", "PilotDeployRole", {"token.actions.githubusercontent.com:sub": R + ":environment:pilot"}, "DENY"),
        ("Trust plan: pull_request", "PilotPlanRole", tok(R + ":pull_request"), "ALLOW"),
        ("Trust plan: environment:pilot", "PilotPlanRole", tok(R + ":environment:pilot"), "DENY"),
        ("Trust plan: branch ref", "PilotPlanRole", tok(R + ":ref:refs/heads/main"), "DENY"),
        ("Trust plan: pull_request of another repo", "PilotPlanRole", tok("repo:example-owner/other:pull_request"), "DENY"),
        ("Trust plan: wrong audience", "PilotPlanRole", tok(R + ":pull_request", "x"), "DENY"),
    ]


def main():
    fails = []
    raw, res = load("true")
    pols, by_role, boundary, bucket_pol, key_pol = build(res)

    # --- structural checks
    text = open(TEMPLATE).read()
    checks = []
    checks.append(("no 12-digit account id or access key in template", not re.search(r"(?<![\w{])\d{12}(?![\w}])", text.replace("{12}", "")) and not re.search(r"AKIA[0-9A-Z]{16}", text)))
    for k, p in pols.items():
        size = len(re.sub(r"\s", "", json.dumps(p["PolicyDocument"])))
        checks.append((f"managed policy {k} under 6144 chars ({size})", size < 6144))
    checks.append(("every deploy policy attached to the deploy role", len(by_role["PilotDeployRole"]) == 5))
    checks.append(("all policies under /codeproctor-guardrails/", all(p["Path"] == "/codeproctor-guardrails/" for p in pols.values())))
    checks.append(("no inline policies on roles", all("Policies" not in v["Properties"] for v in res.values() if v["Type"] == "AWS::IAM::Role")))
    _, res_off = load("false")
    checks.append(("plan role and its policies absent when CreatePlanRole=false", not any("Plan" in k for k in res_off)))
    checks.append(("only pilot roles exist", all("pilot" in v["Properties"]["RoleName"] for v in res.values() if v["Type"] == "AWS::IAM::Role")))
    checks.append(("every resource is pilot-scoped (no staging resources)", all(k.startswith("Pilot") or k == "GitHubOidcProvider" for k in raw["Resources"])))
    print("Structural checks")
    for n, ok in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
        if not ok:
            fails.append(n)

    # --- policy matrix
    world = {
        "deploy": (by_role["PilotDeployRole"], None, DEPLOY),
        "plan": (by_role["PilotPlanRole"], None, PLAN),
        "workload": ([{"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}], boundary, APP),
        "app-admin": ([{"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}], None, APP),
        "owner": ([{"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}], None, OWNER),
    }
    rows = []
    for (n, pr, act, rsrc, ctx, exp) in cases():
        ident, bnd, parn = world[pr]
        rps = []
        if rsrc.startswith(TF):
            rps.append(bucket_pol)
        if act.startswith("kms:") and ctx.get("aws:ResourceTag/Purpose") == "tfstate":
            rps.append(key_pol)
        got, why = evaluate(ident, bnd, rps, parn, act, rsrc, ctx)
        rows.append((n, pr, act, exp, got, why))
    for (n, role, token, exp) in trust_cases():
        doc = res[role]["Properties"]["AssumeRolePolicyDocument"]
        got = trust_decision(doc, token)
        rows.append((n, "trust", "sts:AssumeRoleWithWebIdentity", exp, got, "trust policy"))

    w = max(len(r[0]) for r in rows)
    print("\n%-*s  %-9s  %-6s %-6s %s" % (w, "case", "principal", "expect", "got", "result"))
    npass = 0
    for (n, pr, act, exp, got, why) in rows:
        ok = exp == got
        npass += ok
        if not ok:
            fails.append(n)
        print("%-*s  %-9s  %-6s %-6s %s%s" % (w, n, pr, exp, got, "ok" if ok else "MISMATCH", "" if ok else " (" + why + ")"))
    print(f"\n{len(rows)} cases, {npass} pass, {len(rows) - npass} fail; {len(checks)} structural checks")
    if len(rows) < 40:
        fails.append("fewer than 40 cases")
    if fails:
        print("FAILED:", *fails, sep="\n  ")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
