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
BUCKETS = {n: f"arn:aws:s3:::codeproctor-pilot-{n}-{A}" for n in ("media", "backup")}
KEYARN = f"arn:aws:kms:{T.REGION}:{A}:key/data-key-id"
KEYARN_VALUE = "getatt:PilotDataKey.Arn"  # the resolver returns this placeholder for the key ARN
ALIAS = f"arn:aws:kms:{T.REGION}:{A}:alias/codeproctor-pilot-data"
APP = f"arn:aws:iam::{A}:role/codeproctor-pilot-app"
KT = {"aws:ResourceTag/Environment": "pilot", "aws:ResourceTag/Purpose": "data"}
VIA_S3 = {"kms:ViaService": f"s3.{T.REGION}.amazonaws.com"}


def load_data(**over):
    with open(DATA_TEMPLATE) as fh:
        raw = T.yaml.load(fh, T.Loader)
    params = {"InstanceRoleName": "codeproctor-pilot-app", "AppOrigin": "https://app.example.test",
              "BackupRetentionDays": 13, "WalRetentionDays": 13}
    params.update(over)
    rs = T.Resolver(raw, params)
    return raw, {k: rs.r(v) for k, v in raw["Resources"].items()}


def rules_of(res, name):
    return {r["Id"]: r for r in res[name]["Properties"]["LifecycleConfiguration"]["Rules"]}


def main():
    raw, res = load_data()
    _, res1 = T.load("true", "true")
    pols, by_role, boundary, sched, _bp, _kp = T.build(res1)
    checks = []

    def chk(name, ok):
        checks.append((name, bool(ok)))

    text = open(DATA_TEMPLATE).read()
    chk("no 12-digit account id or access key in template", not re.search(r"(?<![\w{])\d{12}(?![\w}])", text) and not re.search(r"AKIA[0-9A-Z]{16}", text))
    for n, lg in (("media", "MediaBucket"), ("backup", "BackupBucket")):
        p = res[lg]["Properties"]
        chk(f"{n}: name is codeproctor-pilot-{n}-<account id>", p["BucketName"] == f"codeproctor-pilot-{n}-{A}")
        chk(f"{n}: all four Block Public Access flags", all(p["PublicAccessBlockConfiguration"].values()) and len(p["PublicAccessBlockConfiguration"]) == 4)
        enc = p["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]
        chk(f"{n}: SSE-KMS with Bucket Key", enc["ServerSideEncryptionByDefault"]["SSEAlgorithm"] == "aws:kms" and enc["BucketKeyEnabled"] is True)
        chk(f"{n}: versioning never enabled (ADR 0004 9.2)", "VersioningConfiguration" not in p)
        chk(f"{n}: Retain on delete and replace", res[lg]["DeletionPolicy"] == "Retain" and res[lg]["UpdateReplacePolicy"] == "Retain")
        chk(f"{n}: abort incomplete multipart enabled", rules_of(res, lg)["abort-incomplete-multipart"]["Status"] == "Enabled")
        chk(f"{n}: tagged Environment=pilot", {"Key": "Environment", "Value": "pilot"} in p["Tags"])
        sids = {st["Sid"] for st in res[lg.replace("Bucket", "BucketPolicy")]["Properties"]["PolicyDocument"]["Statement"]}
        chk(f"{n}: bucket policy denies insecure transport, other KMS keys and listing", {"DenyInsecureTransport", "DenyOtherKmsKey", "DenyKmsHeaderWithoutKeyId", "DenyListingExceptInstanceRole"} <= sids)
    chk("exactly two buckets (one media bucket, one backup bucket; DL-40)", sum(1 for v in res.values() if v["Type"] == "AWS::S3::Bucket") == 2)
    chk("no results, consent or SeparateBucketsInUse parameters", not {"ResultsExpiryDays", "ConsentExpiryDays", "MediaExpiryDays", "SeparateBucketsInUse"} & set(raw["Parameters"]))
    mr = rules_of(res, "MediaBucket")
    chk("media: only age rule is the tag-filtered 88 day face image expiry (margin under the 90 day cap)", [i for i in mr if i != "abort-incomplete-multipart"] == ["expire-face-images-88-days"] and mr["expire-face-images-88-days"]["ExpirationInDays"] == 88 and mr["expire-face-images-88-days"]["TagFilters"] == [{"Key": "RetentionClass", "Value": "face"}] and "Prefix" not in mr["expire-face-images-88-days"])
    bk = rules_of(res, "BackupBucket")
    chk("backups: dumps 13 days under db/dumps/ (backup.sh layout)", bk["expire-dumps"]["ExpirationInDays"] == 13 and bk["expire-dumps"]["Prefix"] == "db/dumps/")
    chk("backups: WAL under db/wal/ with its own parameter, default equal to dumps", bk["expire-wal"]["Prefix"] == "db/wal/" and raw["Parameters"]["WalRetentionDays"]["Default"] == raw["Parameters"]["BackupRetentionDays"]["Default"] == 13)
    chk("backups: retention parameters capped at 14 days", raw["Parameters"]["BackupRetentionDays"]["MaxValue"] == 14 and raw["Parameters"]["WalRetentionDays"]["MaxValue"] == 14)
    prefixes = [r.get("Prefix", "") for r in bk.values() if "ExpirationInDays" in r]
    chk("backups: db/erasure-list/ is not covered by any expiry rule", sorted(prefixes) == ["db/dumps/", "db/wal/"] and not any("db/erasure-list/".startswith(x) for x in prefixes))
    cors = res["MediaBucket"]["Properties"]["CorsConfiguration"]["CorsRules"][0]
    chk("media CORS: PUT, GET, HEAD from AppOrigin, headers incl. x-amz-tagging, no POST, exposes ETag", cors["AllowedMethods"] == ["PUT", "GET", "HEAD"] and cors["AllowedOrigins"] == ["https://app.example.test"] and cors["AllowedHeaders"] == ["Content-Type", "If-None-Match", "x-amz-tagging", "x-amz-checksum-crc32", "x-amz-sdk-checksum-algorithm"] and "POST" not in cors["AllowedMethods"] and cors["ExposedHeaders"] == ["ETag"])
    chk("backups: db/erasure-completed/ is not covered by any expiry rule", not any("db/erasure-completed/".startswith(x) for x in prefixes))
    chk("AppOrigin has no default", "Default" not in raw["Parameters"]["AppOrigin"])
    chk("backup bucket has no CORS", "CorsConfiguration" not in res["BackupBucket"]["Properties"])
    key = res["PilotDataKey"]["Properties"]
    tags = {t["Key"]: t["Value"] for t in key["Tags"]}
    chk("key: rotation on, tagged Environment=pilot and Purpose=data (what the PR 1 denies expect)", key["EnableKeyRotation"] is True and tags == {"Environment": "pilot", "ManagedBy": "codeproctor-pilot-data-buckets", "Purpose": "data"})
    chk("key alias is alias/codeproctor-pilot-data", res["PilotDataKeyAlias"]["Properties"]["AliasName"] == "alias/codeproctor-pilot-data")
    chk("key policy gives the instance role only Decrypt, GenerateDataKey and DescribeKey", all(set(a.lower() for a in s["Action"]) <= {"kms:decrypt", "kms:generatedatakey*", "kms:describekey"} for s in key["KeyPolicy"]["Statement"] if s["Sid"] == "InstanceRoleUseThroughS3"))
    chk("both buckets use the one key", all(res[b]["Properties"]["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]["ServerSideEncryptionByDefault"]["KMSMasterKeyID"] == "getatt:PilotDataKey.Arn" for b in ("MediaBucket", "BackupBucket")))
    chk("only one KMS key in the template", sum(1 for v in res.values() if v["Type"] == "AWS::KMS::Key") == 1)
    chk("no DataKeyType parameter (CMK is mandatory)", "DataKeyType" not in raw["Parameters"])

    allow_all = [{"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}]
    world = {
        "deploy": (by_role["PilotDeployRole"], None, T.DEPLOY),
        "ci-admin": (allow_all, None, f"arn:aws:iam::{A}:role/codeproctor-guardrails/codeproctor-pilot-deploy"),
        "scheduler": (allow_all, sched, T.SCHED),
        "plan": (allow_all, None, T.PLAN),
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
        for act in ("GetBucketPolicy", "GetLifecycleConfiguration", "GetEncryptionConfiguration", "GetBucketVersioning"):
            add(f"CI can still {act} on {n} bucket (read-only)", "deploy", "s3:" + act, b, {}, "ALLOW", n)
        for act in ("ListBucket", "ListBucketVersions", "ListBucketMultipartUploads"):
            add(f"CI cannot {act} on {n} bucket (candidate keys)", "deploy", "s3:" + act, b, {}, "DENY", n)
            add(f"another codeproctor role with admin identity cannot {act} on {n} bucket", "ci-admin", "s3:" + act, b, {}, "DENY", n)
            add(f"scheduler role cannot {act} on {n} bucket", "scheduler", "s3:" + act, b, T.SRC, "DENY", n)
            add(f"instance role {act} on {n} bucket (only ListBucket is in the boundary)", "app", "s3:" + act, b, T.SRC, "ALLOW" if act == "ListBucket" else "DENY", n)
        for act in ("GetBucketVersioning", "GetLifecycleConfiguration"):
            add(f"instance role can {act} on {n} bucket (RetentionService)", "app", "s3:" + act, b, T.SRC, "ALLOW", n)
        for act in ("PutInventoryConfiguration", "PutAnalyticsConfiguration", "PutBucketCors", "CreateAccessPoint", "PutAccessPointPolicy"):
            add(f"CI cannot {act} on {n} bucket", "deploy", "s3:" + act, b, {}, "DENY", n)
        add(f"instance role writes {n} object, SSE-KMS with the data key", "app", "s3:PutObject", o, {**T.SRC, "s3:x-amz-server-side-encryption": "aws:kms", "s3:x-amz-server-side-encryption-aws-kms-key-id": KEYARN_VALUE}, "ALLOW", n)
        add(f"instance role writes {n} object, SSE-KMS with aws/s3 key", "app", "s3:PutObject", o, {**T.SRC, "s3:x-amz-server-side-encryption": "aws:kms", "s3:x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:us-east-1:111111111111:key/aws-s3-default"}, "DENY", n)
        add(f"instance role writes {n} object with no encryption header (bucket default applies)", "app", "s3:PutObject", o, T.SRC, "ALLOW", n)
        add(f"plan role (if created) cannot read {n} objects", "plan", "s3:GetObject", o, {}, "DENY", n)
        add(f"another codeproctor role with admin identity cannot read {n} objects", "ci-admin", "s3:GetObject", o, {}, "DENY", n)
        add(f"another codeproctor role with admin identity cannot change {n} bucket policy", "ci-admin", "s3:PutBucketPolicy", b, {}, "DENY", n)
        add(f"scheduler role cannot read {n} objects", "scheduler", "s3:GetObject", o, T.SRC, "DENY", n)
        add(f"instance role reads {n} object with source instance", "app", "s3:GetObject", o, T.SRC, "ALLOW", n)
        add(f"instance role writes {n} object, aws:kms header without a key id (would use aws/s3)", "app", "s3:PutObject", o, {**T.SRC, "s3:x-amz-server-side-encryption": "aws:kms"}, "DENY", n)
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
    add("instance role decrypts through S3 without source instance (the S3 allows carry that requirement)", "app", "kms:Decrypt", KEYARN, {**KT, **VIA_S3}, "ALLOW", key_pol=True)
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
