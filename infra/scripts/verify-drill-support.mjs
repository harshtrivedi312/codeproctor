// Helpers for tests that need a real PostgreSQL 16: a throwaway container, the repository's
// migrations applied with psql (never prisma migrate reset or db push), and a small fixture.
// Not a test file. The container is published on a random 127.0.0.1 port, uses a random password
// and is removed by stop(). It is never the dev stack (CLAUDE.md rule 14).
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './test-support.mjs';

export const POSTGRES_IMAGE = 'postgres:16';

/** Why the drill cannot run here, or null. */
export function drillUnavailable(tools = ['psql', 'pg_dump', 'pg_restore', 'aws', 'gzip']) {
  for (const [cmd, args] of [['docker', ['info']], ...tools.map((t) => [t, ['--version']])]) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.error || r.status !== 0) return `${cmd} is not available`;
  }
  const img = spawnSync('docker', ['image', 'inspect', POSTGRES_IMAGE], { stdio: 'ignore' });
  if (img.status !== 0) return `${POSTGRES_IMAGE} is not pulled`;
  return null;
}

/** @returns {{ env: Record<string,string>, port: number, psql: (db: string, sql: string) => string, stop: () => void }} */
// Every container this process starts carries a label and is removed when the process exits,
// including after a failed test or an interrupt, so no drill container is left running.
const started = new Set();
const sweep = () => {
  for (const id of started) spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
  started.clear();
};
process.on('exit', sweep);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));

export function startPostgres() {
  const password = randomBytes(12).toString('hex');
  const id = execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--label',
      'codeproctor.drill=1',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-p',
      '127.0.0.1::5432',
      POSTGRES_IMAGE,
    ],
    { encoding: 'utf8' },
  ).trim();
  started.add(id);
  let portLine;
  try {
    portLine = execFileSync('docker', ['port', id, '5432/tcp'], { encoding: 'utf8' });
  } catch (error) {
    sweep();
    throw error;
  }
  const port = Number(portLine.trim().split('\n')[0].split(':').pop());
  const env = {
    PGHOST: '127.0.0.1',
    PGPORT: String(port),
    PGUSER: 'postgres',
    PGPASSWORD: password,
  };
  const psql = (db, sql) =>
    execFileSync(
      'psql',
      ['--no-psqlrc', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...env },
      },
    ).trim();
  // The image restarts once during init, so wait for a query on the final server.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const r = spawnSync('psql', ['--no-psqlrc', '-X', '-At', '-d', 'postgres', '-c', 'SELECT 1'], {
      env: { PATH: process.env.PATH ?? '', PGCONNECT_TIMEOUT: '3', ...env },
      encoding: 'utf8',
    });
    if (r.status === 0 && r.stdout.trim() === '1') break;
    if (Date.now() > deadline) {
      spawnSync('docker', ['rm', '-f', id]);
      throw new Error('throwaway postgres did not become ready');
    }
    spawnSync('sleep', ['1']);
  }
  return {
    id,
    env,
    port,
    psql,
    stop: () => {
      spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
      started.delete(id);
    },
  };
}

/** Applies every prisma/migrations/*\/migration.sql in order, as the superuser. */
export function applyMigrations(pg, db) {
  pg.psql('postgres', `CREATE DATABASE ${db}`);
  const dir = join(REPO_ROOT, 'prisma/migrations');
  for (const name of readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()) {
    execFileSync(
      'psql',
      [
        '--no-psqlrc',
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-d',
        db,
        '-f',
        join(dir, name, 'migration.sql'),
      ],
      { env: { PATH: process.env.PATH ?? '', ...pg.env }, stdio: ['ignore', 'ignore', 'inherit'] },
    );
  }
}

/**
 * A directory with pg_dump and pg_restore for the throwaway server's major version. When the
 * installed client already has that major version, the real ones are used; otherwise the shims
 * run the tools inside the container (a PostgreSQL 17 pg_dump writes SQL a 16 server rejects).
 * Returns the directory to put in PG_BIN_DIR, or '' for none.
 */
export function clientShims(pg, dir) {
  const major = Number(POSTGRES_IMAGE.split(':')[1]);
  const installed = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' }).stdout;
  mkdirSync(dir, { recursive: true });
  // A psql wrapper that fails when the arguments contain FAKE_PSQL_FAIL_ON, so a test can break
  // one step (for example the erasure re-application) and nothing else.
  const realPsql = spawnSync('sh', ['-c', 'command -v psql'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(
    join(dir, 'psql'),
    `#!/bin/sh\ncase "$*" in *"\${FAKE_PSQL_FAIL_ON:-@@never@@}"*) echo "psql: simulated failure" >&2; exit "\${FAKE_PSQL_FAIL_STATUS:-3}" ;; esac\nexec ${realPsql} "$@"\n`,
    { mode: 0o755 },
  );
  if (installed.match(/\) (\d+)/)?.[1] === String(major)) {
    for (const tool of ['pg_dump', 'pg_restore']) {
      const real = spawnSync('sh', ['-c', `command -v ${tool}`], {
        encoding: 'utf8',
      }).stdout.trim();
      writeFileSync(join(dir, tool), `#!/bin/sh\nexec ${real} "$@"\n`, { mode: 0o755 });
    }
    return dir;
  }
  for (const tool of ['pg_dump', 'pg_restore']) {
    // The tools talk to the server over its own socket; stdin and stdout pass through.
    // pg_dump runs inside the container, so --file=<host path> becomes a redirect on the host.
    const script = [
      '#!/bin/sh',
      `case "$1" in --version) exec docker exec ${pg.id} ${tool} --version ;; esac`,
      'out=',
      'n=$#',
      'while [ "$n" -gt 0 ]; do',
      '  a=$1; shift; n=$((n - 1))',
      '  case "$a" in --file=/dev/null) set -- "$@" "$a" ;; --file=*) out=${a#--file=} ;; *) set -- "$@" "$a" ;; esac',
      'done',
      `if [ -n "$out" ]; then`,
      `  docker exec -i -e PGPASSWORD="$PGPASSWORD" -e PGDATABASE="$PGDATABASE" ${pg.id} ${tool} -h 127.0.0.1 -U "$PGUSER" "$@" > "$out"`,
      'else',
      `  exec docker exec -i -e PGPASSWORD="$PGPASSWORD" -e PGDATABASE="$PGDATABASE" ${pg.id} ${tool} -h 127.0.0.1 -U "$PGUSER" "$@"`,
      'fi',
      '',
    ].join('\n');
    writeFileSync(join(dir, tool), script, { mode: 0o755 });
  }
  return dir;
}

export const ERASED_ID = '11111111-1111-4111-8111-111111111111';
export const KEPT_ID = '22222222-2222-4222-8222-222222222222';

/** Two candidates in one org, each with one session holding data of every erasable kind. */
export const FIXTURE_SQL = `
INSERT INTO organizations (id, name) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'Drill Org');
INSERT INTO users (id, org_id, email, full_name, password_hash, role) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'staff@example.test', 'Staff', 'x', 'REVIEWER');
INSERT INTO questions (id, org_id, slug) VALUES ('aaaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'q1');
INSERT INTO question_versions (id, question_id, version, title, statement_md, difficulty, allowed_languages)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000003', 1, 'Q', 'S', 'EASY', ARRAY['python']);
INSERT INTO tests (id, org_id, name, duration_minutes) VALUES ('aaaaaaaa-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', 'T', 60);
INSERT INTO test_sections (id, test_id, title, position) VALUES ('aaaaaaaa-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000005', 'S', 1);
INSERT INTO test_questions (id, section_id, question_version_id, position) VALUES ('aaaaaaaa-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000004', 1);
INSERT INTO consent_texts (id, org_id, version, body_md) VALUES ('aaaaaaaa-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001', 'v1', 'body');

-- one candidate chain per id: candidate, invitation, session, question, submission, consent,
-- review, appeal, identity check, media chunk, event with a decision, event batch, keystrokes
CREATE FUNCTION pg_temp.chain(cand uuid, n int) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE inv uuid := gen_random_uuid(); ses uuid := gen_random_uuid(); sq uuid := gen_random_uuid();
        rev uuid := gen_random_uuid(); ev bigint;
BEGIN
  INSERT INTO candidates (id, org_id, email, full_name, external_ref)
    VALUES (cand, 'aaaaaaaa-0000-4000-8000-000000000001', 'cand' || n || '@example.test', 'Candidate ' || n, 'ref' || n);
  INSERT INTO invitations (id, org_id, test_id, candidate_id, token_hash, window_start, window_end)
    VALUES (inv, 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000005', cand, 'h' || n, now(), now() + interval '1 day');
  INSERT INTO sessions (id, org_id, invitation_id, device_info, hmac_key_enc, report_key)
    VALUES (ses, 'aaaaaaaa-0000-4000-8000-000000000001', inv, '{"ua":"secret"}', 'enc-key-' || n, 'reports/' || n);
  INSERT INTO session_questions (id, session_id, test_question_id, question_version_id, position, points, final_code, answer, scoring_note)
    VALUES (sq, ses, 'aaaaaaaa-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000004', 1, 100, 'print(1)', '{"a":1}', 'note');
  INSERT INTO submissions (session_question_id, kind, language, source_code, results)
    VALUES (sq, 'SUBMIT', 'python', 'print(1)', '[{"ok":true}]');
  INSERT INTO consents (session_id, consent_text_id, signed_name, signed_at, ip, user_agent, pdf_key)
    VALUES (ses, 'aaaaaaaa-0000-4000-8000-000000000008', 'Candidate ' || n, now(), '203.0.113.7', 'agent', 'consents/' || n || '.pdf');
  INSERT INTO session_reviews (id, session_id, reviewer_id, notes)
    VALUES (rev, ses, 'aaaaaaaa-0000-4000-8000-000000000002', 'reviewer note');
  INSERT INTO appeals (session_review_id, reason, resolution_note) VALUES (rev, 'I disagree', 'resolved');
  INSERT INTO identity_checks (session_id, id_image_key, selfie_key) VALUES (ses, 'id/' || n, 'selfie/' || n);
  INSERT INTO media_chunks (session_id, stream, seq, object_key, started_at, duration_ms)
    VALUES (ses, 'WEBCAM', 1, 'media/' || n, now(), 1000);
  INSERT INTO proctor_events (session_id, type, severity, occurred_at) VALUES (ses, 'TAB_SWITCH', 'LOW', now()) RETURNING id INTO ev;
  INSERT INTO flag_decisions (event_id, reviewer_id, decision) VALUES (ev, 'aaaaaaaa-0000-4000-8000-000000000002', 'DISMISSED');
  INSERT INTO proctor_event_batches (session_id, seq, signature, event_count) VALUES (ses, 1, '\\x00', 1);
  INSERT INTO keystroke_batches (session_id, seq, signature, started_at, events) VALUES (ses, 1, '\\x00', now(), '[]');
END $f$;
INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000002', gen_random_uuid(), 'rt1', now() + interval '7 days');
SELECT pg_temp.chain('${ERASED_ID}', 1);
SELECT pg_temp.chain('${KEPT_ID}', 2);
`;

export function loadFixture(pg, db) {
  execFileSync('psql', ['--no-psqlrc', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db], {
    input: FIXTURE_SQL,
    env: { PATH: process.env.PATH ?? '', ...pg.env },
    stdio: ['pipe', 'ignore', 'inherit'],
  });
}
