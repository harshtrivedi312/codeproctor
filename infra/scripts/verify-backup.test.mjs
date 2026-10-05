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
    assert.equal((await run(BACKUP, [], { ...base, BACKUP_RETENTION_DAYS: '0' })).status, 1);
    assert.match(
      (await run(BACKUP, [], { ...base, BACKUP_RETENTION_DAYS: '1; rm' })).stderr,
      /whole number/,
    );
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

  it('restore.sh needs a dump file name, not a path', async () => {
    const r = await run(RESTORE, ['--target-db', 'x', '--backup', '../../etc/passwd'], {
      PGHOST: 'localhost',
      PGUSER: 'u',
      S3_BACKUP_BUCKET: 'b',
    });
    assert.equal(r.status, 1);
  });

  it('FR-704: the erasure list takes uuids only', async () => {
    const env = { S3_BACKUP_BUCKET: 'b' };
    assert.match((await run(ERASURES, ['append', 'not-a-uuid'], env)).stderr, /candidate uuid/);
    assert.match(
      (await run(ERASURES, ['append', ERASED_ID, 'yesterday'], env)).stderr,
      /time must look like/,
    );
    assert.match((await run(ERASURES, ['prune', 'x'], env)).stderr, /UTC stamp/);
  });

  it('BACKUP_PREFIX cannot climb out with ..', async () => {
    const r = await run(ERASURES, ['list'], { S3_BACKUP_BUCKET: 'b', BACKUP_PREFIX: '../x' });
    assert.equal(r.status, 1);
  });
});

const skip = drillUnavailable() ?? false;
if (skip) console.log(`# DB-07 restore drill skipped: ${skip}`);

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
      PG_BIN_DIR: clientShims(pg, mkdtempSync(join(tmpdir(), 'pg-shims-'))),
    };
  });

  after(async () => {
    pg?.stop();
    await s3?.close();
  });

  const keys = () => [...s3.objects.keys()].map((k) => k.replace('drill-backups/', ''));
  const put = (key) => s3.objects.set(`drill-backups/${key}`, Buffer.from('x'));

  it('NFR-03: uploads dump, checksum and counts, prunes dumps past 14 days, keeps the newest', async () => {
    const old = stampDaysAgo(20);
    const recent = stampDaysAgo(3);
    put(`db/dumps/codeproctor-${old}.dump.gz`);
    put(`db/dumps/codeproctor-${old}.dump.gz.sha256`);
    put(`db/dumps/codeproctor-${recent}.dump.gz`);
    const before = new Date();
    const r = await run(BACKUP, [], env);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(SECRET));
    const k = keys();
    const today = before.toISOString().slice(0, 10).replace(/-/g, '');
    assert.ok(
      k.some((x) => new RegExp(`^db/dumps/codeproctor-${today}T\\d{6}Z\\.dump\\.gz$`).test(x)),
    );
    assert.ok(k.some((x) => x.endsWith('.dump.gz.sha256') && x.includes(today)));
    assert.ok(k.some((x) => x.endsWith('.counts.tsv') && x.includes(today)));
    assert.ok(!k.some((x) => x.includes(old)), '20-day-old dump pruned');
    assert.ok(
      k.some((x) => x.includes(recent)),
      '3-day-old dump kept',
    );
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

  it('NFR-03: restore never goes over an existing database', async () => {
    const r = await run(RESTORE, ['--target-db', restored], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists/);
    assert.equal(pg.psql(restored, 'SELECT count(*) FROM candidates'), '2');
  });

  it('NFR-03: a damaged backup is refused before the server is touched', async () => {
    const dump = keys()
      .filter((k) => /dump\.gz$/.test(k))
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

  it('ADR 0004 R-7: pruning drops erasure entries older than the oldest remaining backup, keeps newer ones', async () => {
    put(`db/erasure-list/${stampDaysAgo(40)}-33333333-3333-4333-8333-333333333333.json`);
    const r = await run(BACKUP, [], env);
    assert.equal(r.status, 0, r.stderr);
    const list = (await run(ERASURES, ['list'], env)).stdout;
    assert.doesNotMatch(list, /33333333-3333/);
    assert.match(list, new RegExp(ERASED_ID));
  });
});

describe('DB-07 version check (NFR-03)', () => {
  it('backup.sh refuses a pg_dump whose major version differs from the server', async () => {
    const skipHere = drillUnavailable() ?? false;
    if (skipHere) return;
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
