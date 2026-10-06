// DB-07 backup and restore tests (NFR-03, FR-704 and ADR 0004 R-7 for the erasure list, TC-094
// for re-applied erasure). The guard tests need nothing. The drill needs docker with the
// postgres:16 image, the aws CLI and the PostgreSQL client tools; without them it is skipped and
// says why. It uses throwaway containers and an in-memory S3 server only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { REPO_ROOT } from './test-support.mjs';
import { startFakeS3 } from './verify-fake-s3.mjs';
import {
  applyMigrations,
  clientShims,
  drillUnavailable,
  ERASED_ID,
  KEPT_ID,
  loadFixture,
  startPostgres,
} from './verify-drill-support.mjs';

const BACKUP = `${REPO_ROOT}infra/backup/backup.sh`;
const RESTORE = `${REPO_ROOT}infra/backup/restore.sh`;
const ERASURES = `${REPO_ROOT}infra/backup/erasure-list.sh`;
const SECRET = 'S3CR3T-do-not-print';

// Async on purpose: the fake S3 server runs in this process, and a blocking spawn would starve it.
const run = (script, args, env) =>
  new Promise((resolve) => {
    const child = spawn('sh', [script, ...args], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

const stampDaysAgo = (days) =>
  new Date(Date.now() - days * 86_400_000).toISOString().replace(/[-:]|\.\d{3}/g, '');

describe('DB-07 guards (NFR-03)', () => {
  it('backup.sh takes no arguments, so no secret can land in ps', async () => {
    const r = await run(BACKUP, ['postgres://user:' + SECRET + '@host/db'], {});
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(SECRET));
  });

  it('backup.sh names the missing setting and never prints a secret', async () => {
    const r = await run(BACKUP, [], {
      PGHOST: '127.0.0.1',
      PGUSER: 'u',
      PGDATABASE: 'd',
      PGPASSWORD: SECRET,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /S3_BACKUP_BUCKET is not set/);
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(SECRET));
  });

  it('backup.sh refuses a retention below one day or that is not a number', async () => {
    const base = { PGHOST: 'h', PGUSER: 'u', PGDATABASE: 'd', S3_BACKUP_BUCKET: 'b' };
    assert.equal(
      (await run(BACKUP, [], { ...base, BACKUP_RETENTION_DAYS: '0' })).stderr.includes(
        'at least 1',
      ),
      true,
    );
    assert.match(
      (await run(BACKUP, [], { ...base, BACKUP_RETENTION_DAYS: '1; rm' })).stderr,
      /whole number/,
    );
  });

  it('C-55: BACKUP_KEEP_NEWEST must be 1 to 1000 and BACKUP_MODE must be known', async () => {
    const base = { PGHOST: 'h', PGUSER: 'u', PGDATABASE: 'd', S3_BACKUP_BUCKET: 'b' };
    for (const bad of ['0', 'x', '2; rm', '1001']) {
      const r = await run(BACKUP, [], { ...base, BACKUP_KEEP_NEWEST: bad });
      assert.notEqual(r.status, 0, bad);
      assert.match(r.stderr, /BACKUP_KEEP_NEWEST/);
    }
    const r = await run(BACKUP, [], { ...base, BACKUP_MODE: 'rotate' });
    assert.match(r.stderr, /BACKUP_MODE must be versioned or timestamped/);
  });

  it('restore.sh refuses a target server that is not this machine (ADR 0009)', async () => {
    const r = await run(RESTORE, ['--target-db', 'restored'], {
      PGHOST: 'db.staging.example.com',
      PGUSER: 'u',
      S3_BACKUP_BUCKET: 'b',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not this machine/);
  });

  it('restore.sh refuses PGHOSTADDR in a local restore', async () => {
    const r = await run(RESTORE, ['--target-db', 'restored'], {
      PGHOST: 'localhost',
      PGHOSTADDR: '10.0.0.5',
      PGUSER: 'u',
      S3_BACKUP_BUCKET: 'b',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PGHOSTADDR/);
  });

  it('restore.sh accepts only a plain new database name', async () => {
    for (const bad of ['', 'Prod', 'a;drop', 'a b', 'x'.repeat(64)]) {
      const r = await run(RESTORE, ['--target-db', bad], {
        PGHOST: 'localhost',
        PGUSER: 'u',
        S3_BACKUP_BUCKET: 'b',
      });
      assert.equal(r.status, 1, `name "${bad}"`);
      assert.match(r.stderr, /plain lower-case database name/);
    }
  });

  it('restore.sh needs latest or a version id, not a path', async () => {
    const r = await run(RESTORE, ['--target-db', 'x', '--backup', '../../etc/passwd'], {
      PGHOST: 'localhost',
      PGUSER: 'u',
      S3_BACKUP_BUCKET: 'b',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--backup must be latest/);
  });

  it('restore.sh with a missing option value exits 1, never the "counts differ" code 2', async () => {
    for (const args of [['--target-db'], ['--target-db', 'x', '--backup']]) {
      const r = await run(RESTORE, args, {
        PGHOST: 'localhost',
        PGUSER: 'u',
        S3_BACKUP_BUCKET: 'b',
      });
      assert.equal(r.status, 1, args.join(' '));
    }
  });

  it('restore.sh refuses --skip-erasures on a remote restore (it would bring erased candidates back)', async () => {
    const r = await run(RESTORE, ['--target-db', 'x', '--skip-erasures'], {
      PGHOST: 'db.example.com',
      PGUSER: 'u',
      S3_BACKUP_BUCKET: 'b',
      RESTORE_ALLOW_REMOTE: '1',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /local drills only/);
  });

  it('backup.sh accepts only a plain database name, so a connection string with a password is never logged', async () => {
    const r = await run(BACKUP, [], {
      PGHOST: 'h',
      PGUSER: 'u',
      S3_BACKUP_BUCKET: 'b',
      PGDATABASE: `postgresql://u:${SECRET}@h/db`,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /plain database name/);
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(SECRET));
  });

  it('FR-704: the erasure list takes uuids only', async () => {
    const env = { S3_BACKUP_BUCKET: 'b' };
    assert.match((await run(ERASURES, ['append', 'not-a-uuid'], env)).stderr, /candidate uuid/);
    assert.match(
      (await run(ERASURES, ['append', ERASED_ID, 'yesterday'], env)).stderr,
      /time must look like/,
    );
    assert.match(
      (await run(ERASURES, ['prune', 'x'], { ...env, BACKUP_MODE: 'timestamped' })).stderr,
      /UTC stamp/,
    );
    assert.match((await run(ERASURES, ['complete', 'nope'], env)).stderr, /candidate uuid/);
  });

  it('BACKUP_PREFIX cannot climb out with ..', async () => {
    for (const bad of ['../x', '/abs', 'a//b', 'a#b', 'a b']) {
      const r = await run(ERASURES, ['list'], { S3_BACKUP_BUCKET: 'b', BACKUP_PREFIX: bad });
      assert.equal(r.status, 1, bad);
      assert.match(r.stderr, /BACKUP_PREFIX/, bad);
    }
  });
});

const skip = drillUnavailable() ?? false;
if (skip) console.log(`# DB-07 restore drill skipped: ${skip}`);

// CI sets REQUIRE_DB_DRILL=1 so that a runner without docker, aws or the PostgreSQL tools fails
// instead of passing without ever running the drill (FU-DBB-03).
it(
  'NFR-03: the restore drill can run when it is required',
  { skip: !(skip && process.env.REQUIRE_DB_DRILL === '1') },
  () => {
    assert.fail(`REQUIRE_DB_DRILL=1 but the drill cannot run: ${skip}`);
  },
);

describe('DB-07 backup then restore drill (NFR-03, FR-704, ADR 0004 R-7)', { skip }, () => {
  let pg;
  let s3;
  let env;
  const restored = 'restored';

  before(async () => {
    pg = startPostgres();
    s3 = await startFakeS3();
    applyMigrations(pg, 'source');
    loadFixture(pg, 'source');
    env = {
      ...pg.env,
      PGDATABASE: 'source',
      S3_BACKUP_BUCKET: 'drill-backups',
      S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
      S3_REGION: 'auto',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'drill',
      S3_SECRET_ACCESS_KEY: SECRET,
      RESTORE_CREATE_APP_USER: '1',
      BACKUP_MODE: 'timestamped',
      AWS_MAX_ATTEMPTS: '1',
      PG_BIN_DIR: clientShims(pg, mkdtempSync(join(tmpdir(), 'pg-shims-'))),
    };
  });

  after(async () => {
    pg?.stop();
    await s3?.close();
  });

  const keys = () => [...s3.objects.keys()].map((k) => k.replace('drill-backups/', ''));
  const put = (key) => s3.objects.set(`drill-backups/${key}`, Buffer.from('x'));

  it('NFR-03, C-55: timestamped mode uploads one dump with its metadata, prunes dumps past 14 days but never the newest 3', async () => {
    const d40 = stampDaysAgo(40);
    const d30 = stampDaysAgo(30);
    const d20 = stampDaysAgo(20);
    const recent = stampDaysAgo(3);
    for (const stamp of [d40, d30, d20, recent]) put(`db/dumps/codeproctor-${stamp}.dump`);
    // An orphan that is not a dump never takes a keep slot and is never pruned.
    const orphan = `db/dumps/codeproctor-${stampDaysAgo(25)}.dump.sha256`;
    put(orphan);
    const before = new Date();
    const r = await run(BACKUP, [], env);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(SECRET));
    const k = keys();
    const today = before.toISOString().slice(0, 10).replace(/-/g, '');
    const uploaded = k.find((x) =>
      new RegExp(`^db/dumps/codeproctor-${today}T\\d{6}Z\\.dump$`).test(x),
    );
    assert.ok(uploaded, 'the new dump is there');
    const meta = s3.metas.get(`drill-backups/${uploaded}`);
    assert.match(meta.sha256, /^[0-9a-f]{64}$/);
    assert.match(meta['dumped-at'], /^\d{8}T\d{6}Z$/);
    assert.match(meta.counts, /(^|,)candidates=2(,|$)/);
    assert.ok(!k.includes(`db/dumps/codeproctor-${d40}.dump`), '40-day-old dump pruned');
    assert.ok(!k.includes(`db/dumps/codeproctor-${d30}.dump`), '30-day-old dump pruned');
    assert.ok(k.includes(`db/dumps/codeproctor-${d20}.dump`), '20-day-old kept: newest 3 (C-55)');
    assert.ok(k.includes(`db/dumps/codeproctor-${recent}.dump`), '3-day-old kept');
    assert.ok(k.includes(orphan), 'an orphan sidecar is neither counted nor pruned');
  });

  it('C-55: BACKUP_KEEP_NEWEST=1 keeps only the newest dump', async () => {
    const old = stampDaysAgo(20);
    put(`db/dumps/codeproctor-${old}.dump`);
    const r = await run(BACKUP, [], { ...env, BACKUP_KEEP_NEWEST: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!keys().includes(`db/dumps/codeproctor-${old}.dump`));
  });

  it('FR-704, ADR 0004 R-7: the erasure list is outside the database and survives dump pruning', async () => {
    assert.equal((await run(ERASURES, ['append', ERASED_ID], env)).status, 0);
    assert.equal((await run(ERASURES, ['append', ERASED_ID], env)).status, 0, 'idempotent');
    const list = (await run(ERASURES, ['list'], env)).stdout.trim().split('\n');
    assert.equal(list.length, 1);
    assert.match(list[0], new RegExp(`^\\d{8}T\\d{6}Z ${ERASED_ID}$`));
    // The list is not inside the dump: the source database has no table for it.
    assert.equal(
      pg.psql('source', "SELECT count(*) FROM pg_tables WHERE tablename ILIKE '%erasure%'"),
      '0',
    );
  });

  it('NFR-03: restores the latest backup into a new database with matching row counts', async () => {
    const r = await run(RESTORE, ['--target-db', restored, '--skip-erasures'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /row counts match/);
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(SECRET));
    for (const t of ['candidates', 'sessions', 'proctor_events', 'consents', 'submissions']) {
      assert.equal(
        pg.psql(restored, `SELECT count(*) FROM ${t}`),
        pg.psql('source', `SELECT count(*) FROM ${t}`),
        t,
      );
    }
  });

  it('NFR-03: the restored database keeps the app_user grants, audit_logs stays append-only', async () => {
    const q = (sql) => pg.psql(restored, sql);
    assert.equal(q("SELECT has_table_privilege('app_user', 'candidates', 'UPDATE')"), 't');
    assert.equal(q("SELECT has_table_privilege('app_user', 'audit_logs', 'INSERT')"), 't');
    assert.equal(q("SELECT has_table_privilege('app_user', 'audit_logs', 'UPDATE')"), 'f');
    assert.equal(q("SELECT has_table_privilege('app_user', 'audit_logs', 'DELETE')"), 'f');
  });

  it('NFR-03, ADR 0006 8.8: the restored database gives app_user no TEMPORARY privilege (FU-DB-163)', async () => {
    const q = (sql) => pg.psql(restored, sql);
    assert.equal(
      q("SELECT has_database_privilege('app_user', current_database(), 'TEMPORARY')"),
      'f',
    );
    assert.equal(q("SELECT has_database_privilege('app_user', current_database(), 'CREATE')"), 'f');
    // PUBLIC no longer holds it either, so no other role gets it by default.
    assert.equal(
      q(
        "SELECT count(*) FROM aclexplode((SELECT coalesce(datacl, acldefault('d', datdba)) FROM pg_database WHERE datname = current_database())) a WHERE a.grantee = 0 AND a.privilege_type = 'TEMPORARY'",
      ),
      '0',
    );
  });

  it('NFR-03, ADR 0006 8.8: a restore that cannot revoke TEMPORARY says not to use the database', async () => {
    const r = await run(RESTORE, ['--target-db', 'restored_temp', '--skip-erasures'], {
      ...env,
      FAKE_PSQL_FAIL_ON: 'REVOKE TEMPORARY',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not revoke TEMPORARY on database restored_temp. Do not use it/);
  });

  it('NFR-03, ADR 0006 8.8: a check that cannot run is exit 1, never "counts differ" (status 2 from psql)', async () => {
    const r = await run(RESTORE, ['--target-db', 'restored_temp2', '--skip-erasures'], {
      ...env,
      FAKE_PSQL_FAIL_ON: 'NOT has_database_privilege',
      FAKE_PSQL_FAIL_STATUS: '2',
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(
      r.stderr,
      /could not check the TEMPORARY privilege on database restored_temp2. Do not use it/,
    );
  });

  it('NFR-03, ADR 0006 8.8: app_user that still has TEMPORARY or CREATE fails the restore', async () => {
    const r = await run(RESTORE, ['--target-db', 'restored_temp3', '--skip-erasures'], {
      ...env,
      FAKE_PSQL_OUTPUT_ON: 'NOT has_database_privilege',
      FAKE_PSQL_OUTPUT: 'f',
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(
      r.stderr,
      /app_user still has TEMPORARY or CREATE on database restored_temp3. Do not use it/,
    );
  });

  it('NFR-03: restore never goes over an existing database', async () => {
    const r = await run(RESTORE, ['--target-db', restored], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists/);
    assert.equal(pg.psql(restored, 'SELECT count(*) FROM candidates'), '2');
  });

  it('NFR-03: a damaged backup is refused before the server is touched', async () => {
    const dump = keys()
      .filter((k) => /codeproctor-[^/]*\.dump$/.test(k))
      .sort()
      .at(-1);
    const original = s3.objects.get(`drill-backups/${dump}`);
    s3.objects.set(`drill-backups/${dump}`, Buffer.from('corrupt'));
    const r = await run(
      RESTORE,
      ['--target-db', 'never_created', '--backup', dump.replace('db/dumps/', '')],
      env,
    );
    s3.objects.set(`drill-backups/${dump}`, original);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /checksum mismatch/);
    assert.equal(
      pg.psql('postgres', "SELECT count(*) FROM pg_database WHERE datname = 'never_created'"),
      '0',
    );
  });

  it('TC-094, ADR 0004 R-7: a restore re-applies an erasure made after the backup, and keeps the consent proof (C-17)', async () => {
    const r = await run(RESTORE, ['--target-db', 'restored_erased'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /re-applied 1 erasure/);
    const q = (sql) => pg.psql('restored_erased', sql);
    const erasedSessions = `SELECT s.id FROM sessions s JOIN invitations i ON i.id = s.invitation_id WHERE i.candidate_id = '${ERASED_ID}'`;
    // personal data gone
    assert.equal(
      q(
        `SELECT email || '|' || full_name || '|' || coalesce(external_ref, 'null') || '|' || (erased_at IS NOT NULL) FROM candidates WHERE id = '${ERASED_ID}'`,
      ),
      `erased+${ERASED_ID}@invalid|Erased|null|true`,
    );
    for (const t of [
      'proctor_events',
      'proctor_event_batches',
      'keystroke_batches',
      'media_chunks',
      'identity_checks',
    ]) {
      assert.equal(q(`SELECT count(*) FROM ${t} WHERE session_id IN (${erasedSessions})`), '0', t);
    }
    assert.equal(
      q('SELECT count(*) FROM flag_decisions'),
      '1',
      'only the other candidate keeps a decision',
    );
    assert.equal(
      q(
        `SELECT source_code || results::text FROM submissions WHERE session_question_id IN (SELECT id FROM session_questions WHERE session_id IN (${erasedSessions}))`,
      ),
      '[]',
    );
    assert.equal(
      q(
        `SELECT (final_code IS NULL AND answer IS NULL AND scoring_note IS NULL) FROM session_questions WHERE session_id IN (${erasedSessions})`,
      ),
      't',
    );
    assert.equal(
      q(`SELECT notes IS NULL FROM session_reviews WHERE session_id IN (${erasedSessions})`),
      't',
    );
    assert.equal(
      q(
        `SELECT reason || '|' || (resolution_note IS NULL) FROM appeals WHERE session_review_id IN (SELECT id FROM session_reviews WHERE session_id IN (${erasedSessions}))`,
      ),
      'Erased|true',
    );
    assert.equal(q(`SELECT device_info::text FROM sessions WHERE id IN (${erasedSessions})`), '{}');
    // Session credentials fenced (ADR 0004 9.7): the epoch jumps past anything issued between the
    // backup and the erasure, and the HMAC key does not come back.
    assert.equal(
      q(
        `SELECT auth_epoch || '|' || (hmac_key_enc IS NULL) || '|' || (report_key IS NULL) || '|' || (retention_anchor_at IS NOT NULL) FROM sessions WHERE id IN (${erasedSessions})`,
      ),
      '2000000|true|true|true',
    );
    assert.equal(
      q(
        `SELECT auth_epoch || '|' || (hmac_key_enc IS NULL) FROM sessions WHERE id NOT IN (${erasedSessions})`,
      ),
      '1000000|false',
    );
    // staff refresh tokens are revoked by the restore (a restore un-revokes and un-rotates them)
    assert.equal(q('SELECT count(*) FROM refresh_tokens WHERE revoked_at IS NULL'), '0');
    assert.equal(
      pg.psql('source', 'SELECT count(*) FROM refresh_tokens WHERE revoked_at IS NULL'),
      '1',
    );
    // consent proof kept (C-17)
    assert.equal(
      q(
        `SELECT signed_name || '|' || (ip IS NOT NULL) || '|' || (pdf_key IS NOT NULL) FROM consents WHERE session_id IN (${erasedSessions})`,
      ),
      'Candidate 1|true|true',
    );
    // the other candidate is untouched
    assert.equal(q(`SELECT full_name FROM candidates WHERE id = '${KEPT_ID}'`), 'Candidate 2');
    assert.equal(
      q(`SELECT count(*) FROM proctor_events WHERE session_id NOT IN (${erasedSessions})`),
      '1',
    );
  });

  it('ADR 0004 R-7: re-applying the erasures is idempotent', async () => {
    const q = (sql) => pg.psql('restored_erased', sql);
    const before = q("SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM candidates t");
    const sql = `CREATE TEMP TABLE _reapply_erasures (candidate_id uuid PRIMARY KEY, erased_at timestamptz NOT NULL);
      INSERT INTO _reapply_erasures VALUES ('${ERASED_ID}', now());
      \\i ${REPO_ROOT}infra/backup/reapply-erasures.sql`;
    const r = spawnSync(
      'psql',
      ['--no-psqlrc', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', 'restored_erased'],
      {
        input: sql,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...pg.env },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(q("SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM candidates t"), before);
  });

  it('ADR 0004 R-7: only COMPLETED erasures are pruned, and only once older than the oldest backup', async () => {
    const held = '33333333-3333-4333-8333-333333333333';
    const done = '44444444-4444-4444-8444-444444444444';
    const recent = '55555555-5555-4555-8555-555555555555';
    // A held erasure requested 40 days ago and still running: its entry must survive.
    put(`db/erasure-list/${stampDaysAgo(40)}-${held}.json`);
    // An erasure requested and completed long ago: every remaining backup already has it.
    put(`db/erasure-list/${stampDaysAgo(40)}-${done}.json`);
    put(`db/erasure-completed/${stampDaysAgo(39)}-${done}.json`);
    // Completed after the oldest remaining backup: must survive.
    put(`db/erasure-list/${stampDaysAgo(2)}-${recent}.json`);
    put(`db/erasure-completed/${stampDaysAgo(1)}-${recent}.json`);
    // The reviewer's case: requested 40 days ago, completed 1 day ago. Backups from days 2 to 14 still hold the data.
    const slow = '66666666-6666-4666-8666-666666666666';
    put(`db/erasure-list/${stampDaysAgo(40)}-${slow}.json`);
    put(`db/erasure-completed/${stampDaysAgo(1)}-${slow}.json`);
    // Files that are not ours under the dumps prefix are never touched.
    put('db/dumps/notes.txt');
    put('db/dumps/codeproctor-x.dump');
    const r = await run(BACKUP, [], env);
    assert.equal(r.status, 0, r.stderr);
    const list = (await run(ERASURES, ['list'], env)).stdout;
    assert.match(list, new RegExp(held), 'a held erasure is never pruned');
    assert.doesNotMatch(list, new RegExp(done));
    assert.match(list, new RegExp(recent));
    assert.match(list, new RegExp(slow), 'old request, recent completion: kept');
    assert.match(list, new RegExp(ERASED_ID));
    assert.ok(
      !keys().some((k) => k.includes(`erasure-completed/${stampDaysAgo(39)}`)),
      'its marker goes with it',
    );
    assert.ok(keys().includes('db/dumps/notes.txt'));
    assert.ok(keys().includes('db/dumps/codeproctor-x.dump'));
  });

  it('ADR 0004 R-7: complete needs an existing entry and is idempotent', async () => {
    assert.match(
      (await run(ERASURES, ['complete', KEPT_ID], env)).stderr,
      /not on the erasure list/,
    );
    assert.equal((await run(ERASURES, ['complete', ERASED_ID], env)).status, 0);
    assert.equal((await run(ERASURES, ['complete', ERASED_ID], env)).status, 0);
    assert.equal(
      keys().filter((k) => k.includes('erasure-completed/') && k.includes(ERASED_ID)).length,
      1,
    );
  });

  it('NFR-03: exit code 2 means only "restored, row counts differ"', async () => {
    const dump = keys()
      .filter((k) => /codeproctor-\d{8}T\d{6}Z\.dump$/.test(k))
      .sort()
      .at(-1);
    const original = s3.metas.get(`drill-backups/${dump}`);
    s3.metas.set(`drill-backups/${dump}`, { ...original, counts: 'candidates=999' });
    const r = await run(RESTORE, ['--target-db', 'restored_counts', '--skip-erasures'], env);
    s3.metas.set(`drill-backups/${dump}`, original);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /row counts differ/);
  });

  it('NFR-03: a server that cannot be reached says so and exits 1', async () => {
    const r = await run(RESTORE, ['--target-db', 'never_made'], { ...env, PGPORT: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot reach the database server/);
  });

  it('NFR-03: a command that fails with status 2 on its own is still exit 1, not "counts differ"', async () => {
    const r = await run(RESTORE, ['--target-db', 'never_made2'], {
      ...env,
      FAKE_PSQL_FAIL_ON: 'pg_database',
      FAKE_PSQL_FAIL_STATUS: '2',
    });
    assert.equal(r.status, 1, r.stderr);
  });

  it('ADR 0004 R-7: a restore that cannot read the erasure list fails and says not to use the database', async () => {
    s3.faults.failList = true;
    // The latest dump is named by listing, so name it.
    const dump = keys()
      .filter((k) => /codeproctor-\d{8}T\d{6}Z\.dump$/.test(k))
      .sort()
      .at(-1);
    const r = await run(
      RESTORE,
      ['--target-db', 'restored_nolist', '--backup', dump.replace('db/dumps/', '')],
      env,
    );
    s3.faults.failList = false;
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot list|cannot read the erasure list/);
    assert.match(r.stderr, /Do not use database restored_nolist/);
    assert.doesNotMatch(r.stderr, /re-applied 0 erasure/);
  });

  it('ADR 0004 R-7: an erasure-list key that does not parse stops the restore (it may be an erasure)', async () => {
    put('db/erasure-list/hand-written-by-someone.json');
    const r = await run(ERASURES, ['list'], env);
    s3.objects.delete('drill-backups/db/erasure-list/hand-written-by-someone.json');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not named/);
  });

  it('NFR-03: a failed erasure step says the database must not be used', async () => {
    const r = await run(RESTORE, ['--target-db', 'restored_broken'], {
      ...env,
      FAKE_PSQL_FAIL_ON: 'reapply.sql',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /erasures were NOT re-applied. Do not use database restored_broken/);
  });
});

describe('DB-07 dump safety (NFR-03)', { skip }, () => {
  it('a pg_dump that fails after writing part of the archive uploads and prunes nothing', async () => {
    const pg = startPostgres();
    const s3 = await startFakeS3();
    try {
      const { writeFileSync } = await import('node:fs');
      const dir = mkdtempSync(join(tmpdir(), 'pg-fake-'));
      writeFileSync(
        join(dir, 'pg_dump'),
        '#!/bin/sh\ncase "$1" in --version) echo "pg_dump (PostgreSQL) 16.0"; exit 0;; esac\nfor a in "$@"; do case "$a" in --file=*) printf PGDMP-partial > "${a#--file=}";; esac; done\nexit 1\n',
        { mode: 0o755 },
      );
      const r = await run(BACKUP, [], {
        ...pg.env,
        PGDATABASE: 'postgres',
        S3_BACKUP_BUCKET: 'b',
        S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
        S3_FORCE_PATH_STYLE: 'true',
        S3_ACCESS_KEY_ID: 'x',
        S3_SECRET_ACCESS_KEY: 'y',
        PG_BIN_DIR: dir,
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /pg_dump failed/);
      assert.equal(s3.objects.size, 0, 'nothing uploaded');
    } finally {
      pg.stop();
      await s3.close();
    }
  });
});

describe('DB-07 truncated dumps (NFR-03)', { skip }, () => {
  it('a pg_dump that exits 0 but writes a cut-off archive is refused, nothing uploaded', async () => {
    const pg = startPostgres();
    const s3 = await startFakeS3();
    try {
      applyMigrations(pg, 'source');
      loadFixture(pg, 'source');
      const real = clientShims(pg, mkdtempSync(join(tmpdir(), 'pg-real-')));
      const dir = mkdtempSync(join(tmpdir(), 'pg-trunc-'));
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        join(dir, 'pg_dump'),
        `#!/bin/sh\n${real}/pg_dump "$@" || exit $?\nfor a in "$@"; do case "$a" in --file=*) f=\${a#--file=}; head -c 4000 "$f" > "$f.cut"; mv "$f.cut" "$f";; esac; done\ncase "$1" in --version) ;; esac\nexit 0\n`,
        { mode: 0o755 },
      );
      const r = await run(BACKUP, [], {
        ...pg.env,
        PGDATABASE: 'source',
        S3_BACKUP_BUCKET: 'b',
        S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
        S3_FORCE_PATH_STYLE: 'true',
        S3_ACCESS_KEY_ID: 'x',
        S3_SECRET_ACCESS_KEY: 'y',
        PG_BIN_DIR: dir,
      });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /truncated|damaged|cannot read the dump|table data entries/);
      assert.equal(s3.objects.size, 0, 'nothing uploaded');
    } finally {
      pg.stop();
      await s3.close();
    }
  });

  it('an empty database is never "backed up": a dump with no tables is refused', async () => {
    const pg = startPostgres();
    const s3 = await startFakeS3();
    try {
      const real = clientShims(pg, mkdtempSync(join(tmpdir(), 'pg-real-')));
      const r = await run(BACKUP, [], {
        ...pg.env,
        PGDATABASE: 'postgres',
        S3_BACKUP_BUCKET: 'b',
        S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
        S3_FORCE_PATH_STYLE: 'true',
        S3_ACCESS_KEY_ID: 'x',
        S3_SECRET_ACCESS_KEY: 'y',
        PG_BIN_DIR: real,
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /table data entries/);
      assert.equal(s3.objects.size, 0);
    } finally {
      pg.stop();
      await s3.close();
    }
  });
});

describe('DB-07 version check (NFR-03)', { skip }, () => {
  it('backup.sh refuses a pg_dump whose major version differs from the server', async () => {
    const pg = startPostgres();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'pg-fake-'));
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, 'pg_dump'), '#!/bin/sh\necho "pg_dump (PostgreSQL) 99.0"\n', {
        mode: 0o755,
      });
      const r = await run(BACKUP, [], {
        ...pg.env,
        PGDATABASE: 'postgres',
        S3_BACKUP_BUCKET: 'b',
        PG_BIN_DIR: dir,
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /pg_dump is version 99 but the server is version 16/);
    } finally {
      pg.stop();
    }
  });
});

describe('DB-07 versioned backups (NFR-03, ADR 0017 5.3, C-55)', { skip }, () => {
  let pg;
  let s3;
  let env;
  const KEY = 'drill-backups/db/dump/latest.dump';

  before(async () => {
    pg = startPostgres();
    s3 = await startFakeS3({ versioned: true });
    applyMigrations(pg, 'vsource');
    loadFixture(pg, 'vsource');
    env = {
      ...pg.env,
      PGDATABASE: 'vsource',
      S3_BACKUP_BUCKET: 'drill-backups',
      S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
      S3_REGION: 'auto',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'drill',
      S3_SECRET_ACCESS_KEY: SECRET,
      RESTORE_CREATE_APP_USER: '1',
      AWS_MAX_ATTEMPTS: '1',
      PG_BIN_DIR: clientShims(pg, mkdtempSync(join(tmpdir(), 'pg-shims-'))),
    };
  });

  after(async () => {
    pg?.stop();
    await s3?.close();
  });

  it('NFR-03, C-55: every backup is a new version of one fixed key, with its checksum, time and counts as metadata, and nothing is deleted', async () => {
    const oldEntry = `db/erasure-list/${stampDaysAgo(40)}-${ERASED_ID}.json`;
    const oldDone = `db/erasure-completed/${stampDaysAgo(39)}-${ERASED_ID}.json`;
    s3.objects.set(`drill-backups/${oldEntry}`, Buffer.from('{}'));
    s3.objects.set(`drill-backups/${oldDone}`, Buffer.from('{}'));
    s3.objects.set('drill-backups/db/dump/unrelated.txt', Buffer.from('keep'));
    s3.objects.set('drill-backups/db/dumps/codeproctor-20200101T000000Z.dump', Buffer.from('old'));
    const first = await run(BACKUP, [], env);
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stderr + first.stdout, new RegExp(SECRET));
    pg.psql(
      'vsource',
      `UPDATE candidates SET full_name = 'Changed after v1' WHERE id = '${KEPT_ID}'`,
    );
    const second = await run(BACKUP, [], env);
    assert.equal(second.status, 0, second.stderr);
    const versions = s3.versions.get(KEY);
    assert.equal(versions.length, 2, 'two versions of the one key');
    for (const v of versions) {
      assert.match(v.meta.sha256, /^[0-9a-f]{64}$/);
      assert.match(v.meta['dumped-at'], /^\d{8}T\d{6}Z$/);
      assert.match(v.meta.counts, /(^|,)candidates=2(,|$)/);
    }
    assert.notEqual(versions[0].meta.sha256, versions[1].meta.sha256);
    assert.ok(s3.objects.has('drill-backups/db/dump/unrelated.txt'), 'nothing else was touched');
    assert.ok(
      s3.objects.has('drill-backups/db/dumps/codeproctor-20200101T000000Z.dump'),
      'versioned mode never prunes',
    );
    assert.match(second.stderr, /nothing is deleted/);
    assert.equal(s3.deletes.length, 0, 'versioned mode issues no DELETE request');
    assert.ok(
      s3.objects.has(`drill-backups/${oldEntry}`),
      'erasure list entries are never pruned here',
    );
    assert.ok(s3.objects.has(`drill-backups/${oldDone}`));
  });

  it('NFR-03: restore latest gets the newest version; --backup <version id> gets an older one', async () => {
    const [v1] = s3.versions.get(KEY);
    const latest = await run(RESTORE, ['--target-db', 'vlatest', '--skip-erasures'], env);
    assert.equal(latest.status, 0, latest.stderr);
    assert.match(latest.stderr, /row counts match/);
    assert.equal(
      pg.psql('vlatest', `SELECT full_name FROM candidates WHERE id = '${KEPT_ID}'`),
      'Changed after v1',
    );
    const older = await run(
      RESTORE,
      ['--target-db', 'vfirst', '--backup', v1.id, '--skip-erasures'],
      env,
    );
    assert.equal(older.status, 0, older.stderr);
    assert.equal(
      pg.psql('vfirst', `SELECT full_name FROM candidates WHERE id = '${KEPT_ID}'`),
      'Candidate 2',
    );
  });

  it('NFR-03: a version whose checksum metadata does not match its bytes is refused before the server is touched', async () => {
    const versions = s3.versions.get(KEY);
    const newest = versions.at(-1);
    const original = newest.body;
    newest.body = Buffer.from('tampered');
    s3.objects.set(KEY, newest.body);
    const r = await run(RESTORE, ['--target-db', 'vtamper', '--skip-erasures'], env);
    newest.body = original;
    s3.objects.set(KEY, original);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /checksum mismatch/);
    assert.equal(
      pg.psql('postgres', "SELECT count(*) FROM pg_database WHERE datname = 'vtamper'"),
      '0',
    );
  });

  it('NFR-03: an unknown version id is an error, not a fallback to latest', async () => {
    const r = await run(
      RESTORE,
      ['--target-db', 'vmissing', '--backup', 'no-such-version', '--skip-erasures'],
      env,
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not exist/);
  });
  it('C-55: versioned mode on a store that does not version fails loudly', async () => {
    const plain = await startFakeS3({ versioned: false });
    try {
      const r = await run(BACKUP, [], { ...env, S3_ENDPOINT: `http://127.0.0.1:${plain.port}` });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /not versioned/);
      // The previous backup is not replaced when the existing object already shows the bucket is unversioned.
      const before = plain.objects.get(KEY);
      const again = await run(BACKUP, [], {
        ...env,
        S3_ENDPOINT: `http://127.0.0.1:${plain.port}`,
      });
      assert.equal(again.status, 1, again.stderr);
      assert.match(again.stderr, /not versioned/);
      assert.equal(plain.objects.get(KEY), before, 'the existing object was not overwritten');
    } finally {
      await plain.close();
    }
  });

  it('NFR-03: --backup null is a version id like any other, never "latest"', async () => {
    const r = await run(
      RESTORE,
      ['--target-db', 'vnull', '--backup', 'null', '--skip-erasures'],
      env,
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not exist/);
  });

  it('NFR-03: metadata that is missing or hostile stops the restore before the server is touched', async () => {
    const newest = s3.versions.get(KEY).at(-1);
    const original = { ...newest.meta };
    const originalCurrent = s3.metas.get(KEY);
    for (const [patch, pattern] of [
      [{ sha256: 'nothex' }, /no checksum/],
      [{ counts: 'a=1;x' }, /no row counts/],
      [{ 'dumped-at': 'yesterday' }, /no dump time/],
    ]) {
      newest.meta = { ...original, ...patch };
      s3.metas.set(KEY, newest.meta);
      const r = await run(RESTORE, ['--target-db', 'vbad', '--skip-erasures'], env);
      assert.equal(r.status, 1, JSON.stringify(patch));
      assert.match(r.stderr, pattern);
    }
    newest.meta = original;
    s3.metas.set(KEY, originalCurrent);
    assert.equal(
      pg.psql('postgres', "SELECT count(*) FROM pg_database WHERE datname = 'vbad'"),
      '0',
    );
  });

  it('C-55: erasure-list.sh prune refuses in versioned mode (the owner-applied function prunes)', async () => {
    const r = await run(ERASURES, ['prune', stampDaysAgo(1)], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BACKUP_MODE=timestamped only/);
  });
});
