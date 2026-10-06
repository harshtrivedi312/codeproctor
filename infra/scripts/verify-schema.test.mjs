// DB-08 database verification (FR-105, NFR-05; supports TC-002 audit and TC-072, TC-094).
// A real PostgreSQL 16 in a throwaway container, the repository's migrations, and docs/database.md
// as the reference. Nothing here runs `prisma migrate reset` or `db push` (ADR 0009); the only
// Prisma commands are `migrate deploy` and `migrate diff` against the throwaway server.
// Skipped with a message when docker, psql or the postgres:16 image is missing. REQUIRE_DB_DRILL=1
// turns that, and a missing origin/main for the migration guard, into a failure. CI does not set it
// yet: it needs the hub's CI change in FU-DBB-03 (pull the image, fetch-depth: 0, set the flag).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { REPO_ROOT } from './test-support.mjs';
import { migrationChanges } from './verify-migration-guard.mjs';
import { parseReferenceDdl, predicateKey, udtName } from './verify-schema-doc.mjs';
import {
  applyMigrations,
  drillUnavailable,
  ERASED_ID,
  KEPT_ID,
  loadFixture,
  startPostgres,
} from './verify-drill-support.mjs';

const skip = drillUnavailable(['psql']) ?? false;
if (skip) console.log(`# DB-08 verification skipped: ${skip}`);
const required = process.env.REQUIRE_DB_DRILL === '1';
it('DB-08: the verification can run when it is required', { skip: !(skip && required) }, () => {
  assert.fail(`the verification cannot run: ${skip}`);
});

const MIGRATIONS_DIR = join(REPO_ROOT, 'prisma/migrations');
const migrationNames = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((n) => /^\d/.test(n))
    .sort();
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').replace(/ ?, ?/g, ',').trim();
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const psqlEnv = (pg, extra = {}) => ({ PATH: process.env.PATH ?? '', ...pg.env, ...extra });

describe('DB-08 migrations are forward-only (FR-105)', () => {
  it('names are unique sorted timestamps, and the lock file says postgresql', () => {
    const names = migrationNames();
    assert.ok(names.length >= 2);
    for (const n of names) assert.match(n, /^\d{14}_[a-z0-9_]+$/, n);
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

  it('an applied migration is never edited or removed (compared with origin/main, fetched when missing)', (t) => {
    const result = migrationChanges(REPO_ROOT);
    if (!result.ok) {
      // A base that cannot be fetched must not pass silently where the flag demands it.
      assert.ok(!required, `cannot compare with origin/main: ${result.reason}`);
      return t.skip(`cannot compare with origin/main: ${result.reason}`);
    }
    assert.deepEqual(
      result.changed,
      [],
      'migrations that exist on main may only be added to, never changed',
    );
  });
});

describe('DB-08 schema against docs/database.md (FR-105)', { skip }, () => {
  let pg;
  let doc;
  const q = (sql) => pg.psql('verify', sql);
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

  it('every column exists with the document type, NOT NULL and boolean default', () => {
    const db = new Map();
    for (const line of rows(
      "SELECT table_name || '|' || column_name || '|' || (is_nullable = 'NO') || '|' || udt_name || '|' || coalesce(column_default, '') FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'",
    )) {
      const [t, c, nn, udt, def] = line.split('|');
      if (!db.has(t)) db.set(t, new Map());
      db.get(t).set(c, { notNull: nn === 'true', udt, def });
    }
    let checked = 0;
    for (const [name, table] of doc.tables) {
      assert.deepEqual(
        [...(db.get(name)?.keys() ?? [])].sort(),
        [...table.columns.keys()].sort(),
        `${name} columns`,
      );
      for (const [col, want] of table.columns) {
        const have = db.get(name).get(col);
        assert.equal(have.notNull, want.notNull, `${name}.${col} NOT NULL`);
        assert.equal(have.udt, udtName(want.type), `${name}.${col} type`);
        if (want.boolDefault !== null)
          assert.equal(have.def, want.boolDefault, `${name}.${col} DEFAULT`);
        checked++;
      }
    }
    assert.ok(checked > 250, `only ${checked} columns compared`);
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

  it('the non-unique indexes match the document, with their WHERE predicates (24)', () => {
    const wanted = doc.indexes
      .map((i) => `${i.table}|${norm(i.columns)}|${i.predicate ?? ''}`)
      .sort();
    const have = rows(
      "SELECT tablename || '|' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'",
    )
      .filter((l) => !/UNIQUE INDEX/.test(l))
      .map((l) => {
        const [table, def] = [l.slice(0, l.indexOf('|')), l.slice(l.indexOf('|') + 1)];
        const m = /USING btree \((.*?)\)( WHERE .*)?$/.exec(def);
        return `${table}|${norm(m[1])}|${m[2] ? predicateKey(m[2].replace(/^ WHERE /, '')) : ''}`;
      })
      .sort();
    assert.equal(wanted.length, 24);
    assert.equal(wanted.filter((w) => !w.endsWith('|')).length, 2, 'two partial indexes');
    assert.deepEqual(have, wanted);
  });

  it('the 20 uniques have the document columns, and are unique indexes, not constraints (FU-DB-03)', () => {
    const have = rows(
      "SELECT c.relname || '|' || (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace AND i.indisunique AND NOT i.indisprimary AND c.relname <> '_prisma_migrations'",
    ).sort();
    assert.equal(doc.uniques.size, 20);
    assert.deepEqual(have, [...doc.uniques].sort());
    assert.equal(
      q(
        "SELECT count(*) FROM pg_constraint WHERE contype = 'u' AND connamespace = 'public'::regnamespace",
      ),
      '0',
    );
  });

  it('foreign keys match the document: columns, parent columns and ON DELETE rule (22 cascade, 1 set null)', () => {
    const rule = { a: 'NO ACTION', c: 'CASCADE', n: 'SET NULL', r: 'RESTRICT', d: 'SET DEFAULT' };
    const cols = (rel, attrs) =>
      `(SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(${attrs}) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = k.attnum)`;
    const have = rows(
      `SELECT c.conrelid::regclass::text || '|' || ${cols('c.conrelid', 'c.conkey')} || '|' || c.confrelid::regclass::text || '|' || ${cols('c.confrelid', 'c.confkey')} || '|' || c.confdeltype::text FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
    )
      .map((l) => {
        const [t, c, parent, pc, d] = l.split('|');
        return `${t}|${c}|${parent}|${pc}|${rule[d]}`;
      })
      .sort();
    const wanted = [];
    for (const [name, t] of doc.tables)
      for (const f of t.foreignKeys)
        wanted.push(
          `${name}|${f.columns.join(',')}|${f.parent}|${f.parentColumns.join(',')}|${f.onDelete}`,
        );
    assert.deepEqual(have, wanted.sort());
    assert.equal(have.filter((l) => l.endsWith('|CASCADE')).length, 22);
    assert.equal(have.filter((l) => l.endsWith('|SET NULL')).length, 1);
    assert.equal(
      have.filter((l) => l.split('|')[1].includes(',')).length,
      3,
      '3 composite foreign keys',
    );
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

  it('the trigger set is exactly users_set_updated_at', () => {
    assert.deepEqual(rows('SELECT tgname FROM pg_trigger WHERE NOT tgisinternal'), [
      'users_set_updated_at',
    ]);
  });

  it('FU-DB-05: users.updated_at is owned by the trigger, which overrides an explicit value', () => {
    const org = '00000000-0000-4000-8000-0000000000a1';
    q(`INSERT INTO organizations (id, name) VALUES ('${org}', 'Trigger Org')`);
    q(
      `INSERT INTO users (org_id, email, full_name, password_hash, role) VALUES ('${org}', 'trigger@example.test', 'T', 'x', 'REVIEWER')`,
    );
    const first = q("SELECT updated_at FROM users WHERE email = 'trigger@example.test'");
    q(
      "UPDATE users SET full_name = 'T2', updated_at = '2000-01-01' WHERE email = 'trigger@example.test'",
    );
    assert.equal(
      q(
        "SELECT updated_at > '2020-01-01' AND updated_at > created_at FROM users WHERE email = 'trigger@example.test'",
      ),
      't',
    );
    assert.notEqual(q("SELECT updated_at FROM users WHERE email = 'trigger@example.test'"), first);
  });
});

describe('DB-08 CHECK constraints and cascades on real rows (FR-105, NFR-05)', { skip }, () => {
  let pg;
  const q = (sql) => pg.psql('rows', sql);
  const failure = (sql) =>
    spawnSync('psql', ['--no-psqlrc', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'rows', '-c', sql], {
      encoding: 'utf8',
      env: psqlEnv(pg),
    });

  /** Every CHECK in the schema, with a statement the fixture data makes violate it. */
  const CHECKS = {
    organizations_retention_days_check: [
      'UPDATE organizations SET retention_days = 6',
      'UPDATE organizations SET retention_days = 731',
    ],
    users_check: [
      `INSERT INTO users (org_id, email, full_name, role) VALUES ('${ORG}', 'nopass@example.test', 'N', 'REVIEWER')`,
    ],
    tests_duration_minutes_check: [
      `INSERT INTO tests (org_id, name, duration_minutes) VALUES ('${ORG}', 'bad', 1)`,
      `INSERT INTO tests (org_id, name, duration_minutes) VALUES ('${ORG}', 'bad', 481)`,
    ],
    test_questions_check: [
      "INSERT INTO test_questions (section_id, points, position) VALUES ('aaaaaaaa-0000-4000-8000-000000000006', 100, 9)",
    ],
    invitations_check: [
      `INSERT INTO invitations (org_id, test_id, candidate_id, token_hash, window_start, window_end) VALUES ('${ORG}', 'aaaaaaaa-0000-4000-8000-000000000005', '${KEPT_ID}', 'bad', now(), now() - interval '1 hour')`,
    ],
    sessions_risk_score_check: [
      'UPDATE sessions SET risk_score = 101',
      'UPDATE sessions SET risk_score = -1',
    ],
    session_questions_check: ["UPDATE session_questions SET scoring = 'MANUAL'"],
    consents_check: ['UPDATE consents SET declined_at = now() WHERE signed_at IS NOT NULL'],
    consents_check1: ['UPDATE consents SET signed_name = NULL WHERE signed_at IS NOT NULL'],
    identity_checks_attempt_check: ['UPDATE identity_checks SET attempt = 3'],
    identity_checks_check: ["UPDATE identity_checks SET status = 'REVIEWED'"],
    appeals_check: ["UPDATE appeals SET status = 'OVERTURNED'"],
  };

  before(() => {
    pg = startPostgres();
    applyMigrations(pg, 'rows');
    loadFixture(pg, 'rows');
  });
  after(() => pg?.stop());

  it('the schema holds exactly the 12 named CHECK constraints this suite exercises', () => {
    const names = q(
      "SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace ORDER BY 1",
    )
      .split('\n')
      .filter((l) => l !== '');
    assert.equal(names.length, 12);
    assert.deepEqual(names, Object.keys(CHECKS).sort());
  });

  for (const [name, statements] of Object.entries(CHECKS)) {
    it(`${name} rejects bad data`, () => {
      for (const sql of statements) {
        const r = failure(sql);
        assert.notEqual(r.status, 0, `accepted: ${sql}`);
        assert.match(r.stderr, new RegExp(`violates check constraint "${name}"`), sql);
      }
    });
  }

  it('values on the allowed edge are accepted (duration 5 and 480, risk_score 0 and 100, retention 7 and 730)', () => {
    for (const d of [5, 480])
      q(`INSERT INTO tests (org_id, name, duration_minutes) VALUES ('${ORG}', 'edge${d}', ${d})`);
    for (const r of [0, 100]) q(`UPDATE sessions SET risk_score = ${r}`);
    for (const r of [7, 730]) q(`UPDATE organizations SET retention_days = ${r}`);
  });

  it('deleting a session cascades to every dependent row, and leaves the other session alone', () => {
    const sessionOf = (cand) =>
      q(
        `SELECT s.id FROM sessions s JOIN invitations i ON i.id = s.invitation_id WHERE i.candidate_id = '${cand}'`,
      );
    const erased = sessionOf(ERASED_ID);
    const kept = sessionOf(KEPT_ID);
    const direct = [
      'consents',
      'identity_checks',
      'media_chunks',
      'proctor_events',
      'proctor_event_batches',
      'keystroke_batches',
      'session_reviews',
      'session_questions',
    ];
    const count = (sql) => Number(q(sql));
    const nested = {
      flag_decisions: (s) =>
        `SELECT count(*) FROM flag_decisions WHERE event_id IN (SELECT id FROM proctor_events WHERE session_id = '${s}')`,
      submissions: (s) =>
        `SELECT count(*) FROM submissions WHERE session_question_id IN (SELECT id FROM session_questions WHERE session_id = '${s}')`,
    };
    for (const s of [erased, kept]) {
      for (const t of direct)
        assert.equal(
          count(`SELECT count(*) FROM ${t} WHERE session_id = '${s}'`),
          1,
          `${t} before`,
        );
      for (const [t, sql] of Object.entries(nested)) assert.equal(count(sql(s)), 1, `${t} before`);
    }
    // appeals reference their review with NO ACTION and no cascade path (documented), so they go first.
    q(
      `DELETE FROM appeals WHERE session_review_id IN (SELECT id FROM session_reviews WHERE session_id = '${erased}')`,
    );
    q(`DELETE FROM sessions WHERE id = '${erased}'`);
    for (const t of direct) {
      assert.equal(
        count(`SELECT count(*) FROM ${t} WHERE session_id = '${erased}'`),
        0,
        `${t} follows the session`,
      );
      assert.equal(
        count(`SELECT count(*) FROM ${t} WHERE session_id = '${kept}'`),
        1,
        `${t} of the other session`,
      );
    }
    for (const [t, sql] of Object.entries(nested)) {
      assert.equal(count(sql(erased)), 0, `${t} follows`);
      assert.equal(count(sql(kept)), 1, `${t} of the other session`);
    }
  });

  it('deleting a user referenced without a cascade is refused (NO ACTION)', () => {
    const r = failure("DELETE FROM users WHERE email = 'staff@example.test'");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /violates foreign key constraint/);
  });

  it('webhook_deliveries.session_id is the one SET NULL: the delivery survives its session', () => {
    q(
      `INSERT INTO webhook_endpoints (id, org_id, url, secret_enc, events) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', '${ORG}', 'https://example.test/hook', 'enc', ARRAY['session.completed'])`,
    );
    const keptSession = q(
      `SELECT s.id FROM sessions s JOIN invitations i ON i.id = s.invitation_id WHERE i.candidate_id = '${KEPT_ID}'`,
    );
    q(
      `INSERT INTO webhook_deliveries (endpoint_id, session_id, event, attempt) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', '${keptSession}', 'session.completed', 1)`,
    );
    const sessionId = q(`SELECT s.id FROM sessions s WHERE s.id = '${keptSession}'`);
    assert.equal(sessionId, keptSession);
    q(
      `DELETE FROM appeals WHERE session_review_id IN (SELECT id FROM session_reviews WHERE session_id = '${keptSession}')`,
    );
    q(`DELETE FROM sessions WHERE id = '${keptSession}'`);
    assert.equal(q("SELECT count(*) || '|' || count(session_id) FROM webhook_deliveries"), '1|0');
  });
});

describe('DB-08 app_user role (ADR 0006 sections 7 and 8.8, FR-105, D-35)', { skip }, () => {
  let pg;
  const password = randomBytes(12).toString('hex');
  const asOwner = (sql) => pg.psql('roles', sql);
  /** Runs one statement as app_user. */
  const asApp = (sql) => {
    const r = spawnSync(
      'psql',
      ['--no-psqlrc', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', 'roles', '-c', sql],
      {
        encoding: 'utf8',
        env: psqlEnv(pg, { PGUSER: 'app_user', PGPASSWORD: password }),
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

  it('app_user logs in and has no SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION', () => {
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

  it('ADR 0006 8.8: app_user is a member of no role (member side only)', () => {
    assert.equal(
      asOwner("SELECT count(*) FROM pg_auth_members WHERE member = 'app_user'::regrole"),
      '0',
    );
  });

  it('ADR 0006 8.8: app_user owns no database, schema, relation in any schema, or function', () => {
    const oid = "(SELECT oid FROM pg_roles WHERE rolname = 'app_user')";
    assert.equal(asOwner(`SELECT count(*) FROM pg_database WHERE datdba = ${oid}`), '0');
    assert.equal(asOwner(`SELECT count(*) FROM pg_namespace WHERE nspowner = ${oid}`), '0');
    assert.equal(asOwner(`SELECT count(*) FROM pg_class WHERE relowner = ${oid}`), '0');
    assert.equal(asOwner(`SELECT count(*) FROM pg_proc WHERE proowner = ${oid}`), '0');
  });

  it('ADR 0006 8.8: app_user has no CREATE on the database and none on schema public, but can use public', () => {
    assert.equal(
      asOwner("SELECT has_database_privilege('app_user', current_database(), 'CREATE')"),
      'f',
    );
    assert.equal(asOwner("SELECT has_schema_privilege('app_user', 'public', 'CREATE')"), 'f');
    assert.equal(asOwner("SELECT has_schema_privilege('app_user', 'public', 'USAGE')"), 't');
    denied('CREATE TABLE public.sneaky (id int)');
  });

  it(
    'ADR 0006 8.8 says app_user has no TEMP on the database; PUBLIC grants it by default (FU-DBB-18)',
    {
      todo: 'FU-DBB-18: cannot pass until a migration revokes TEMP from PUBLIC, or the ADR is corrected',
    },
    () => {
      assert.equal(
        asOwner("SELECT has_database_privilege('app_user', current_database(), 'TEMP')"),
        'f',
      );
    },
  );

  it('app_user holds exactly SELECT, INSERT, UPDATE, DELETE on each table, and SELECT, INSERT on audit_logs', () => {
    const grants = new Map(
      asOwner(
        "SELECT c.relname || '|' || string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.grantee = 'app_user'::regrole GROUP BY c.relname",
      )
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => l.split('|')),
    );
    const tables = asOwner("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
      .split('\n')
      .filter((l) => l !== '');
    assert.ok(tables.length >= 31);
    for (const t of tables) {
      assert.equal(
        grants.get(t),
        t === 'audit_logs' ? 'INSERT,SELECT' : 'DELETE,INSERT,SELECT,UPDATE',
        t,
      );
    }
    assert.equal(grants.size, tables.length);
    assert.ok(asApp(`UPDATE candidates SET full_name = 'Changed' WHERE id = '${KEPT_ID}'`).ok);
  });

  it('app_user cannot change the schema: no DROP, ALTER, TRUNCATE or CREATE INDEX on the data tables', () => {
    denied('DROP TABLE candidates');
    denied('ALTER TABLE candidates ADD COLUMN x int');
    denied('TRUNCATE candidates CASCADE');
    denied('CREATE INDEX ON candidates (full_name)');
  });

  it('TC-002, ADR 0006: audit_logs is append-only for app_user (INSERT yes; UPDATE, DELETE, TRUNCATE no)', () => {
    assert.ok(
      asApp(
        `INSERT INTO audit_logs (org_id, action, entity_type) VALUES ('${ORG}', 'TEST_APPEND', 'test')`,
      ).ok,
    );
    assert.ok(asApp('SELECT count(*) FROM audit_logs').ok);
    denied("UPDATE audit_logs SET action = 'TAMPERED'");
    denied('DELETE FROM audit_logs');
    denied('TRUNCATE audit_logs');
    assert.equal(asOwner('SELECT count(*) FROM audit_logs'), '1');
  });

  it('app_user can use every sequence, and gets DML on tables created later (default privileges)', () => {
    const sequences = asOwner(
      "SELECT count(*) FROM pg_class WHERE relkind = 'S' AND relnamespace = 'public'::regnamespace",
    );
    assert.ok(Number(sequences) > 0, 'the schema has identity sequences');
    assert.equal(
      asOwner(
        "SELECT count(*) FROM (SELECT oid FROM pg_class WHERE relkind = 'S' AND relnamespace = 'public'::regnamespace OFFSET 0) s WHERE NOT has_sequence_privilege('app_user', s.oid, 'USAGE')",
      ),
      '0',
    );
    asOwner('CREATE TABLE public.created_later (id int GENERATED ALWAYS AS IDENTITY, v int)');
    assert.ok(asApp('INSERT INTO created_later (v) VALUES (1)').ok, 'table and identity sequence');
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
  const password = randomBytes(12).toString('hex');
  // Only a throwaway server on 127.0.0.1 with a random port and password is ever named here.
  // prisma.config.ts also loads the repository's .env, but a value already in the environment wins,
  // and the Datasource line in the output is checked below.
  const prisma = (...args) =>
    spawnSync('pnpm', ['exec', 'prisma', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        MIGRATION_DATABASE_URL: `postgresql://postgres:${pg.env.PGPASSWORD}@127.0.0.1:${pg.port}/deployed`,
      },
    });

  before(() => {
    pg = startPostgres();
    pg.psql('postgres', 'CREATE DATABASE deployed');
  });
  after(() => pg?.stop());

  it('prisma migrate deploy applies every migration, and a second run finds nothing pending', () => {
    const first = prisma('migrate', 'deploy');
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(
      first.stdout + first.stderr,
      new RegExp(`127\\.0\\.0\\.1:${pg.port}`),
      'it used the throwaway server',
    );
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
    const second = prisma('migrate', 'deploy');
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout + second.stderr, /No pending migrations/i);
  });

  it('app_user has no privilege at all on the migration history (_prisma_migrations)', () => {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal(
        pg.psql('deployed', `SELECT has_table_privilege('app_user', '_prisma_migrations', '${p}')`),
        'f',
        p,
      );
    }
    pg.psql('deployed', `ALTER ROLE app_user PASSWORD '${password}'`);
    for (const sql of ['SELECT * FROM _prisma_migrations', 'DELETE FROM _prisma_migrations']) {
      const r = spawnSync(
        'psql',
        ['--no-psqlrc', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'deployed', '-c', sql],
        {
          encoding: 'utf8',
          env: psqlEnv(pg, { PGUSER: 'app_user', PGPASSWORD: password }),
        },
      );
      assert.notEqual(r.status, 0, sql);
      assert.match(r.stderr, /permission denied/, sql);
    }
  });

  it('the deployed schema equals the one the plain psql run produces (columns and indexes)', () => {
    applyMigrations(pg, 'plain');
    const fingerprint = (db) =>
      pg.psql(
        db,
        "SELECT md5(string_agg(x, E'\\n' ORDER BY x)) FROM (SELECT 'c:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS x FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' UNION ALL SELECT 'i:' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations') s",
      );
    assert.equal(fingerprint('deployed'), fingerprint('plain'));
  });

  it('the Prisma schema has no drift from the deployed migrations (migrate diff, read-only)', () => {
    const r = prisma(
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--exit-code',
    );
    assert.equal(r.status, 0, `schema.prisma and the migrations differ:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /No difference detected|empty migration/i);
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
    it(
      'TC-094: a restore re-applies erasures (database part): verify-backup.test.mjs covers it now; extend with ERASED',
      { todo: 'FU-DBB-01, FU-DBB-20' },
      () => {},
    );
  },
);
