#!/usr/bin/env python3
"""Offline test for infra/aws/pilot-data-buckets.yaml (DEP-01 PR 1b).

Checks the owner-applied data template (buckets, lifecycle, key) and proves that the REAL policies
of the PR 1 deploy role (github-oidc-roles.yaml) cannot read or change any of it. It reuses the IAM
evaluator of test_isolation.py and approximates IAM; simulate-principal-policy.sh is the
authoritative check after deployment.

TC IDs: QA to allocate (docs/test-cases.md has no DEP section).
Context keys: each case lists the keys the author supplies by hand (column "keys"); * marks keys the
harness defaults (aws:ResourceAccount for S3 actions).

Run: python3 infra/aws/tests/test_data_buckets.py   (needs PyYAML). Exit code is non-zero on any mismatch.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_isolation as T  # noqa: E402

DATA_TEMPLATE = os.path.join(HERE, "..", "pilot-data-buckets.yaml")
A = T.ACCT
BUCKETS = {n: f"arn:aws:s3:::codeproctor-pilot-{n}-{A}" for n in ("media", "results", "consent", "backup")}
KEYARN = f"arn:aws:kms:{T.REGION}:{A}:key/data-key-id"
ALIAS = f"arn:aws:kms:{T.REGION}:{A}:alias/codeproctor-pilot-data"
APP = f"arn:aws:iam::{A}:role/codeproctor-pilot-app"
KT = {"aws:ResourceTag/Environment": "pilot", "aws:ResourceTag/Purpose": "data"}
VIA_S3 = {"kms:ViaService": f"s3.{T.REGION}.amazonaws.com"}


def load_data(separate="false", **over):
    with open(DATA_TEMPLATE) as fh:
        raw = T.yaml.load(fh, T.Loader)
    params = {"InstanceRoleName": "codeproctor-pilot-app", "SeparateBucketsInUse": separate,
              "MediaExpiryDays": 90, "ResultsExpiryDays": 365, "ConsentExpiryDays": 1095,
              "BackupRetentionDays": 14, "WalRetentionDays": 14}
    params.update(over)
    rs = T.Resolver(raw, params)
    return raw, {k: rs.r(v) for k, v in raw["Resources"].items()}


def rules_of(res, name):
    return {r["Id"]: r for r in res[name]["Properties"]["LifecycleConfiguration"]["Rules"]}


def main():
    raw, res = load_data("false")
    _, res_on = load_data("true")
    _, res1 = T.load("true", "true")
    pols, by_role, boundary, sched, _bp, _kp = T.build(res1)
    checks = []

    def chk(name, ok):
        checks.append((name, bool(ok)))

    text = open(DATA_TEMPLATE).read()
    chk("no 12-digit account id or access key in template", not re.search(r"(?<![\w{])\d{12}(?![\w}])", text) and not re.search(r"AKIA[0-9A-Z]{16}", text))
    for n, lg in (("media", "MediaBucket"), ("results", "ResultsBucket"), ("consent", "ConsentBucket"), ("backup", "BackupBucket")):
        p = res[lg]["Properties"]
        chk(f"{n}: name is codeproctor-pilot-{n}-<account id>", p["BucketName"] == f"codeproctor-pilot-{n}-{A}")
        chk(f"{n}: all four Block Public Access flags", all(p["PublicAccessBlockConfiguration"].values()) and len(p["PublicAccessBlockConfiguration"]) == 4)
        enc = p["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]
        chk(f"{n}: SSE-KMS with Bucket Key", enc["ServerSideEncryptionByDefault"]["SSEAlgorithm"] == "aws:kms" and enc["BucketKeyEnabled"] is True)
        chk(f"{n}: versioning never enabled (ADR 0004 9.2)", "VersioningConfiguration" not in p)
        chk(f"{n}: Retain on delete and replace", res[lg]["DeletionPolicy"] == "Retain" and res[lg]["UpdateReplacePolicy"] == "Retain")
        chk(f"{n}: abort incomplete multipart enabled", rules_of(res, lg)["abort-incomplete-multipart"]["Status"] == "Enabled")
        chk(f"{n}: tagged Environment=pilot", {"Key": "Environment", "Value": "pilot"} in p["Tags"])
        sids = {s["Sid"] for s in res[lg.replace("Bucket", "BucketPolicy")]["Properties"]["PolicyDocument"]["Statement"]}
        chk(f"{n}: bucket policy denies insecure transport", "DenyInsecureTransport" in sids)
    chk("media expiry 90 days, disabled until separate buckets are in use", rules_of(res, "MediaBucket")["expire-media"]["ExpirationInDays"] == 90 and rules_of(res, "MediaBucket")["expire-media"]["Status"] == "Disabled")
    chk("media expiry enabled when SeparateBucketsInUse=true", rules_of(res_on, "MediaBucket")["expire-media"]["Status"] == "Enabled")
    chk("results expiry 365 days (R-10)", rules_of(res_on, "ResultsBucket")["expire-results"]["ExpirationInDays"] == 365 and rules_of(res, "ResultsBucket")["expire-results"]["Status"] == "Disabled")
    chk("consent expiry 1095 days (R-9)", rules_of(res_on, "ConsentBucket")["expire-consent"]["ExpirationInDays"] == 1095 and rules_of(res_on, "ConsentBucket")["expire-consent"]["Status"] == "Enabled")
    bk = rules_of(res, "BackupBucket")
    chk("backups: dumps 14 days under db/dumps/ (backup.sh layout), always enabled", bk["expire-dumps"]["ExpirationInDays"] == 14 and bk["expire-dumps"]["Prefix"] == "db/dumps/" and bk["expire-dumps"]["Status"] == "Enabled")
    chk("backups: WAL 14 days under db/wal/ (flagged parameter)", bk["expire-wal"]["ExpirationInDays"] == 14 and bk["expire-wal"]["Prefix"] == "db/wal/")
    key = res["PilotDataKey"]["Properties"]
    tags = {t["Key"]: t["Value"] for t in key["Tags"]}
    chk("key: rotation on, tagged Environment=pilot and Purpose=data (what the PR 1 denies expect)", key["EnableKeyRotation"] is True and tags == {"Environment": "pilot", "ManagedBy": "codeproctor-pilot-data-buckets", "Purpose": "data"})
    chk("key alias is alias/codeproctor-pilot-data", res["PilotDataKeyAlias"]["Properties"]["AliasName"] == "alias/codeproctor-pilot-data")
    chk("key policy gives the instance role only Decrypt, GenerateDataKey and DescribeKey", all(set(a.lower() for a in s["Action"]) <= {"kms:decrypt", "kms:generatedatakey*", "kms:describekey"} for s in key["KeyPolicy"]["Statement"] if s["Sid"] == "InstanceRoleUseThroughS3"))
    chk("all four buckets use the one key", all(res[b]["Properties"]["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]["ServerSideEncryptionByDefault"]["KMSMasterKeyID"] == "getatt:PilotDataKey.Arn" for b in ("MediaBucket", "ResultsBucket", "ConsentBucket", "BackupBucket")))
    chk("only one KMS key in the template", sum(1 for v in res.values() if v["Type"] == "AWS::KMS::Key") == 1)
    chk("no DataKeyType parameter (CMK is mandatory)", "DataKeyType" not in raw["Parameters"])

    allow_all = [{"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}]
    world = {
        "deploy": (by_role["PilotDeployRole"], None, T.DEPLOY),
        "ci-admin": (allow_all, None, f"arn:aws:iam::{A}:role/codeproctor-guardrails/codeproctor-pilot-deploy"),
        "scheduler": (allow_all, sched, T.SCHED),
        "app": (allow_all, boundary, APP),
        "owner": (allow_all, None, T.OWNER),
    }
    rows = []

    def add(name, pr, act, rsrc, ctx, exp, bucket=None, key_pol=False):
        ctx = dict(ctx)
        dflt = []
        if act.startswith("s3:") and "aws:ResourceAccount" not in ctx:
            ctx["aws:ResourceAccount"] = A
            dflt.append("aws:ResourceAccount")
        ident, bnd, parn = world[pr]
        rps = []
        if bucket:
            rps.append(res[bucket.capitalize() + "BucketPolicy"]["Properties"]["PolicyDocument"])
        if key_pol:
            rps.append(key["KeyPolicy"])
        got, why = T.evaluate(ident, bnd, rps, parn, act, rsrc, ctx)
        keys = ",".join(sorted(k for k in ctx if k not in dflt)) + (" *" + ",".join(dflt) if dflt else "")
        rows.append((name, pr, act, exp, got, why, keys))

    for n, b in BUCKETS.items():
        o = b + "/orgs/o1/sessions/s1/object"
        for act in ("CreateBucket", "PutBucketPolicy", "DeleteBucketPolicy", "PutBucketAcl", "PutBucketPublicAccessBlock", "PutBucketOwnershipControls", "PutBucketVersioning", "PutLifecycleConfiguration", "PutEncryptionConfiguration", "DeleteBucket"):
            add(f"CI cannot {act} on {n} bucket", "deploy", "s3:" + act, b, {}, "DENY", n)
        for act in ("GetObject", "PutObject", "DeleteObject"):
            add(f"CI cannot {act} on {n} bucket", "deploy", "s3:" + act, o, {}, "DENY", n)
        for act in ("GetBucketPolicy", "GetLifecycleConfiguration", "GetEncryptionConfiguration", "ListBucket"):
            add(f"CI can still {act} on {n} bucket (read-only)", "deploy", "s3:" + act, b, {}, "ALLOW", n)
        add(f"another codeproctor role with admin identity cannot read {n} objects", "ci-admin", "s3:GetObject", o, {}, "DENY", n)
        add(f"another codeproctor role with admin identity cannot change {n} bucket policy", "ci-admin", "s3:PutBucketPolicy", b, {}, "DENY", n)
        add(f"scheduler role cannot read {n} objects", "scheduler", "s3:GetObject", o, T.SRC, "DENY", n)
        add(f"instance role reads {n} object with source instance", "app", "s3:GetObject", o, T.SRC, "ALLOW", n)
        add(f"instance role writes {n} object (SSE-KMS)", "app", "s3:PutObject", o, {**T.SRC, "s3:x-amz-server-side-encryption": "aws:kms"}, "ALLOW", n)
        add(f"instance role writes {n} object with AES256", "app", "s3:PutObject", o, {**T.SRC, "s3:x-amz-server-side-encryption": "AES256"}, "DENY", n)
        add(f"instance role reads {n} object over plain HTTP", "app", "s3:GetObject", o, {**T.SRC, "aws:SecureTransport": "false"}, "DENY", n)
        add(f"instance role reads {n} object without source instance", "app", "s3:GetObject", o, {}, "DENY", n)
        add(f"instance role cannot change {n} bucket policy", "app", "s3:PutBucketPolicy", b, T.SRC, "DENY", n)
        add(f"owner (human admin) can change {n} bucket policy", "owner", "s3:PutBucketPolicy", b, {}, "ALLOW", n)
    for act, ctx in (("kms:PutKeyPolicy", {}), ("kms:ScheduleKeyDeletion", {"kms:ScheduleKeyDeletionPendingWindowInDays": "30"}), ("kms:DisableKey", {}), ("kms:EnableKey", {}), ("kms:DisableKeyRotation", {}),
                     ("kms:CreateGrant", {"kms:GrantIsForAWSResource": "true"}), ("kms:Decrypt", VIA_S3), ("kms:GenerateDataKey", VIA_S3), ("kms:Encrypt", {}),
                     ("kms:TagResource", {"aws:TagKeys": ["Purpose"], "aws:RequestTag/Purpose": "tfstate"}), ("kms:UntagResource", {"aws:TagKeys": ["Purpose"]}), ("kms:UpdateKeyDescription", {})):
        add(f"CI cannot {act} on the data key", "deploy", act, KEYARN, {**KT, **ctx}, "DENY", key_pol=True)
    for act in ("kms:CreateAlias", "kms:UpdateAlias", "kms:DeleteAlias"):
        add(f"CI cannot {act} on alias/codeproctor-pilot-data", "deploy", act, ALIAS, {}, "DENY", key_pol=True)
    add("CI cannot create another key", "deploy", "kms:CreateKey", "*", {"aws:RequestTag/Environment": "pilot"}, "DENY")
    add("CI can read data key metadata", "deploy", "kms:DescribeKey", KEYARN, KT, "ALLOW", key_pol=True)
    add("another codeproctor role with admin identity cannot decrypt", "ci-admin", "kms:Decrypt", KEYARN, {**KT, **VIA_S3}, "DENY", key_pol=True)
    add("another codeproctor role with admin identity cannot PutKeyPolicy", "ci-admin", "kms:PutKeyPolicy", KEYARN, KT, "DENY", key_pol=True)
    add("scheduler role cannot decrypt", "scheduler", "kms:Decrypt", KEYARN, {**KT, **VIA_S3, **T.SRC}, "DENY", key_pol=True)
    add("instance role decrypts through S3", "app", "kms:Decrypt", KEYARN, {**KT, **VIA_S3, **T.SRC}, "ALLOW", key_pol=True)
    add("instance role generates a data key through S3", "app", "kms:GenerateDataKey", KEYARN, {**KT, **VIA_S3, **T.SRC}, "ALLOW", key_pol=True)
    add("instance role cannot decrypt outside S3", "app", "kms:Decrypt", KEYARN, {**KT, **T.SRC}, "DENY", key_pol=True)
    add("instance role cannot decrypt without source instance", "app", "kms:Decrypt", KEYARN, {**KT, **VIA_S3}, "DENY", key_pol=True)
    add("instance role cannot change the key policy", "app", "kms:PutKeyPolicy", KEYARN, {**KT, **T.SRC}, "DENY", key_pol=True)
    add("owner administers the key", "owner", "kms:PutKeyPolicy", KEYARN, KT, "ALLOW", key_pol=True)

    print("Structural checks")
    fails = []
    for n, ok in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
        if not ok:
            fails.append(n)
    w = max(len(r[0]) for r in rows)
    print("\n%-*s  %-9s  %-6s %-6s %-8s %s" % (w, "case", "principal", "expect", "got", "result", "keys (hand-supplied; * = harness default)"))
    npass = 0
    for (n, pr, act, exp, got, why, keys) in rows:
        ok = exp == got
        npass += ok
        if not ok:
            fails.append(n)
        print("%-*s  %-9s  %-6s %-6s %-8s %s%s" % (w, n, pr, exp, got, "ok" if ok else "MISMATCH", keys, "" if ok else " (" + why + ")"))
    print(f"\n{len(rows)} cases, {npass} pass, {len(rows) - npass} fail; {len(checks)} structural checks")
    if fails:
        print("FAILED:", *fails, sep="\n  ")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
