#!/usr/bin/env python3
"""Offline isolation test for infra/aws/github-oidc-roles.yaml (DEP-01 PR 1, narrowed per ADR 0017 sections 6 and 7).

The CI role may do exactly two things: push images to ECR repositories codeproctor-pilot-* (UseEcr)
and s3:PutObject on the two release manifest prefixes. Everything else must be denied.

Parses the CloudFormation template, resolves intrinsic functions with fixed test values, and
evaluates a matrix of (principal, action, resource, context) against the identity policies, the
permissions boundary, the state bucket policy, the state key policy and the role trust policies,
using a small implementation of IAM evaluation semantics (explicit Deny wins, implicit deny,
wildcards, condition operators, boundary intersection, resource-policy deny).

It approximates IAM. It cannot model every service-specific behaviour (for example which actions
really support a condition key). The owner script simulate-principal-policy.sh, run against the
deployed roles, is the authoritative check.

TC IDs: QA to allocate (docs/test-cases.md has no DEP section). Do not read the case names as TC ids.

Context keys: every case lists the condition keys that the test author supplies by hand (the
"keys" column). Keys marked * are defaulted by the harness: aws:ResourceAccount (the account id, for
S3 actions), aws:SecureTransport=true and aws:PrincipalArn (the principal's role ARN). Real
requests carry these automatically; which keys a real action carries is what the owner script
checks.

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


for _n in ("Ref", "Sub", "GetAtt", "If", "Equals", "Not", "Or", "And", "Join", "Select", "Split", "FindInMap"):
    Loader.add_constructor("!" + _n, _tag(_n))


class Resolver:
    def __init__(self, tpl, params):
        self.tpl = tpl
        self.params = params
        self.pseudo = {"AWS::AccountId": ACCT, "AWS::Region": REGION, "AWS::Partition": "aws", "AWS::NoValue": None}
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
            if k == "Fn::Or":
                return any(self.r(v))
            if k == "Fn::And":
                return all(self.r(v))
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


ZONE = "Z0ASSESSEXAMPLE"
OTHERZONE = "Z0MAINEXAMPLE"


def load(use_ecr="true", existing="", assess=ZONE):
    with open(TEMPLATE) as fh:
        raw = yaml.load(fh, Loader)
    params = {
        "GitHubOwner": "example-owner",
        "GitHubRepo": "example-repo",
        "ExistingOidcProviderArn": existing,
        "UseEcr": use_ecr,
        "AssessHostedZoneId": assess,
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


NEGATED = {"StringNotEquals", "StringNotLike", "ArnNotEquals", "ArnNotLike", "NumericNotEquals"}


def one(base, cv, v):
    v = str(v)
    cv = str(cv)
    if base in ("StringEquals", "StringNotEquals"):
        return cv == v
    if base in ("StringLike", "StringNotLike", "ArnLike", "ArnNotLike", "ArnEquals", "ArnNotEquals"):
        return glob(v, cv)
    if base.startswith("Numeric"):
        a, b = float(cv), float(v)
        return {"NumericLessThan": a < b, "NumericLessThanEquals": a <= b, "NumericGreaterThan": a > b,
                "NumericGreaterThanEquals": a >= b, "NumericEquals": a == b, "NumericNotEquals": a != b}[base]
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


def trust_decision(doc, token, federated=OIDC_ARN):
    ctx = {k.lower(): v for k, v in token.items()}
    for st in aslist(doc["Statement"]):
        if st["Effect"] == "Allow" and stmt_matches(
                st, "sts:AssumeRoleWithWebIdentity", "*", ctx, "", federated=federated) \
                and st["Action"] == "sts:AssumeRoleWithWebIdentity":
            return "ALLOW"
    return "DENY"


# ---------------------------------------------------------------- build the world
A = ACCT
TF_REL = f"arn:aws:s3:::codeproctor-pilot-releases-{A}"
DEPLOY = f"arn:aws:iam::{A}:role/codeproctor-guardrails/codeproctor-pilot-deploy"
FOREIGN = {"aws:ResourceAccount": "999999999999"}
ZARN = lambda z: f"arn:aws:route53:::hostedzone/{z}"


def arn(svc, rest, region=REGION, acct=A):
    return f"arn:aws:{svc}:{region}:{acct}:{rest}"


def cases():
    c = []

    def add(n, act, res, ctx, exp):
        c.append((n, act, res, ctx or {}, exp))

    # --- the two allowed things
    for pfx in ("main", "judge0"):
        add(f"Releases: put manifest under {pfx}/", "s3:PutObject", f"{TF_REL}/{pfx}/manifest-000123.json", {}, "ALLOW")
    add("Releases: put signature bundle under main/", "s3:PutObject", f"{TF_REL}/main/manifest-000123.json.sigstore", {}, "ALLOW")
    add("Releases: put under a third prefix", "s3:PutObject", f"{TF_REL}/other/manifest.json", {}, "DENY")
    add("Releases: put at the bucket root", "s3:PutObject", f"{TF_REL}/manifest.json", {}, "DENY")
    add("Releases: put into another bucket", "s3:PutObject", "arn:aws:s3:::codeproctor-pilot-media-111111111111/main/x", {}, "DENY")
    add("Releases: put, bucket in another account", "s3:PutObject", f"{TF_REL}/main/x", FOREIGN, "DENY")
    add("Releases: read a manifest", "s3:GetObject", f"{TF_REL}/main/manifest-000123.json", {}, "DENY")
    add("Releases: delete a manifest", "s3:DeleteObject", f"{TF_REL}/main/manifest-000123.json", {}, "DENY")
    add("Releases: delete a manifest version", "s3:DeleteObjectVersion", f"{TF_REL}/judge0/manifest-000123.json", {}, "DENY")
    add("Releases: put object ACL", "s3:PutObjectAcl", f"{TF_REL}/main/manifest-000123.json", {}, "DENY")
    add("Releases: list the bucket", "s3:ListBucket", TF_REL, {}, "DENY")
    add("Releases: change the bucket policy", "s3:PutBucketPolicy", TF_REL, {}, "DENY")
    add("Releases: read the bucket policy", "s3:GetBucketPolicy", TF_REL, {}, "DENY")
    add("Releases: change lifecycle", "s3:PutLifecycleConfiguration", TF_REL, {}, "DENY")
    add("Releases: tag a manifest", "s3:PutObjectTagging", f"{TF_REL}/main/manifest-000123.json", {}, "DENY")
    ecr = arn("ecr", "repository/codeproctor-pilot-api")
    add("ECR: get authorization token", "ecr:GetAuthorizationToken", "*", {}, "ALLOW")
    for act in ("BatchCheckLayerAvailability", "InitiateLayerUpload", "UploadLayerPart", "CompleteLayerUpload", "PutImage"):
        add(f"ECR: {act} on codeproctor-pilot-api", "ecr:" + act, ecr, {}, "ALLOW")
    add("ECR: push to a repository outside the prefix", "ecr:PutImage", arn("ecr", "repository/other-app"), {}, "DENY")
    add("ECR: push to a repository codeproctor-staging-api", "ecr:PutImage", arn("ecr", "repository/codeproctor-staging-api"), {}, "DENY")
    for act in ("CreateRepository", "DeleteRepository", "SetRepositoryPolicy", "PutLifecyclePolicy", "BatchDeleteImage", "PutImageTagMutability"):
        add(f"ECR: {act}", "ecr:" + act, ecr, {}, "DENY")
    # --- data buckets: untouchable
    for n in ("media", "backup"):
        b = f"arn:aws:s3:::codeproctor-pilot-{n}-{A}"
        add(f"{n} bucket: read an object", "s3:GetObject", b + "/orgs/o/x", {}, "DENY")
        add(f"{n} bucket: write an object", "s3:PutObject", b + "/orgs/o/x", {}, "DENY")
        add(f"{n} bucket: delete an object", "s3:DeleteObject", b + "/orgs/o/x", {}, "DENY")
        add(f"{n} bucket: list", "s3:ListBucket", b, {}, "DENY")
        add(f"{n} bucket: list versions", "s3:ListBucketVersions", b, {}, "DENY")
        for act in ("PutBucketPolicy", "DeleteBucketPolicy", "PutBucketAcl", "PutBucketPublicAccessBlock", "PutBucketOwnershipControls", "PutBucketVersioning", "PutLifecycleConfiguration", "PutEncryptionConfiguration", "PutBucketCors", "DeleteBucket", "PutInventoryConfiguration", "PutAnalyticsConfiguration"):
            add(f"{n} bucket: {act}", "s3:" + act, b, {}, "DENY")
    add("S3: create a bucket", "s3:CreateBucket", "arn:aws:s3:::codeproctor-pilot-x", {"aws:RequestTag/Environment": "pilot"}, "DENY")
    add("S3: create an access point", "s3:CreateAccessPoint", arn("s3", "accesspoint/x"), {}, "DENY")
    add("S3: account public access block", "s3:PutAccountPublicAccessBlock", "*", {}, "DENY")
    add("S3: list all buckets", "s3:ListAllMyBuckets", "*", {}, "DENY")
    # --- everything that is not CI's job
    add("KMS: decrypt with the data key", "kms:Decrypt", arn("kms", "key/k1"), {"aws:ResourceTag/Environment": "pilot", "aws:ResourceTag/Purpose": "data"}, "DENY")
    add("KMS: create a key", "kms:CreateKey", "*", {}, "DENY")
    add("KMS: put key policy", "kms:PutKeyPolicy", arn("kms", "key/k1"), {}, "DENY")
    add("KMS: create grant", "kms:CreateGrant", arn("kms", "key/k1"), {}, "DENY")
    add("KMS: schedule key deletion", "kms:ScheduleKeyDeletion", arn("kms", "key/k1"), {}, "DENY")
    add("Secrets: get a value", "secretsmanager:GetSecretValue", arn("secretsmanager", "secret:codeproctor-pilot-x-AbCdEf"), {}, "DENY")
    add("Secrets: create a secret", "secretsmanager:CreateSecret", arn("secretsmanager", "secret:codeproctor-pilot-x"), {"aws:RequestTag/Environment": "pilot"}, "DENY")
    add("SSM: get a parameter", "ssm:GetParameter", arn("ssm", "parameter/codeproctor/pilot/x"), {}, "DENY")
    add("SSM: start a session", "ssm:StartSession", arn("ec2", "instance/i-1"), {}, "DENY")
    add("SSM: send a command", "ssm:SendCommand", arn("ec2", "instance/i-1"), {}, "DENY")
    add("Logs: read events", "logs:GetLogEvents", arn("logs", "log-group:/codeproctor/pilot/api:log-stream:s"), {}, "DENY")
    add("Logs: create a log group", "logs:CreateLogGroup", arn("logs", "log-group:codeproctor-pilot-x"), {}, "DENY")
    add("Alarms: put a metric alarm", "cloudwatch:PutMetricAlarm", arn("cloudwatch", "alarm:codeproctor-pilot-x"), {}, "DENY")
    add("SES: send an email", "ses:SendEmail", arn("ses", "identity/example.org"), {}, "DENY")
    add("SES: create an identity", "ses:CreateEmailIdentity", arn("ses", "identity/example.org"), {}, "DENY")
    add("Budgets: modify a budget", "budgets:ModifyBudget", f"arn:aws:budgets::{A}:budget/codeproctor-pilot-m", {}, "DENY")
    add("SNS: publish", "sns:Publish", arn("sns", "codeproctor-pilot-alerts"), {}, "DENY")
    add("Events: put a rule", "events:PutRule", arn("events", "rule/codeproctor-pilot-x"), {}, "DENY")
    for act, res in (("RunInstances", arn("ec2", "instance/i-0abc")), ("StartInstances", arn("ec2", "instance/i-1")), ("StopInstances", arn("ec2", "instance/i-1")), ("TerminateInstances", arn("ec2", "instance/i-1")),
                     ("ModifyInstanceAttribute", arn("ec2", "instance/i-1")), ("AttachVolume", arn("ec2", "volume/vol-1")), ("DeleteVolume", arn("ec2", "volume/vol-1")),
                     ("AuthorizeSecurityGroupIngress", arn("ec2", "security-group/sg-1")), ("AllocateAddress", arn("ec2", "elastic-ip/*")), ("CreateNatGateway", arn("ec2", "natgateway/n")),
                     ("ImportKeyPair", arn("ec2", "key-pair/k")), ("CreateVpcPeeringConnection", "*"), ("CreateTransitGateway", "*"), ("AssociateIamInstanceProfile", arn("ec2", "instance/i-1"))):
        add(f"EC2: {act}", "ec2:" + act, res, {"aws:ResourceTag/Environment": "pilot"}, "DENY")
    add("EC2: describe instances", "ec2:DescribeInstances", "*", {}, "DENY")
    for act, res in (("CreateSchedule", arn("scheduler", "schedule/codeproctor-pilot-slots/start")), ("DeleteSchedule", arn("scheduler", "schedule/codeproctor-pilot-slots/start")), ("CreateScheduleGroup", arn("scheduler", "schedule-group/codeproctor-pilot-slots"))):
        add(f"Scheduler: {act}", "scheduler:" + act, res, {}, "DENY")
    iam_arns = {
        "CreateRole": arn("iam", "role/codeproctor-pilot-app", "", A), "PassRole": arn("iam", "role/codeproctor-pilot-scheduler-start", "", A),
        "UpdateAssumeRolePolicy": DEPLOY, "AttachRolePolicy": arn("iam", "role/codeproctor-pilot-app", "", A), "PutRolePolicy": DEPLOY,
        "CreatePolicy": arn("iam", "policy/codeproctor-pilot-x", "", A), "CreateUser": arn("iam", "user/x", "", A), "CreateAccessKey": arn("iam", "user/x", "", A),
        "CreateLoginProfile": arn("iam", "user/x", "", A), "CreateOpenIDConnectProvider": arn("iam", "oidc-provider/evil.example", "", A),
        "UpdateOpenIDConnectProviderThumbprint": OIDC_ARN, "CreateSAMLProvider": arn("iam", "saml-provider/x", "", A),
        "DeleteRole": DEPLOY, "CreateServiceLinkedRole": arn("iam", "role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS", "", A),
        "PutRolePermissionsBoundary": DEPLOY, "GetRole": DEPLOY, "ListRoles": "*",
    }
    for act, res in iam_arns.items():
        add(f"IAM: {act}", "iam:" + act, res, {"iam:PassedToService": "ec2.amazonaws.com", "aws:ResourceTag/Environment": "pilot"}, "DENY")
    add("STS: assume another role", "sts:AssumeRole", arn("iam", "role/OrganizationAccountAccessRole", "", A), {}, "DENY")
    for act in ("rds:CreateDBInstance", "elasticloadbalancing:CreateLoadBalancer", "lambda:CreateFunction", "ecs:RunTask", "cloudformation:CreateStack", "codebuild:StartBuild", "sagemaker:CreateNotebookInstance"):
        add(f"Denied service: {act}", act, "*", {}, "DENY")
    # tags
    add("Tag guard: request tags Environment=staging on ECR push", "ecr:PutImage", ecr, {"aws:RequestTag/Environment": "staging"}, "DENY")
    add("Tag guard: release put, resource tagged Environment=staging", "s3:PutObject", f"{TF_REL}/main/x", {"aws:ResourceTag/Environment": "staging"}, "DENY")
    add("Tag guard: ECR push, repository tagged pilot", "ecr:PutImage", ecr, {"aws:ResourceTag/Environment": "pilot"}, "ALLOW")
    # route 53
    add("Route53: change records in another hosted zone", "route53:ChangeResourceRecordSets", ZARN(OTHERZONE), {}, "DENY")
    add("Route53: list hosted zones", "route53:ListHostedZones", "*", {}, "DENY")
    add("Route53: create hosted zone", "route53:CreateHostedZone", "*", {}, "DENY")
    add("Route53: delete another hosted zone", "route53:DeleteHostedZone", ZARN(OTHERZONE), {}, "DENY")
    add("Route53: associate VPC with another hosted zone", "route53:AssociateVPCWithHostedZone", ZARN(OTHERZONE), {}, "DENY")
    add("Route53: get change", "route53:GetChange", "arn:aws:route53:::change/C123", {}, "DENY")
    add("Route53: list hosted zones by name", "route53:ListHostedZonesByName", "*", {}, "DENY")
    add("Route53: change records in the assess zone (no allow: implicit)", "route53:ChangeResourceRecordSets", ZARN(ZONE), {}, "DENY-IMPLICIT")
    add("Route53: delete the assess zone (no allow: implicit)", "route53:DeleteHostedZone", ZARN(ZONE), {}, "DENY-IMPLICIT")
    add("Route53: domains transfer", "route53domains:TransferDomain", "*", {}, "DENY")
    return c


def trust_cases():
    def tok(sub, aud="sts.amazonaws.com"):
        return {"token.actions.githubusercontent.com:sub": sub, "token.actions.githubusercontent.com:aud": aud}
    R = "repo:example-owner/example-repo"
    return [
        ("Trust: environment:pilot", tok(R + ":environment:pilot"), "ALLOW"),
        ("Trust: environment:staging", tok(R + ":environment:staging"), "DENY"),
        ("Trust: environment:pilot-evil", tok(R + ":environment:pilot-evil"), "DENY"),
        ("Trust: another repo", tok("repo:example-owner/other-repo:environment:pilot"), "DENY"),
        ("Trust: repo with the same prefix", tok("repo:example-owner/example-repo-evil:environment:pilot"), "DENY"),
        ("Trust: another owner", tok("repo:evil-owner/example-repo:environment:pilot"), "DENY"),
        ("Trust: branch ref", tok(R + ":ref:refs/heads/main"), "DENY"),
        ("Trust: pull_request", tok(R + ":pull_request"), "DENY"),
        ("Trust: wrong audience", tok(R + ":environment:pilot", "sts.evil.example"), "DENY"),
        ("Trust: missing audience", {"token.actions.githubusercontent.com:sub": R + ":environment:pilot"}, "DENY"),
    ]


def main():
    fails = []
    raw, res = load("true")
    pols = {k: v["Properties"] for k, v in res.items() if v["Type"] == "AWS::IAM::ManagedPolicy"}
    by_role = {}
    for k, p in pols.items():
        for r in p.get("Roles", []):
            by_role.setdefault(r.replace("ref:", ""), []).append(p["PolicyDocument"])
    with open(TEMPLATE) as fh:
        text = fh.read()
    checks = []
    checks.append(("no 12-digit account id or access key in template", not re.search(r"(?<![\w{])\d{12}(?![\w}])", text.replace("{12}", "")) and not re.search(r"AKIA[0-9A-Z]{16}", text)))
    for k, p in pols.items():
        size = len(re.sub(r"\s", "", json.dumps(p["PolicyDocument"])))
        checks.append((f"managed policy {k} under 6144 chars ({size})", size < 6144))
    checks.append(("only one role (the deploy role): no instance, scheduler or plan role, no boundary", [v["Properties"]["RoleName"] for v in res.values() if v["Type"] == "AWS::IAM::Role"] == ["codeproctor-pilot-deploy"] and not any("Boundary" in k or "Plan" in k for k in res)))
    checks.append(("no state bucket, key, alias or bucket in this template", not any(v["Type"] in ("AWS::S3::Bucket", "AWS::KMS::Key", "AWS::KMS::Alias") for v in res.values())))
    checks.append(("deploy role has release and guard policies (+ ECR when UseEcr)", len(by_role["PilotDeployRole"]) == 3))
    _, res_noecr = load("false")
    checks.append(("UseEcr=false: no ECR policy, role keeps release and guard", not any("Ecr" in k for k in res_noecr)))
    checks.append(("all policies under /codeproctor-guardrails/ (except the unattached SSM policy)", all(p.get("Path") == "/codeproctor-guardrails/" for k, p in pols.items() if k != "PilotInstanceSsmPolicy")))
    checks.append(("no inline policies on roles", all("Policies" not in v["Properties"] for v in res.values() if v["Type"] == "AWS::IAM::Role")))
    allow_actions = sorted({a.lower() for p in by_role["PilotDeployRole"] for st in p["Statement"] if st["Effect"] == "Allow" for a in aslist(st["Action"])})
    checks.append(("the only Allow actions are the manifest put and the ECR push set", set(allow_actions) == {"s3:putobject", "ecr:getauthorizationtoken", "ecr:batchchecklayeravailability", "ecr:initiatelayerupload", "ecr:uploadlayerpart", "ecr:completelayerupload", "ecr:putimage", "ecr:batchgetimage", "ecr:describeimages"}))
    ssm = pols["PilotInstanceSsmPolicy"]["PolicyDocument"]["Statement"][0]
    checks.append(("SSM instance policy: registration and Session Manager channels only", sorted(a.lower() for a in ssm["Action"]) == ["ssm:updateinstanceinformation", "ssmmessages:createcontrolchannel", "ssmmessages:createdatachannel", "ssmmessages:opencontrolchannel", "ssmmessages:opendatachannel"]))
    _, res_ex = load("true", OIDC_ARN)
    checks.append(("ExistingOidcProviderArn set: provider not created, trust names the existing ARN", "GitHubOidcProvider" not in res_ex and res_ex["PilotDeployRole"]["Properties"]["AssumeRolePolicyDocument"]["Statement"][0]["Principal"]["Federated"] == OIDC_ARN))
    _, res_z = load("true", "", "")
    nz = [st for st in res_z["PilotDeployGuardPolicy"]["Properties"]["PolicyDocument"]["Statement"] if st["Sid"] == "DenyRoute53OutsideAssessZone"][0]
    checks.append(("AssessHostedZoneId empty: no hosted zone is permitted", nz["NotResource"] == ["arn:aws:route53:::hostedzone/"]))
    checks.append(("no Cloudflare mention", "cloudflare" not in text.lower()))
    print("Structural checks")
    for n, ok in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
        if not ok:
            fails.append(n)
    ident = by_role["PilotDeployRole"]
    rows = []
    for (n, act, rsrc, ctx, exp) in cases():
        ctx = dict(ctx)
        dflt = []
        if act.startswith("s3:") and "aws:ResourceAccount" not in ctx:
            ctx["aws:ResourceAccount"] = ACCT
            dflt.append("aws:ResourceAccount")
        got, why = evaluate(ident, None, [], DEPLOY, act, rsrc, ctx)
        ok = (exp == got) or (exp == "DENY-IMPLICIT" and got == "DENY" and why == "implicit deny")
        keys = ",".join(sorted(k for k in ctx if k not in dflt)) + (" *" + ",".join(dflt) if dflt else "")
        rows.append((n, act, exp, got if not ok else exp, ok, why, keys))
    good = {"token.actions.githubusercontent.com:sub": "repo:example-owner/example-repo:environment:pilot", "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"}
    doc = res["PilotDeployRole"]["Properties"]["AssumeRolePolicyDocument"]
    for (n, token, exp) in trust_cases():
        got = trust_decision(doc, token)
        rows.append((n, "sts:AssumeRoleWithWebIdentity", exp, got, got == exp, "trust policy", ",".join(sorted(token))))
    rows.append(("Trust: valid claims from a different OIDC provider", "sts:AssumeRoleWithWebIdentity", "DENY", trust_decision(doc, good, "arn:aws:iam::111111111111:oidc-provider/evil.example"), True, "trust policy", "sub,aud"))
    rows[-1] = rows[-1][:3] + (trust_decision(doc, good, "arn:aws:iam::111111111111:oidc-provider/evil.example"),) + (trust_decision(doc, good, "arn:aws:iam::111111111111:oidc-provider/evil.example") == "DENY",) + rows[-1][5:]
    doc_ex = res_ex["PilotDeployRole"]["Properties"]["AssumeRolePolicyDocument"]
    got = trust_decision(doc_ex, good, OIDC_ARN)
    rows.append(("Trust: valid claims, existing provider ARN path", "sts:AssumeRoleWithWebIdentity", "ALLOW", got, got == "ALLOW", "trust policy", "sub,aud"))
    w = max(len(r[0]) for r in rows)
    print("\n%-*s  %-6s %-6s %-8s %s" % (w, "case", "expect", "got", "result", "keys (hand-supplied; * = harness default)"))
    npass = 0
    for (n, act, exp, got, ok, why, keys) in rows:
        npass += ok
        if not ok:
            fails.append(n)
        print("%-*s  %-6s %-6s %-8s %s%s" % (w, n, exp, got, "ok" if ok else "MISMATCH", keys, "" if ok else " (" + why + ")"))
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
