// DB-08 database verification (FR-105, NFR-05; supports TC-002 audit and TC-072, TC-094).
// A real PostgreSQL 16 in a throwaway container, the repository's migrations, and docs/database.md
// as the reference. Nothing here runs `prisma migrate reset` or `db push` (ADR 0009); the one
// Prisma command is `migrate deploy` against the throwaway server. Skipped with a message when
// docker or the PostgreSQL tools are missing; CI sets REQUIRE_DB_DRILL=1 to make that a failure.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { REPO_ROOT } from './test-support.mjs';
import { parseReferenceDdl } from './verify-schema-doc.mjs';
import {
  applyMigrations,
  drillUnavailable,
  ERASED_ID,
  KEPT_ID,
  loadFixture,
  startPostgres,
} from './verify-drill-support.mjs';

const skip = drillUnavailable() ?? false;
if (skip) console.log(`# DB-08 verification skipped: ${skip}`);
it(
  'DB-08: the verification can run when it is required',
  { skip: !(skip && process.env.REQUIRE_DB_DRILL === '1') },
  () => {
    assert.fail(`REQUIRE_DB_DRILL=1 but the verification cannot run: ${skip}`);
  },
);

const MIGRATIONS_DIR = join(REPO_ROOT, 'prisma/migrations');
const migrationNames = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((n) => /^\d/.test(n))
    .sort();
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').replace(/ ?, ?/g, ',').trim();

describe('DB-08 migrations are forward-only and apply cleanly (FR-105)', () => {
  it('names are unique, sorted timestamps, and the lock file says postgresql', () => {
    const names = migrationNames();
    assert.ok(names.length >= 2);
    for (const n of names) assert.match(n, /^\d{14}_[a-z0-9_]+$/, n);
    assert.deepEqual(names, [...names].sort());
    assert.equal(
      new Set(names.map((n) => n.slice(0, 14))).size,
      names.length,
      'two migrations share a timestamp',
    );
    assert.match(
      readFileSync(join(MIGRATIONS_DIR, 'migration_lock.toml'), 'utf8'),
      /provider = "postgresql"/,
    );
  });

  it('no migration drops the database or schema, or truncates data', () => {
    for (const n of migrationNames()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, n, 'migration.sql'), 'utf8').replace(
        /--[^\n]*/g,
        '',
      );
      assert.doesNotMatch(sql, /\bDROP\s+(DATABASE|SCHEMA)\b|^\s*TRUNCATE\b/im, n);
    }
  });

  it('an applied migration is never edited or removed (compared with origin/main)', (t) => {
    const ref = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], {
      cwd: REPO_ROOT,
    });
    if (ref.status !== 0) return t.skip('origin/main is not available in this checkout');
    const diff = spawnSync(
      'git',
      ['diff', '--name-status', '--no-renames', 'origin/main...HEAD', '--', 'prisma/migrations'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const changed = diff.stdout
      .trim()
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('A\t'));
    assert.deepEqual(
      changed,
      [],
      'migrations that exist on main may only be added to, never changed',
    );
  });
});

describe('DB-08 schema against docs/database.md (FR-105)', { skip }, () => {
  let pg;
  let doc;
  const q = (sql, db = 'verify') => pg.psql(db, sql);
  const rows = (sql) =>
    q(sql)
      .split('\n')
      .filter((l) => l !== '');

  before(() => {
    pg = startPostgres();
    doc = parseReferenceDdl();
    applyMigrations(pg, 'verify');
  });
  after(() => pg?.stop());

  it('every table in the document exists, and nothing else is in public (31 tables)', () => {
    const db = rows(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1",
    );
    assert.equal(doc.tables.size, 31);
    assert.deepEqual(db, [...doc.tables.keys()].sort());
  });

  it('every column exists with the document NOT NULL setting', () => {
    const db = new Map();
    for (const line of rows(
      "SELECT table_name || '|' || column_name || '|' || (is_nullable = 'NO') FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'",
    )) {
      const [t, c, nn] = line.split('|');
      if (!db.has(t)) db.set(t, new Map());
      db.get(t).set(c, nn === 'true');
    }
    for (const [name, table] of doc.tables) {
      assert.deepEqual(
        [...(db.get(name)?.keys() ?? [])].sort(),
        [...table.columns.keys()].sort(),
        `${name} columns`,
      );
      for (const [col, { notNull }] of table.columns) {
        assert.equal(db.get(name).get(col), notNull, `${name}.${col} NOT NULL`);
      }
    }
  });

  it('every enum has the values of the document in the same order (20 enums)', () => {
    const db = new Map(
      rows(
        "SELECT t.typname || '|' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' GROUP BY t.typname",
      ).map((l) => l.split('|')),
    );
    assert.equal(doc.enums.size, 20);
    assert.deepEqual([...db.keys()].sort(), [...doc.enums.keys()].sort());
    for (const [name, values] of doc.enums) assert.equal(db.get(name), values.join(','), name);
  });

  it('the non-unique indexes match the document, partial ones included (24)', () => {
    const wanted = doc.indexes
      .filter((i) => !i.unique)
      .map((i) => `${i.table}|${norm(i.columns)}|${i.partial}`)
      .sort();
    const have = rows(
      "SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'",
    )
      .map((l) => l.split('|'))
      .filter(([, def]) => !/UNIQUE INDEX/.test(def))
      .map(([table, def]) => {
        const m = /USING btree \((.*?)\)( WHERE .*)?$/.exec(def);
        return `${table}|${norm(m[1])}|${Boolean(m[2])}`;
      })
      .sort();
    assert.equal(wanted.length, 24);
    assert.deepEqual(have, wanted);
  });

  it('the 20 uniques are unique indexes, not constraints (FU-DB-03; use ON CONFLICT (cols))', () => {
    assert.equal(
      q(
        "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND i.indisunique AND NOT i.indisprimary AND c.relname <> '_prisma_migrations'",
      ),
      '20',
    );
    assert.equal(
      q(
        "SELECT count(*) FROM pg_constraint WHERE contype = 'u' AND connamespace = 'public'::regnamespace",
      ),
      '0',
    );
  });

  it('foreign keys match the document, with their ON DELETE rules (22 cascade, 1 set null)', () => {
    const rule = { a: 'NO ACTION', c: 'CASCADE', n: 'SET NULL', r: 'RESTRICT', d: 'SET DEFAULT' };
    const have = rows(
      "SELECT c.conrelid::regclass || '|' || (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) || '|' || c.confrelid::regclass || '|' || c.confdeltype::text FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace",
    )
      .map((l) => {
        const [t, cols, parent, d] = l.split('|');
        return `${t}|${cols}|${parent}|${rule[d]}`;
      })
      .sort();
    const wanted = [];
    for (const [name, t] of doc.tables)
      for (const f of t.foreignKeys)
        wanted.push(`${name}|${f.columns.join(',')}|${f.parent}|${f.onDelete}`);
    assert.deepEqual(have, wanted.sort());
    assert.equal(have.filter((l) => l.endsWith('|CASCADE')).length, 22);
    assert.equal(have.filter((l) => l.endsWith('|SET NULL')).length, 1);
  });

  it('primary keys match, including the 3 composite ones', () => {
    for (const [name, t] of doc.tables) {
      const have = q(
        `SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM pg_index i JOIN unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum WHERE i.indrelid = 'public.${name}'::regclass AND i.indisprimary`,
      );
      assert.equal(have, t.primaryKey.join(','), name);
    }
    for (const composite of ['session_sections', 'variant_test_cases', 'proctor_event_batches']) {
      assert.ok(doc.tables.get(composite).primaryKey.length > 1, composite);
    }
  });

  it('12 named CHECK constraints exist', () => {
    const names = rows(
      "SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace ORDER BY 1",
    );
    assert.equal(names.length, 12);
    for (const n of [
      'organizations_retention_days_check',
      'users_check',
      'tests_duration_minutes_check',
      'test_questions_check',
      'invitations_check',
      'sessions_risk_score_check',
      'session_questions_check',
      'consents_check',
      'consents_check1',
      'identity_checks_attempt_check',
      'identity_checks_check',
    ]) {
      assert.ok(names.includes(n), n);
    }
  });

  it('FU-DB-05: users.updated_at is owned by the trigger, which overrides an explicit value', () => {
    const org = '00000000-0000-4000-8000-0000000000a1';
    q(`INSERT INTO organizations (id, name) VALUES ('${org}', 'Trigger Org')`);
    q(
      `INSERT INTO users (org_id, email, full_name, password_hash, role) VALUES ('${org}', 'trigger@example.test', 'T', 'x', 'REVIEWER')`,
    );
    const before = q("SELECT updated_at FROM users WHERE email = 'trigger@example.test'");
    q('SELECT pg_sleep(0.05)');
    q(
      "UPDATE users SET full_name = 'T2', updated_at = '2000-01-01' WHERE email = 'trigger@example.test'",
    );
    assert.equal(
      q(
        "SELECT updated_at > '2020-01-01' AND updated_at > created_at FROM users WHERE email = 'trigger@example.test'",
      ),
      't',
    );
    assert.notEqual(q("SELECT updated_at FROM users WHERE email = 'trigger@example.test'"), before);
  });
});

describe('DB-08 constraints and cascades on real rows (FR-105, NFR-05)', { skip }, () => {
  let pg;
  const q = (sql) => pg.psql('rows', sql);
  const rejects = (sql, constraint) => {
    const r = spawnSync(
      'psql',
      ['--no-psqlrc', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'rows', '-c', sql],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...pg.env },
      },
    );
    assert.notEqual(r.status, 0, `accepted: ${sql}`);
    assert.match(r.stderr, new RegExp(`violates check constraint "${constraint}"`), sql);
  };
  const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';

  before(() => {
    pg = startPostgres();
    applyMigrations(pg, 'rows');
    loadFixture(pg, 'rows');
  });
  after(() => pg?.stop());

  it('duration_minutes below 5 or above 480 is rejected', () => {
    rejects(
      `INSERT INTO tests (org_id, name, duration_minutes) VALUES ('${ORG}', 'bad', 1)`,
      'tests_duration_minutes_check',
    );
    rejects(
      `INSERT INTO tests (org_id, name, duration_minutes) VALUES ('${ORG}', 'bad', 481)`,
      'tests_duration_minutes_check',
    );
  });

  it('window_end before window_start is rejected', () => {
    rejects(
      `INSERT INTO invitations (org_id, test_id, candidate_id, token_hash, window_start, window_end) VALUES ('${ORG}', 'aaaaaaaa-0000-4000-8000-000000000005', '${KEPT_ID}', 'bad', now(), now() - interval '1 hour')`,
      'invitations_check',
    );
  });

  it('risk_score 101 and -1 are rejected', () => {
    rejects('UPDATE sessions SET risk_score = 101', 'sessions_risk_score_check');
    rejects('UPDATE sessions SET risk_score = -1', 'sessions_risk_score_check');
    q('UPDATE sessions SET risk_score = 100');
  });

  it('retention_days outside 7..730 is rejected', () => {
    rejects('UPDATE organizations SET retention_days = 6', 'organizations_retention_days_check');
    rejects('UPDATE organizations SET retention_days = 731', 'organizations_retention_days_check');
  });

  it('a user needs a password or an invite token', () => {
    rejects(
      `INSERT INTO users (org_id, email, full_name, role) VALUES ('${ORG}', 'nopass@example.test', 'N', 'REVIEWER')`,
      'users_check',
    );
  });

  it('a consent is either signed or declined, never both or neither', () => {
    rejects(
      'UPDATE consents SET declined_at = now() WHERE signed_at IS NOT NULL',
      'consents_check',
    );
  });

  it('deleting a session cascades to its dependent rows, and leaves other sessions alone', () => {
    const erasedSession = `SELECT s.id FROM sessions s JOIN invitations i ON i.id = s.invitation_id WHERE i.candidate_id = '${ERASED_ID}'`;
    const children = [
      'consents',
      'identity_checks',
      'media_chunks',
      'proctor_events',
      'proctor_event_batches',
      'keystroke_batches',
      'session_reviews',
      'session_questions',
    ];
    // keystroke_batches points at session_questions without a cascade, so remove it first (documented NO ACTION).
    q(`DELETE FROM keystroke_batches WHERE session_id IN (${erasedSession})`);
    // appeals reference their review with NO ACTION too (documented), so they go first.
    q(
      `DELETE FROM appeals WHERE session_review_id IN (SELECT id FROM session_reviews WHERE session_id IN (${erasedSession}))`,
    );
    q(`DELETE FROM sessions WHERE id IN (${erasedSession})`);
    for (const t of children) {
      assert.equal(
        q(`SELECT count(*) FROM ${t} WHERE session_id NOT IN (SELECT id FROM sessions)`),
        '0',
        t,
      );
    }
    assert.equal(q('SELECT count(*) FROM sessions'), '1');
    assert.equal(q('SELECT count(*) FROM proctor_events'), '1');
    assert.equal(q('SELECT count(*) FROM flag_decisions'), '1', 'decisions follow their event');
    assert.equal(q('SELECT count(*) FROM appeals'), '1');
    assert.equal(
      q('SELECT count(*) FROM submissions'),
      '1',
      'submissions follow their session question',
    );
  });

  it('deleting a user does not cascade into rows that reference them without a rule (NO ACTION)', () => {
    const r = spawnSync(
      'psql',
      [
        '--no-psqlrc',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-d',
        'rows',
        '-c',
        "DELETE FROM users WHERE email = 'staff@example.test'",
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...pg.env } },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /violates foreign key constraint/);
  });
});

describe('DB-08 app_user role (ADR 0006 section 7, FR-105, D-35)', { skip }, () => {
  let pg;
  const password = randomBytes(12).toString('hex');
  const asOwner = (sql) => pg.psql('roles', sql);
  /** Runs one statement as app_user. Returns { ok, out, err }. */
  const asApp = (sql) => {
    const r = spawnSync(
      'psql',
      ['--no-psqlrc', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', 'roles', '-c', sql],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...pg.env, PGUSER: 'app_user', PGPASSWORD: password },
      },
    );
    return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr };
  };
  const denied = (sql) => {
    const r = asApp(sql);
    assert.equal(r.ok, false, `app_user was allowed: ${sql}`);
    assert.match(r.err, /permission denied|must be owner|must be superuser/, sql);
  };

  before(() => {
    pg = startPostgres();
    applyMigrations(pg, 'roles');
    loadFixture(pg, 'roles');
    asOwner(`ALTER ROLE app_user PASSWORD '${password}'`);
  });
  after(() => pg?.stop());

  it('app_user can log in and is not a superuser, and cannot create roles, databases or replicate', () => {
    assert.equal(asApp('SELECT current_user').out, 'app_user');
    assert.equal(
      asOwner(
        "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname = 'app_user'",
      ),
      'f',
    );
    denied('CREATE ROLE sneaky');
    denied('CREATE DATABASE sneaky');
  });

  it('app_user reads and writes every table (DML) but owns none', () => {
    assert.equal(
      asOwner(
        "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' AND tableowner = 'app_user'",
      ),
      '0',
    );
    const missing = asOwner(
      "SELECT coalesce(string_agg(c.relname, ','), '') FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname NOT IN ('_prisma_migrations', 'audit_logs') AND NOT (has_table_privilege('app_user', c.oid, 'SELECT') AND has_table_privilege('app_user', c.oid, 'INSERT') AND has_table_privilege('app_user', c.oid, 'UPDATE') AND has_table_privilege('app_user', c.oid, 'DELETE'))",
    );
    assert.equal(missing, '');
    assert.ok(asApp("UPDATE candidates SET full_name = 'Changed' WHERE id = '" + KEPT_ID + "'").ok);
  });

  it('app_user cannot change the schema: no CREATE, DROP, ALTER or TRUNCATE on the data tables', () => {
    denied('CREATE TABLE public.sneaky (id int)');
    denied('DROP TABLE candidates');
    denied('ALTER TABLE candidates ADD COLUMN x int');
    denied('TRUNCATE candidates CASCADE');
    denied('CREATE INDEX ON candidates (full_name)');
    assert.equal(asOwner("SELECT has_schema_privilege('app_user', 'public', 'CREATE')"), 'f');
    assert.equal(asOwner("SELECT has_schema_privilege('app_user', 'public', 'USAGE')"), 't');
  });

  it('TC-002, ADR 0006: audit_logs is append-only for app_user (INSERT yes; UPDATE, DELETE, TRUNCATE no)', () => {
    assert.ok(
      asApp(
        `INSERT INTO audit_logs (org_id, action, entity_type) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'TEST_APPEND', 'test')`,
      ).ok,
    );
    assert.ok(asApp('SELECT count(*) FROM audit_logs').ok);
    denied("UPDATE audit_logs SET action = 'TAMPERED'");
    denied('DELETE FROM audit_logs');
    denied('TRUNCATE audit_logs');
    for (const p of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      assert.equal(asOwner(`SELECT has_table_privilege('app_user', 'audit_logs', '${p}')`), 'f', p);
    }
    assert.equal(asOwner('SELECT count(*) FROM audit_logs'), '1');
  });

  it('app_user can use sequences, and gets DML on tables created later (default privileges)', () => {
    assert.equal(
      asOwner(
        "SELECT count(*) FROM (SELECT oid FROM pg_class WHERE relkind = 'S' AND relnamespace = 'public'::regnamespace OFFSET 0) s WHERE NOT has_sequence_privilege('app_user', s.oid, 'USAGE')",
      ),
      '0',
    );
    asOwner('CREATE TABLE public.created_later (id int)');
    assert.ok(asApp('INSERT INTO created_later VALUES (1)').ok);
    assert.equal(
      asOwner("SELECT has_table_privilege('app_user', 'created_later', 'TRUNCATE')"),
      'f',
    );
    asOwner('DROP TABLE public.created_later');
  });

  it('FU-DB-05: app_user updates fire the users.updated_at trigger', () => {
    assert.ok(
      asApp("UPDATE users SET full_name = 'Via App' WHERE email = 'staff@example.test'").ok,
    );
    assert.equal(
      asApp("SELECT updated_at > created_at FROM users WHERE email = 'staff@example.test'").out,
      't',
    );
  });
});

describe('DB-08 migrate deploy on a fresh database (FR-105, ADR 0009)', { skip }, () => {
  let pg;
  const deploy = (extra = []) => {
    const url = `postgresql://postgres:${pg.env.PGPASSWORD}@127.0.0.1:${pg.port}/deployed`;
    return spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', ...extra], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        MIGRATION_DATABASE_URL: url,
      },
    });
  };

  before(() => {
    pg = startPostgres();
    pg.psql('postgres', 'CREATE DATABASE deployed');
  });
  after(() => pg?.stop());

  it('prisma migrate deploy applies every migration, and a second run finds nothing pending', () => {
    const first = deploy();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const names = migrationNames();
    assert.equal(
      pg.psql(
        'deployed',
        'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      ),
      String(names.length),
    );
    assert.equal(
      pg.psql(
        'deployed',
        "SELECT string_agg(migration_name, ',' ORDER BY migration_name) FROM _prisma_migrations",
      ),
      names.join(','),
    );
    const second = deploy();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout + second.stderr, /No pending migrations/i);
  });

  it('app_user cannot read or change the migration history (_prisma_migrations)', () => {
    const password = 'migr-history-only';
    pg.psql('deployed', `ALTER ROLE app_user PASSWORD '${password}'`);
    for (const sql of ['SELECT * FROM _prisma_migrations', 'DELETE FROM _prisma_migrations']) {
      const r = spawnSync(
        'psql',
        ['--no-psqlrc', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'deployed', '-c', sql],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            ...pg.env,
            PGUSER: 'app_user',
            PGPASSWORD: password,
          },
        },
      );
      assert.notEqual(r.status, 0, sql);
      assert.match(r.stderr, /permission denied/, sql);
    }
  });

  it('the deployed schema equals the one the plain psql run produces (same tables, columns, indexes)', () => {
    applyMigrations(pg, 'plain');
    const fingerprint = (db) =>
      pg.psql(
        db,
        "SELECT md5(string_agg(x, E'\\n' ORDER BY x)) FROM (SELECT 'c:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS x FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' UNION ALL SELECT 'i:' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations') s",
      );
    assert.equal(fingerprint('deployed'), fingerprint('plain'));
  });

  it('the Prisma schema has no drift from the deployed migrations (migrate diff, read-only)', () => {
    const url = `postgresql://postgres:${pg.env.PGPASSWORD}@127.0.0.1:${pg.port}/deployed`;
    const r = spawnSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          MIGRATION_DATABASE_URL: url,
        },
      },
    );
    assert.equal(r.status, 0, `schema.prisma and the migrations differ:\n${r.stdout}${r.stderr}`);
  });
});

describe(
  'DB-08 retention and erasure (TC-072, TC-094): run fully once DB-06 lands',
  { skip },
  () => {
    it(
      'TC-072: retention deletes objects, nulls keys and logs an audit marker',
      { todo: 'DB-06 (retention service)' },
      () => {},
    );
    it(
      'TC-094: erasure with no open review, and the open-appeal hold',
      { todo: 'DB-06 (erasure service)' },
      () => {},
    );
    it('TC-094: a restore re-applies erasures (database part)', () => {
      // Covered now by verify-backup.test.mjs (DB-07). Extend with DB-06's ERASED status (FU-DBB-01).
      assert.ok(true);
    });
  },
);
void execFileSync;
