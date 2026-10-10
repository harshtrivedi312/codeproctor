#!/usr/bin/env node
// Session seeder for the k6 load tests (TC-090, TC-091). See README.md in this folder.
// Public API only; no database access; staging with synthetic data only (ADR 0009).
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, assertSafeOutPath, USAGE } from './lib/config.mjs';
import { createClient } from './lib/http.mjs';
import { createStaff } from './lib/staff.mjs';
import { createMailpitSource } from './lib/mail.mjs';
import { seedOne } from './lib/flow.mjs';
import { ROUTES } from './lib/routes.mjs';
import { newRunId } from './lib/synthetic.mjs';
import { redact, SeedError } from './lib/redact.mjs';

// Writes `data` to `file` with mode 0600 (temp file, then rename, so a crash leaves no partial file).
async function writeSecure(file, data, { force = false } = {}) {
  if (!force && existsSync(file)) {
    throw new Error(
      'The output file already exists; use --force to replace it, or pick another path.',
    );
  }
  // 'wx' with a random suffix: an existing path (a planted symlink) is never followed or reused.
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

function plan(cfg, runId) {
  const set = (v) => (v ? 'set' : 'MISSING');
  return [
    `mode            ${cfg.cleanup ? 'cleanup' : 'seed'}${cfg.dryRun ? ' (dry run: no request will be sent)' : ''}`,
    `run id          ${runId}`,
    `stops at        ${cfg.stopAt}${cfg.identity ? ' (with the identity step)' : ''}`,
    `target host     ${cfg.host ?? 'MISSING (API_BASE_URL)'}  (guard: ALLOWED_HOSTS + prod/pilot deny-list)`,
    `organisation    ${cfg.orgName ?? 'MISSING (SEED_ORG_NAME)'}  (login must belong to it)`,
    `staff login     email ${set(cfg.staff.email)}, password ${set(cfg.staff.password)}, totp ${set(cfg.staff.totpSecret)}`,
    ...(cfg.cleanup
      ? [`manifest        ${cfg.manifest ?? 'MISSING'}`]
      : [
          `test template   ${cfg.testId ?? 'MISSING (SEED_TEST_ID)'}`,
          `candidates      ${cfg.count} on @${cfg.domain}`,
          `mail sink       ${cfg.mailUrl ? 'set' : 'MISSING (SEED_MAIL_URL)'}`,
          `sessions file   ${cfg.out ?? 'MISSING (--out / SEED_OUT)'}  (mode 0600)`,
          `manifest        ${cfg.manifest ?? 'n/a'}`,
          `rate            ${cfg.rps} req/s, ${cfg.concurrency} candidates in parallel`,
          'per candidate   invite -> mail token + OTP -> start -> consent -> system check -> room scan -> start test',
          '                (identity: gated, --identity; proctor-key is left uncalled for k6)',
        ]),
    `routes          ${Object.keys(ROUTES).length} (see lib/routes.mjs; ASSUMED ones are marked there)`,
  ].join('\n');
}

export async function main(
  argv,
  env,
  { fetchImpl = fetch, sleep, stdout = process.stdout, stderr = process.stderr } = {},
) {
  const secrets = [];
  for (const k of ['SEED_STAFF_PASSWORD', 'SEED_STAFF_TOTP_SECRET', 'SEED_STAFF_EMAIL']) {
    if (env[k]) secrets.push(env[k]);
  }
  const log = (s) => stderr.write(`${redact(s, secrets)}\n`);
  const say = (s) => stdout.write(`${redact(s, secrets)}\n`);
  const sleepFn = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let cfg;
  try {
    cfg = loadConfig(argv, env);
  } catch (e) {
    log(`Refused: ${e.message}`);
    return 2;
  }
  if (cfg.help) {
    say(USAGE);
    return 0;
  }
  const runId = cfg.runId ?? newRunId();

  if (cfg.dryRun) {
    // The plan holds names and set/missing flags only, never a secret value: print it unredacted.
    stdout.write(`${plan(cfg, runId)}\n`);
    if (cfg.missing.length) {
      say(`\nDry run found missing configuration: ${cfg.missing.join(', ')}.`);
      return 2;
    }
    say('\nDry run OK: configuration is valid. Nothing was sent.');
    return 0;
  }

  const http = (baseUrl) => createClient({ baseUrl, rps: cfg.rps, fetchImpl, sleep: sleepFn });
  const apiClient = http(cfg.apiBase);
  const staff = createStaff({
    client: apiClient,
    credentials: cfg.staff,
    expectOrgName: cfg.orgName,
    secrets,
  });

  try {
    return cfg.cleanup
      ? await cleanup({ cfg, staff, runId, say, log })
      : await seed({ cfg, staff, apiClient, http, runId, say, log, secrets, sleep: sleepFn });
  } catch (e) {
    log(`Failed: ${e instanceof SeedError || e instanceof Error ? e.message : 'unknown error'}`);
    return 1;
  }
}

async function seed({ cfg, staff, apiClient, http, runId, say, log, secrets, sleep }) {
  if (cfg.out && existsSync(cfg.out) && !cfg.force) {
    throw new Error(
      'The output file already exists; use --force to replace it, or pick another path.',
    );
  }
  // A failed run leaves a manifest but no sessions file: do not overwrite the ids of candidates
  // that still exist (TC-094 needs them for --cleanup).
  if (cfg.manifest && existsSync(cfg.manifest) && !cfg.force) {
    let prior;
    try {
      prior = JSON.parse(await fs.readFile(cfg.manifest, 'utf8'));
    } catch {
      throw new Error('An existing manifest cannot be read; remove it by hand or use --force.');
    }
    if (prior.cleaned !== true) {
      throw new Error(
        'A manifest from an earlier run exists and was not cleaned up; run --cleanup for it first, or use --force.',
      );
    }
  }
  await staff.login();
  const mail = createMailpitSource({ client: http(cfg.mailUrl), linkRe: cfg.linkRe, sleep });
  const manifest = {
    runId,
    createdAt: new Date().toISOString(),
    orgName: cfg.orgName,
    sessionsFile: cfg.out,
    cleaned: false,
    items: [],
  };
  let saving = Promise.resolve();
  const save = () =>
    (saving = saving.then(() =>
      writeSecure(cfg.manifest, JSON.stringify(manifest, null, 2), { force: true }),
    ));
  const record = (item) => {
    manifest.items.push(item);
    void save();
  };

  log(`run ${runId}: seeding ${cfg.count} synthetic candidates`);
  const entries = new Array(cfg.count).fill(null);
  const failures = [];
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= cfg.count) return;
      try {
        entries[index] = await seedOne({
          index,
          cfg,
          runId,
          staff,
          candidateClient: apiClient,
          mail,
          secrets,
          record,
          log,
          sleep,
        });
      } catch (e) {
        failures.push(index + 1);
        log(`#${String(index + 1).padStart(3, '0')} failed: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, cfg.count) }, worker));
  await save();

  const ok = entries.filter(Boolean);
  const complete = failures.length === 0;
  if (complete || (cfg.allowPartial && ok.length > 0)) {
    await writeSecure(cfg.out, JSON.stringify(ok), { force: true });
  }
  say(`run id: ${runId}`);
  say(`seeded: ${ok.length} of ${cfg.count}`);
  say(`manifest (ids only): ${cfg.manifest}`);
  if (complete || (cfg.allowPartial && ok.length > 0))
    say(`sessions file (bearer tokens, mode 0600): ${cfg.out}`);
  if (!complete) {
    say(`failed candidates: ${failures.sort((a, b) => a - b).join(', ')}`);
    say(
      cfg.allowPartial
        ? 'Partial sessions file written (--allow-partial).'
        : 'No sessions file written. Remove this run with: node seed.mjs --cleanup --run-id ' +
            runId,
    );
    return 1;
  }
  say('Delete the sessions file after the k6 run, then run --cleanup (TC-094).');
  return 0;
}

async function cleanup({ cfg, staff, runId, say, log }) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(cfg.manifest, 'utf8'));
  } catch {
    throw new Error('Cannot read the manifest file for this run.');
  }
  const itemOk = (i) =>
    i !== null &&
    typeof i === 'object' &&
    typeof i.candidateId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i.candidateId) &&
    Number.isInteger(i.index) &&
    i.index >= 0;
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    typeof manifest.runId !== 'string' ||
    !Array.isArray(manifest.items) ||
    !manifest.items.every(itemOk) ||
    (manifest.sessionsFile !== undefined && typeof manifest.sessionsFile !== 'string')
  ) {
    throw new Error('The manifest file is malformed.');
  }
  if (manifest.runId !== runId) throw new Error('The manifest belongs to a different run id.');
  if (manifest.orgName !== cfg.orgName)
    throw new Error('The manifest belongs to a different organisation.');
  // Refuse an unsafe sessions-file path now, before any erasure, not after the manifest says
  // cleaned. The file to remove must be the one this run was started with (SEED_OUT / --out), or,
  // without it, the manifest's own base name: a hand-edited manifest cannot name another file.
  let sessionsFile = null;
  if (manifest.sessionsFile) {
    sessionsFile = assertSafeOutPath(manifest.sessionsFile);
    const expected = cfg.out
      ? path.resolve(cfg.out)
      : cfg.manifest.endsWith('.manifest.json')
        ? cfg.manifest.slice(0, -'.manifest.json'.length)
        : null;
    if (expected === null) {
      throw new Error('Set SEED_OUT to the sessions file this run was started with.');
    }
    if (expected !== sessionsFile) {
      throw new Error(
        'The manifest names a different sessions file than SEED_OUT or its own name.',
      );
    }
  }
  await staff.login();
  let removed = 0;
  let already = 0;
  const failed = [];
  for (const item of manifest.items) {
    if (item.state === 'ERASED') {
      already++;
      continue;
    }
    try {
      // 404/410: already gone (idempotent). The erasure itself completes asynchronously (C-06).
      const r = await staff.call('POST', ROUTES.erase(item.candidateId), {
        step: 'erase candidate',
        idempotent: false,
        body: {},
        expect: [200, 202, 204, 404, 410],
      });
      item.state = 'ERASED';
      if (r.status === 404 || r.status === 410) already++;
      else removed++;
    } catch (e) {
      failed.push(item.index + 1);
      log(`#${String(item.index + 1).padStart(3, '0')} erase failed: ${e.message}`);
    }
  }
  manifest.cleaned = failed.length === 0;
  await writeSecure(cfg.manifest, JSON.stringify(manifest, null, 2), { force: true });
  if (failed.length === 0 && sessionsFile) await fs.rm(sessionsFile, { force: true });
  say(`run id: ${runId}`);
  say(`erasure requested: ${removed}, already gone: ${already}, failed: ${failed.length}`);
  if (failed.length) {
    say(`failed candidates: ${failed.join(', ')} (run --cleanup again)`);
    return 1;
  }
  say(
    "Sessions file removed. Also delete the run's mail-sink messages and storage objects (README).",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
