#!/usr/bin/env python3
"""Offline test for infra/aws/pilot-data-buckets.yaml (DEP-01 PR 1b, ADR 0017 sections 3 and 5).

Checks the owner-applied data template (media, backup and releases buckets, the data key, the
backup expiry role, the alarms) and proves, with the REAL policies of the CI role from
github-oidc-roles.yaml, that CI can only put the two release manifests and cannot read, list or
change anything else. It also models the backup lifecycle (newest 3 dumps survive at any age,
Object Lock interplay) and checks that no role the instance or CI can reach can delete backup
versions or bypass Object Lock. Uses the IAM evaluator of test_isolation.py; it approximates IAM,
and simulate-principal-policy.sh is the authoritative check after deployment.

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
BK = {n: f"arn:aws:s3:::codeproctor-pilot-{n}-{A}" for n in ("media", "backup", "releases")}
KEYARN = f"arn:aws:kms:{T.REGION}:{A}:key/data-key-id"
ROLE = lambda n: f"arn:aws:iam::{A}:role/{n}"
APP, J0, RESTORE, EXPIRY = ROLE("codeproctor-pilot-app"), ROLE("codeproctor-pilot-judge0"), ROLE("codeproctor-pilot-restore"), ROLE("codeproctor-pilot-backup-expiry")
OWNER = f"arn:aws:iam::{A}:user/owner"
KT = {"aws:ResourceTag/Environment": "pilot", "aws:ResourceTag/Purpose": "data"}
VIA_S3 = {"kms:ViaService": f"s3.{T.REGION}.amazonaws.com"}
KEYID = "getatt:PilotDataKey.Arn"  # the resolver returns this placeholder for the key ARN


def load_data():
    with open(DATA_TEMPLATE) as fh:
        raw = T.yaml.load(fh, T.Loader)
    params = {"InstanceRoleName": "codeproctor-pilot-app", "Judge0RoleName": "codeproctor-pilot-judge0",
              "RestoreRoleName": "codeproctor-pilot-restore", "AppOrigin": "https://app.example.test",
              "DumpSizeChangeFactor": "3", "MaxDumpVersionsPerDay": "3", "MaxFullBaseBackupCountChange": "2", "AlarmTopicArn": ""}
    rs = T.Resolver(raw, params)
    return raw, {k: rs.r(v) for k, v in raw["Resources"].items()}


def rules_of(res, name):
    return {r["Id"]: r for r in res[name]["Properties"]["LifecycleConfiguration"]["Rules"]}


# ------------------------------------------------------------ offline model of the dump lifecycle
def surviving(ages, now, noncurrent_days, newer_noncurrent, lock_days):
    """ages: creation ages in days at time 0, newest first (ages[0] is the current version).
    Returns the indexes of versions still present at `now` days after time 0.
    A noncurrent version becomes eligible when it has been noncurrent for `noncurrent_days` (it becomes
    noncurrent when the next newer version lands) AND at least `newer_noncurrent` NONCURRENT versions are
    newer than it. Deletion of a locked version is deferred until the lock ends (not an error)."""
    alive = []
    for i, age in enumerate(ages):
        if i == 0:
            alive.append(i)  # the current version has no expiration
            continue
        noncurrent_since = ages[i - 1]  # age of the next newer version at time 0
        newer_nc = i - 1
        eligible_at = None
        if newer_nc >= newer_noncurrent:
            days_ok = noncurrent_days - noncurrent_since  # time at which noncurrent_days have passed
            # the count condition holds from the moment the N-th newer version became noncurrent
            count_ok = -ages[i - newer_noncurrent - 1] if newer_noncurrent else -1e9
            eligible_at = max(days_ok, count_ok)
        if eligible_at is None:
            alive.append(i)
            continue
        lock_end = (age - lock_days) * -1
        delete_at = max(eligible_at, lock_end)
        if now < delete_at:
            alive.append(i)
    return alive


def main():
    raw, res = load_data()
    _, res1 = T.load("true")
    ci_ident = [v["Properties"]["PolicyDocument"] for v in res1.values() if v["Type"] == "AWS::IAM::ManagedPolicy" and "Roles" in v["Properties"]]
    checks = []

    def chk(name, ok):
        checks.append((name, bool(ok)))

    text = open(DATA_TEMPLATE).read()
    chk("no 12-digit account id or access key in template", not re.search(r"(?<![\w{])\d{12}(?![\w}])", text.replace("{12}", "")) and not re.search(r"AKIA[0-9A-Z]{16}", text))
    buckets = {n: v for n, v in res.items() if v["Type"] == "AWS::S3::Bucket"}
    chk("exactly three buckets: media, backup, releases (ADR 0017 5.1)", sorted(buckets) == ["BackupBucket", "MediaBucket", "ReleasesBucket"])
    for n, lg in (("media", "MediaBucket"), ("backup", "BackupBucket"), ("releases", "ReleasesBucket")):
        p = res[lg]["Properties"]
        chk(f"{n}: name is codeproctor-pilot-{n}-<account id>", p["BucketName"] == f"codeproctor-pilot-{n}-{A}")
        chk(f"{n}: all four Block Public Access flags", all(p["PublicAccessBlockConfiguration"].values()) and len(p["PublicAccessBlockConfiguration"]) == 4)
        enc = p["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]
        want = "AES256" if n == "releases" else "aws:kms"
        chk(f"{n}: default encryption {want}", enc["ServerSideEncryptionByDefault"]["SSEAlgorithm"] == want and (n == "releases" or enc["BucketKeyEnabled"] is True))
        chk(f"{n}: Retain on delete and replace", res[lg]["DeletionPolicy"] == "Retain" and res[lg]["UpdateReplacePolicy"] == "Retain")
        sids = {st["Sid"] for st in res[lg.replace("Bucket", "BucketPolicy")]["Properties"]["PolicyDocument"]["Statement"]}
        chk(f"{n}: bucket policy is TLS-only and denies config changes from codeproctor roles", {"DenyInsecureTransport", "DenyConfigChangeFromCodeproctorRoles"} <= sids)
    chk("versioning ON for the backup bucket only (media and releases unversioned, ADR 0004 9.2)", res["BackupBucket"]["Properties"]["VersioningConfiguration"]["Status"] == "Enabled" and "VersioningConfiguration" not in res["MediaBucket"]["Properties"] and "VersioningConfiguration" not in res["ReleasesBucket"]["Properties"])
    bp = res["BackupBucket"]["Properties"]
    chk("backup bucket: Object Lock enabled at creation, GOVERNANCE, 12 days", bp["ObjectLockEnabled"] is True and bp["ObjectLockConfiguration"] == {"ObjectLockEnabled": "Enabled", "Rule": {"DefaultRetention": {"Mode": "GOVERNANCE", "Days": 12}}})
    chk("no other bucket has Object Lock", not any("ObjectLockEnabled" in res[b]["Properties"] for b in ("MediaBucket", "ReleasesBucket")))
    mr = rules_of(res, "MediaBucket")
    chk("media: only age rule is the tag-filtered 88 day face image expiry", [i for i in mr if i != "abort-incomplete-multipart"] == ["expire-face-images-88-days"] and mr["expire-face-images-88-days"]["ExpirationInDays"] == 88 and mr["expire-face-images-88-days"]["TagFilters"] == [{"Key": "RetentionClass", "Value": "face"}] and "Prefix" not in mr["expire-face-images-88-days"])
    br = rules_of(res, "BackupBucket")
    dump = br["keep-newest-dump-versions"]
    chk("backup: dump lifecycle is NewerNoncurrentVersions 2, NoncurrentDays 1, no current-version expiry", dump["Prefix"] == "db/dump/" and dump["NoncurrentVersionExpiration"] == {"NoncurrentDays": 1, "NewerNoncurrentVersions": 2} and "ExpirationInDays" not in dump and "Expiration" not in dump)
    chk("backup: NO lifecycle rule on db/wal/ (the expiry function owns the physical repository)", not any(r.get("Prefix", "").startswith("db/wal") for r in br.values()))
    chk("backup: NO age rule on db/erasure-list/ or db/erasure-completed/", not any(r.get("Prefix", "").startswith("db/erasure") for r in br.values()) and set(br) == {"abort-incomplete-multipart", "keep-newest-dump-versions"})
    chk("no rule anywhere has a current-version expiration on the backup bucket", all("ExpirationInDays" not in r for r in br.values()))
    cors = res["MediaBucket"]["Properties"]["CorsConfiguration"]["CorsRules"][0]
    chk("media CORS: PUT, GET, HEAD from AppOrigin, headers incl. x-amz-tagging, no POST, exposes ETag", cors["AllowedMethods"] == ["PUT", "GET", "HEAD"] and cors["AllowedOrigins"] == ["https://app.example.test"] and "x-amz-tagging" in cors["AllowedHeaders"] and "POST" not in cors["AllowedMethods"] and cors["ExposedHeaders"] == ["ETag"])
    chk("AppOrigin has no default; other buckets have no CORS", "Default" not in raw["Parameters"]["AppOrigin"] and "CorsConfiguration" not in res["BackupBucket"]["Properties"] and "CorsConfiguration" not in res["ReleasesBucket"]["Properties"])
    key = res["PilotDataKey"]["Properties"]
    tags = {t["Key"]: t["Value"] for t in key["Tags"]}
    chk("key: rotation on, tagged Environment=pilot and Purpose=data; alias alias/codeproctor-pilot-data", key["EnableKeyRotation"] is True and tags["Environment"] == "pilot" and tags["Purpose"] == "data" and res["PilotDataKeyAlias"]["Properties"]["AliasName"] == "alias/codeproctor-pilot-data")
    chk("key: one key only; media and backup use it; no DataKeyType parameter", sum(1 for v in res.values() if v["Type"] == "AWS::KMS::Key") == 1 and all(res[b]["Properties"]["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]["ServerSideEncryptionByDefault"]["KMSMasterKeyID"] == KEYID for b in ("MediaBucket", "BackupBucket")) and "DataKeyType" not in raw["Parameters"])
    chk("key policy: instance role Decrypt/GenerateDataKey/DescribeKey through S3; restore role Decrypt/DescribeKey through S3", all(set(a.lower() for a in st["Action"]) <= {"kms:decrypt", "kms:generatedatakey*", "kms:describekey"} for st in key["KeyPolicy"]["Statement"] if st["Sid"] in ("InstanceRoleUseThroughS3", "RestoreRoleDecryptThroughS3")))
    role = res["BackupExpiryRole"]["Properties"]
    pol = role["Policies"][0]["PolicyDocument"]["Statement"]
    allow = {a.lower() for st in pol if st["Effect"] == "Allow" for a in T.aslist(st["Action"])}
    chk("expiry role: S3 only list and delete on the backups bucket (plus own logs and the age metric)", {a for a in allow if a.startswith("s3:")} == {"s3:listbucket", "s3:listbucketversions", "s3:deleteobject", "s3:deleteobjectversion"} and "s3:bypassgovernanceretention" not in allow)
    trust = role["AssumeRolePolicyDocument"]["Statement"][0]
    chk("expiry role trust: Lambda service only, for the one function by aws:SourceArn (NOT VERIFIED that Lambda accepts it)", trust["Principal"] == {"Service": "lambda.amazonaws.com"} and "aws:SourceArn" in trust["Condition"]["ArnLike"])
    al = {n: v["Properties"] for n, v in res.items() if v["Type"] == "AWS::CloudWatch::Alarm"}
    chk("alarms: freshness (2 days, missing breaches), age 28 days, dump size, dump versions per day, full base backup count", set(al) == {"BackupFreshnessAlarm", "BackupAgeAlarm", "DumpSizeAnomalyAlarm", "DumpVersionCountAlarm", "BaseBackupCountAlarm"})
    f = al["BackupFreshnessAlarm"]
    chk("freshness alarm: BackupSuccess Sum < 1 over 2 daily periods, missing data breaching", f["MetricName"] == "BackupSuccess" and f["Period"] == 86400 and f["EvaluationPeriods"] == 2 and f["Threshold"] == 1 and f["ComparisonOperator"] == "LessThanThreshold" and f["TreatMissingData"] == "breaching")
    ag = al["BackupAgeAlarm"]
    chk("age alarm: OldestKeptBackupAgeDays >= 28 (ADR 0017 5.3; C-55 says 30-day window), missing data breaching", ag["MetricName"] == "OldestKeptBackupAgeDays" and ag["Threshold"] == 28 and ag["ComparisonOperator"] == "GreaterThanOrEqualToThreshold" and ag["TreatMissingData"] == "breaching")
    chk("size anomaly alarm: DumpSizeChangeFactor > 3; versions alarm: DumpVersionsPerDay > 3", al["DumpSizeAnomalyAlarm"]["MetricName"] == "DumpSizeChangeFactor" and al["DumpSizeAnomalyAlarm"]["Threshold"] == "3" and al["DumpVersionCountAlarm"]["MetricName"] == "DumpVersionsPerDay" and al["DumpVersionCountAlarm"]["Threshold"] == "3" and al["BaseBackupCountAlarm"]["MetricName"] == "FullBaseBackupCountChange" and al["BaseBackupCountAlarm"]["Threshold"] == "2")
    chk("all alarms use codeproctor-pilot- names and no action when AlarmTopicArn is empty", all(a["AlarmName"].startswith("codeproctor-pilot-backup-") and a["AlarmActions"] is None for a in al.values()))
    chk("no automatic day-30 expiry: no lifecycle rule expires anything older than 14 days on the backup bucket", all("ExpirationInDays" not in r and "Expiration" not in r for r in br.values()))
    chk("no pilot instance, scheduler or plan role in the data template; one role only (expiry)", [v["Properties"]["RoleName"] for v in res.values() if v["Type"] == "AWS::IAM::Role"] == ["codeproctor-pilot-backup-expiry"])

    # CI role statements must not allow object-lock or bypass anything
    ci_allows = {a.lower() for d in ci_ident for st in d["Statement"] if st["Effect"] == "Allow" for a in T.aslist(st["Action"])}
    chk("CI role has no Allow for BypassGovernanceRetention, retention or legal hold", not any("retention" in a or "legalhold" in a for a in ci_allows))

    pol_of = {n: res[n.capitalize() + "BucketPolicy"]["Properties"]["PolicyDocument"] for n in ("media", "backup", "releases")}
    allow_all = [{"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}]
    world = {"deploy": (ci_ident, T.DEPLOY), "app": (allow_all, APP), "judge0": (allow_all, J0), "restore": (allow_all, RESTORE), "expiry": (allow_all, EXPIRY), "owner": (allow_all, OWNER)}
    rows = []

    def add(name, who, act, rsrc, ctx, exp, bucket=None, key_pol=False):
        ctx = dict(ctx)
        dflt = []
        if act.startswith("s3:") and "aws:ResourceAccount" not in ctx:
            ctx["aws:ResourceAccount"] = A
            dflt.append("aws:ResourceAccount")
        ident, parn = world[who]
        rps = []
        if bucket:
            rps.append(pol_of[bucket])
        if key_pol:
            rps.append(key["KeyPolicy"])
        got, why = T.evaluate(ident, None, rps, parn, act, rsrc, ctx)
        ok = (exp == got) or (exp == "NODENY" and not why.startswith("explicit"))
        keys = ",".join(sorted(k for k in ctx if k not in dflt)) + (" *" + ",".join(dflt) if dflt else "")
        rows.append((name, who, exp, got, ok, why, keys))

    enc_ok = {"s3:x-amz-server-side-encryption": "aws:kms", "s3:x-amz-server-side-encryption-aws-kms-key-id": KEYID}
    # ---- media and backup: CI can do nothing
    for n in ("media", "backup"):
        b, o = BK[n], BK[n] + "/orgs/o/x"
        for act in ("GetObject", "PutObject", "DeleteObject"):
            add(f"CI cannot {act} on {n}", "deploy", "s3:" + act, o, {}, "DENY", n)
        for act in ("ListBucket", "ListBucketVersions", "ListBucketMultipartUploads", "PutBucketPolicy", "DeleteBucketPolicy", "PutBucketAcl", "PutBucketPublicAccessBlock", "PutBucketVersioning", "PutLifecycleConfiguration", "PutEncryptionConfiguration", "PutBucketObjectLockConfiguration", "PutBucketCors", "DeleteBucket", "PutInventoryConfiguration"):
            add(f"CI cannot {act} on {n}", "deploy", "s3:" + act, b, {}, "DENY", n)
        for act in ("BypassGovernanceRetention", "PutObjectRetention", "PutObjectLegalHold"):
            add(f"CI cannot {act} on {n}", "deploy", "s3:" + act, o, {}, "DENY", n)
        for who in ("judge0", "restore") if n == "media" else ("judge0",):
            add(f"{who} role cannot read {n}", who, "s3:GetObject", o, {}, "DENY", n)
        add(f"main instance role can read {n}", "app", "s3:GetObject", o, {}, "ALLOW", n)
        add(f"main instance role can write {n} (SSE-KMS, data key)", "app", "s3:PutObject", o, enc_ok, "ALLOW", n)
        add(f"main instance role can list {n}", "app", "s3:ListBucket", b, {}, "ALLOW", n)
        add(f"main instance role: aws:kms header without key id on {n} (would use aws/s3)", "app", "s3:PutObject", o, {"s3:x-amz-server-side-encryption": "aws:kms"}, "DENY", n)
        add(f"main instance role: AES256 on {n}", "app", "s3:PutObject", o, {"s3:x-amz-server-side-encryption": "AES256"}, "DENY", n)
        add(f"main instance role: another KMS key on {n}", "app", "s3:PutObject", o, {"s3:x-amz-server-side-encryption": "aws:kms", "s3:x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:us-east-1:111111111111:key/aws-s3"}, "DENY", n)
        add(f"main instance role: no encryption header on {n} (bucket default applies)", "app", "s3:PutObject", o, {}, "ALLOW", n)
        add(f"main instance role: plain HTTP on {n}", "app", "s3:GetObject", o, {"aws:SecureTransport": "false"}, "DENY", n)
        add(f"main instance role cannot change the {n} bucket policy", "app", "s3:PutBucketPolicy", b, {}, "DENY", n)
        add(f"main instance role cannot change {n} lifecycle", "app", "s3:PutLifecycleConfiguration", b, {}, "DENY", n)
        add(f"owner (human admin) can change the {n} bucket policy", "owner", "s3:PutBucketPolicy", b, {}, "ALLOW", n)
    add("media: main instance role can delete (retention jobs)", "app", "s3:DeleteObject", BK["media"] + "/orgs/o/x", {}, "ALLOW", "media")
    add("media: restore role cannot read media", "restore", "s3:GetObject", BK["media"] + "/orgs/o/x", {}, "DENY", "media")
    add("media: expiry role cannot read media", "expiry", "s3:GetObject", BK["media"] + "/orgs/o/x", {}, "DENY", "media")
    # ---- backup bucket: DL-43, Object Lock, expiry role
    B = BK["backup"]
    DUMP, WAL, ERA = B + "/db/dump/latest.dump", B + "/db/wal/archive/x/000000010000000000000001", B + "/db/erasure-list/20261005T020000Z-x.json"
    add("backup: instance role overwrites db/dump/latest.dump (a new version)", "app", "s3:PutObject", DUMP, {}, "ALLOW", "backup")
    add("backup: instance role writes WAL", "app", "s3:PutObject", WAL, {}, "ALLOW", "backup")
    add("backup: instance role writes an erasure-list entry", "app", "s3:PutObject", ERA, {}, "ALLOW", "backup")
    for obj, label in ((DUMP, "dump"), (WAL, "WAL"), (ERA, "erasure list")):
        add(f"backup: instance role cannot DeleteObject on the {label}", "app", "s3:DeleteObject", obj, {}, "DENY", "backup")
        add(f"backup: instance role cannot DeleteObjectVersion on the {label}", "app", "s3:DeleteObjectVersion", obj, {}, "DENY", "backup")
    for act in ("BypassGovernanceRetention", "PutObjectRetention", "PutObjectLegalHold"):
        add(f"backup: instance role cannot {act}", "app", "s3:" + act, DUMP, {}, "DENY", "backup")
        add(f"backup: expiry role cannot {act}", "expiry", "s3:" + act, DUMP, {}, "DENY", "backup")
        add(f"backup: restore role cannot {act}", "restore", "s3:" + act, DUMP, {}, "DENY", "backup")
    add("backup: owner can bypass governance retention", "owner", "s3:BypassGovernanceRetention", DUMP, {}, "ALLOW", "backup")
    add("backup: restore role can read the dump", "restore", "s3:GetObject", DUMP, {}, "ALLOW", "backup")
    add("backup: restore role can list the bucket", "restore", "s3:ListBucket", B, {}, "ALLOW", "backup")
    add("backup: restore role can list versions", "restore", "s3:ListBucketVersions", B, {}, "ALLOW", "backup")
    add("backup: restore role cannot write", "restore", "s3:PutObject", DUMP, enc_ok, "DENY", "backup")
    add("backup: restore role cannot delete", "restore", "s3:DeleteObject", DUMP, {}, "DENY", "backup")
    add("backup: expiry role can delete an object", "expiry", "s3:DeleteObject", WAL, {}, "ALLOW", "backup")
    add("backup: expiry role can delete a version", "expiry", "s3:DeleteObjectVersion", WAL, {}, "ALLOW", "backup")
    add("backup: expiry role can list versions", "expiry", "s3:ListBucketVersions", B, {}, "ALLOW", "backup")
    add("backup: expiry role cannot read data", "expiry", "s3:GetObject", DUMP, {}, "DENY", "backup")
    add("backup: expiry role cannot write", "expiry", "s3:PutObject", DUMP, enc_ok, "DENY", "backup")
    add("backup: expiry role cannot change the bucket policy", "expiry", "s3:PutBucketPolicy", B, {}, "DENY", "backup")
    add("backup: Judge0 role cannot list", "judge0", "s3:ListBucket", B, {}, "DENY", "backup")
    # ---- releases bucket
    REL = BK["releases"]
    add("releases: CI puts a manifest under main/", "deploy", "s3:PutObject", REL + "/main/manifest-000001.json", {}, "ALLOW", "releases")
    add("releases: CI puts a manifest under judge0/", "deploy", "s3:PutObject", REL + "/judge0/manifest-000001.json", {}, "ALLOW", "releases")
    add("releases: CI puts under another prefix", "deploy", "s3:PutObject", REL + "/other/x", {}, "DENY", "releases")
    add("releases: CI cannot read, delete or list", "deploy", "s3:GetObject", REL + "/main/manifest-000001.json", {}, "DENY", "releases")
    add("releases: CI cannot delete", "deploy", "s3:DeleteObject", REL + "/main/manifest-000001.json", {}, "DENY", "releases")
    add("releases: CI cannot list", "deploy", "s3:ListBucket", REL, {}, "DENY", "releases")
    add("releases: CI cannot change the bucket policy", "deploy", "s3:PutBucketPolicy", REL, {}, "DENY", "releases")
    add("releases: main role reads its own prefix", "app", "s3:GetObject", REL + "/main/manifest-000001.json", {}, "ALLOW", "releases")
    add("releases: main role cannot read the Judge0 prefix", "app", "s3:GetObject", REL + "/judge0/manifest-000001.json", {}, "DENY", "releases")
    add("releases: Judge0 role reads its own prefix", "judge0", "s3:GetObject", REL + "/judge0/manifest-000001.json", {}, "ALLOW", "releases")
    add("releases: Judge0 role cannot read the main prefix", "judge0", "s3:GetObject", REL + "/main/manifest-000001.json", {}, "DENY", "releases")
    add("releases: main role cannot write", "app", "s3:PutObject", REL + "/main/manifest-000002.json", {}, "DENY", "releases")
    add("releases: Judge0 role cannot write", "judge0", "s3:PutObject", REL + "/judge0/manifest-000002.json", {}, "DENY", "releases")
    add("releases: main role can list", "app", "s3:ListBucket", REL, {}, "ALLOW", "releases")
    add("releases: Judge0 role can list", "judge0", "s3:ListBucket", REL, {}, "ALLOW", "releases")
    add("releases: restore role cannot list", "restore", "s3:ListBucket", REL, {}, "DENY", "releases")
    add("releases: plain HTTP", "app", "s3:GetObject", REL + "/main/manifest-000001.json", {"aws:SecureTransport": "false"}, "DENY", "releases")
    # ---- key
    add("CI cannot PutKeyPolicy on the data key", "deploy", "kms:PutKeyPolicy", KEYARN, KT, "DENY", key_pol=True)
    add("CI cannot Decrypt with the data key", "deploy", "kms:Decrypt", KEYARN, {**KT, **VIA_S3}, "DENY", key_pol=True)
    add("CI cannot ScheduleKeyDeletion on the data key", "deploy", "kms:ScheduleKeyDeletion", KEYARN, {**KT, "kms:ScheduleKeyDeletionPendingWindowInDays": "30"}, "DENY", key_pol=True)
    add("CI cannot CreateGrant on the data key", "deploy", "kms:CreateGrant", KEYARN, {**KT, "kms:GrantIsForAWSResource": "true"}, "DENY", key_pol=True)
    add("main instance role decrypts through S3", "app", "kms:Decrypt", KEYARN, {**KT, **VIA_S3}, "ALLOW", key_pol=True)
    add("main instance role generates a data key through S3", "app", "kms:GenerateDataKey", KEYARN, {**KT, **VIA_S3}, "ALLOW", key_pol=True)
    add("restore role decrypts through S3", "restore", "kms:Decrypt", KEYARN, {**KT, **VIA_S3}, "ALLOW", key_pol=True)
    add("Judge0 role cannot decrypt", "judge0", "kms:Decrypt", KEYARN, {**KT, **VIA_S3}, "DENY", key_pol=True)
    add("expiry role cannot decrypt", "expiry", "kms:Decrypt", KEYARN, {**KT, **VIA_S3}, "DENY", key_pol=True)
    add("main instance role cannot change the key policy", "app", "kms:PutKeyPolicy", KEYARN, KT, "DENY", key_pol=True)
    add("owner administers the key", "owner", "kms:PutKeyPolicy", KEYARN, KT, "ALLOW", key_pol=True)

    # ---- trust of the expiry role: not assumable from the instance or CI
    def can_assume(principal, ctx):
        for st in role["AssumeRolePolicyDocument"]["Statement"]:
            p = st["Principal"]
            vals = [x for v in p.values() for x in T.aslist(v)]
            if principal in vals and T.cond_ok(st.get("Condition"), {k.lower(): v for k, v in ctx.items()}):
                return "ALLOW"
        return "DENY"
    FN = f"arn:aws:lambda:{T.REGION}:{A}:function:codeproctor-pilot-backup-expiry"
    for n, pr, ctx, exp in (
        ("Expiry role trust: the Lambda service for the expiry function", "lambda.amazonaws.com", {"aws:SourceAccount": A, "aws:SourceArn": FN}, "ALLOW"),
        ("Expiry role trust: the Lambda service for another function", "lambda.amazonaws.com", {"aws:SourceAccount": A, "aws:SourceArn": FN + "-evil"}, "DENY"),
        ("Expiry role trust: the Lambda service from another account", "lambda.amazonaws.com", {"aws:SourceAccount": "999999999999", "aws:SourceArn": FN}, "DENY"),
        ("Expiry role trust: the main instance role", APP, {}, "DENY"),
        ("Expiry role trust: the Judge0 instance role", J0, {}, "DENY"),
        ("Expiry role trust: the CI deploy role", T.DEPLOY, {}, "DENY"),
        ("Expiry role trust: the EC2 service (instance profile)", "ec2.amazonaws.com", {}, "DENY"),
        ("Expiry role trust: the scheduler service", "scheduler.amazonaws.com", {"aws:SourceArn": FN}, "DENY"),
    ):
        got = can_assume(pr, ctx)
        rows.append((n, "trust", exp, got, got == exp, "trust policy", ",".join(sorted(ctx))))

    # ---- offline lifecycle model (DL-43, ADR 0017 5.3): newest 3 survive at any age, lock interplay
    N, D, L = 2, 1, 12
    def model(name, ages, now, expect_alive, nd=D, nn=N, lock=L):
        alive = surviving(ages, now, nd, nn, lock)
        rows.append((name, "model", "alive " + str(expect_alive), "alive " + str(alive), alive == expect_alive, "lifecycle model", f"ages={ages} now={now}"))
    model("lifecycle: backups stopped 100 days ago: the newest 3 survive", [100, 101, 102, 103, 104, 105], 0, [0, 1, 2])
    model("lifecycle: backups stopped, 300 days later the newest 3 still survive (no day-30 expiry)", [100, 101, 102, 103, 104, 105], 300, [0, 1, 2])
    model("lifecycle: only 2 dumps exist, both survive at any age", [500, 501], 0, [0, 1])
    model("lifecycle: nightly dumps: versions younger than 12 days survive (the lock is the later of the two limits)", list(range(0, 20)), 0, list(range(0, 12)))
    model("lifecycle: nightly dumps, one day later, one more version has expired (no new dump lands in this model)", list(range(0, 20)), 1, list(range(0, 11)))
    model("lifecycle MODEL (documented S3 behaviour, UNVERIFIED against S3): a locked version is skipped, not an error", [0, 0.5, 1, 2, 3], 5, [0, 1, 2, 3, 4])
    model("lifecycle MODEL (UNVERIFIED): the skipped version expires once its lock ends, oldest first", [0, 0.5, 1, 2, 3], 9.5, [0, 1, 2, 3])
    model("lifecycle MODEL (UNVERIFIED): both locked versions are gone after their locks end", [0, 0.5, 1, 2, 3], 10.5, [0, 1, 2])
    model("junk push-out: 3 junk versions on top of 3 nightly dumps: no real dump goes before creation + 12 days", [0, 0, 0, 1, 2, 3], 8.9, [0, 1, 2, 3, 4, 5])
    model("junk push-out: the oldest displaced dump goes right after its lock (day 9 here = its age 3 + 9 = 12)", [0, 0, 0, 1, 2, 3], 9.5, [0, 1, 2, 3, 4])
    model("junk push-out LIMIT: displaced dumps older than 12 days expire at once (the lock does not help; the alarms must page first)", [0, 0, 0, 20, 21, 22], 0.5, [0, 1, 2, 3])
    model("junk push-out LIMIT: ... and the newest displaced one is gone on day 1", [0, 0, 0, 20, 21, 22], 1.1, [0, 1, 2])

    print("Structural checks")
    fails = []
    for n, ok in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
        if not ok:
            fails.append(n)
    w = max(len(r[0]) for r in rows)
    print("\n%-*s  %-9s  %-7s %-7s %-8s %s" % (w, "case", "principal", "expect", "got", "result", "keys (hand-supplied; * = harness default)"))
    npass = 0
    for (n, who, exp, got, ok, why, keys) in rows:
        npass += ok
        if not ok:
            fails.append(n)
        print("%-*s  %-9s  %-7s %-7s %-8s %s%s" % (w, n, who, exp[:7], got[:7], "ok" if ok else "MISMATCH", keys, "" if ok else " (" + why + ")"))
    print(f"\n{len(rows)} cases, {npass} pass, {len(rows) - npass} fail; {len(checks)} structural checks")
    if fails:
        print("FAILED:", *fails, sep="\n  ")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
