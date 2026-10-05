# ZAP baseline scan (TC-093)

Owner: QA B (ops). TC-093 (NFR-04, P1): OWASP ZAP baseline against staging, expected result "no high findings". Staging only; nothing runs until DEP-01 exists.

| File                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline.conf`      | rule file for `zap-baseline.py -c`. Everything stays at the ZAP default (WARN) except purely informational rules, which go to INFO. No rule is IGNOREd and none is FAIL, so the scan step cannot stop before the report is judged.                                                                                                                                                                                                                                            |
| `baseline-asvs.conf` | optional stricter profile: FAIL on cookie flags, sensitive data in URLs, PII and debug output, server banner, and the HSTS, CSP, clickjacking and nosniff headers (NFR-04 ASVS level 2, FR-104, ADR 0013). Use it for a hardening pass; a FAIL gives the scan a non-zero exit code.                                                                                                                                                                                           |
| `evaluate.mjs`       | the TC-093 verdict logic (importable; no CLI) from `report.json`; it returns code 0 when the scan reached the target and found no High alert (risk code 3), 1 on High (or Medium with `--fail-on-medium`), 2 when the report is unusable (also: an alert with a missing or out-of-range riskcode, or with `--target-host` no site for that host) or empty (`cli.mjs` exits with that code). It prints alert names, rule ids and counts, never URLs (a URL can carry a token). |
| `cli.mjs`            | command line for the verdict (`node packages/qa/zap/cli.mjs zap/report.json [--fail-on-medium] --target-host <host>`; `--target-host` is required, exit 2 without it); any other option or a `--flag=value` form exits 2.                                                                                                                                                                                                                                                     |
| `evaluate.test.mjs`  | unit and CLI tests of the verdict: `node --test packages/qa/zap/*.test.mjs`                                                                                                                                                                                                                                                                                                                                                                                                   |

## What the baseline covers, and does not

The baseline scan is passive: ZAP spiders the target for one minute and reports what it sees in the responses. It does not log in, does not send attacks and does not exercise the candidate API behind a token. So:

1. Run it against the web origin (the Cloudflare Pages staging URL) and, as a second run, against the API origin (for example `https://<staging-api>/api/v1/health`), so headers, cookies and error pages of both are seen.
2. A clean baseline is not a security pass. Authenticated and abuse cases are the red-team plan (docs/qa/redteam-plan.md, RT-01 to RT-74) and the API tests (TC-004, TC-008, TC-065).
3. An empty report is not a pass. If the target is unreachable the HTML and JSON reports can come out empty, which a "count the High alerts" check would call green. `cli.mjs` exits 2 in that case. Also check in the HTML report that the spider visited pages, not only `/`, `robots.txt` and a 404.
4. Never run the active scan (`zap-full-scan.py`, `zap-api-scan.py`) against staging without the owner's agreement: it sends attack payloads to routes that create sessions and lock accounts.

## Running

CI: Actions, workflow "QA", scan `zap-baseline`, with the staging URL. The host must be in the repository variable `QA_STAGING_HOSTS`.

Locally (Docker, the image pinned in `.github/workflows/qa.yml`; the digest below must be bumped together with qa.yml):

```sh
mkdir -p zap && chmod 777 zap
cp packages/qa/zap/baseline.conf zap/
docker run --rm -v "$PWD/zap:/zap/wrk:rw" \
  ghcr.io/zaproxy/zaproxy@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef \
  zap-baseline.py -t "https://<staging-web-host>" -c baseline.conf -J report.json -r report.html -I
node packages/qa/zap/cli.mjs zap/report.json --target-host <staging-web-host>
```

ZAP's own exit code 3 (the scan failed) must fail the CI step; `cli.mjs` only judges a report that exists. `-I` stops warnings from failing the scan; the verdict then comes from `cli.mjs`. Keep the `zap/` output out of git and out of chat: the HTML report lists URLs.

## Triage rules

- High (risk code 3): TC-093 fails. File a defect with the rule id, the alert name and the instance count (not the URLs in a public place), owner agent from the finding, and mark it a blocker when it concerns authentication, authorization, sessions, cryptography or candidate data (CLAUDE.md rule 3).
- Medium: report to the owner in the QA follow-ups; fix before pilot unless the architect accepts it in writing.
- A false positive is IGNOREd only in a PR that adds the rule line to `baseline.conf` with the reason and the owner in a comment above it, reviewed by code-reviewer.

## Last check

2026-10-05: `zap-baseline.py` (ZAP 2.17.0, pinned image) accepted both rule files and produced a JSON report that `evaluate.mjs` read, run against a local stand-in server (not staging). `node --test packages/qa/zap/*.test.mjs`: 14 tests pass. TC-093 itself is not run: no staging.

## CI changes for the hub (not made here)

The `zap-baseline` job in `.github/workflows/qa.yml` currently:

1. runs `zap-baseline.py -t "$TARGET" -J report.json -r report.html -I` without `-c` (add the mount of `packages/qa/zap/baseline.conf` and `-c baseline.conf`), and
2. decides with `jq '[.site[].alerts[] | select(.riskcode == "3")] | length'`, which counts zero High alerts and passes when the report has no site (an unreachable target). Replace the step with `node packages/qa/zap/cli.mjs zap/report.json --target-host <host>`. The job also has no `actions/checkout`, so `baseline.conf` and `evaluate.mjs` are not on the runner: add `actions/checkout` and `actions/setup-node` (with `.nvmrc`) before the scan. A ZAP exit code of 3 (the scan itself failed) must fail the job (follow-up FU-QAB-01).
3. Add a second scan of the API origin (input `api_url`, same allow-list check).
