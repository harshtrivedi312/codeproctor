// Pilot org provisioning CLI tests (ADR 0006 8.9, FU-DB-76; FR-105, NFR-04). The argument, file and
// environment checks need nothing. The database tests use the throwaway postgres:16 container
// (migrations applied, app_user with a random password) and a fake queue; they skip with a message
// when docker or psql is missing, and fail under REQUIRE_DB_DRILL=1.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { REPO_ROOT } from './test-support.mjs';
import { JOB_NAME, jobIdFor, QUEUE_NAME, validateInput } from './provision-org-core.mjs';
import { applyMigrations, drillUnavailable, startPostgres } from './verify-drill-support.mjs';

const EMAIL = 'sentinel.admin+9f3c@pilot-corp.example';
const ORG = 'Pilot Corp SENTINEL-ORG';
const NODE_TSX = ['--import', 'tsx'];
const CLI = join(REPO_ROOT, 'infra/scripts/provision-org.mjs');
const DRIVER = join(REPO_ROOT, 'infra/scripts/provision-org-driver.mjs');
const dir = mkdtempSync(join(tmpdir(), 'provision-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name, content) => {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  chmodSync(path, 0o600); // the CLI refuses a file others can read
  return path;
};
const GOOD = {
  orgName: ORG,
  retentionDays: 30,
  adminEmail: EMAIL,
  adminName: 'Pat Admin',
  expectedDatabase: 'pilot',
};
const run = (args, env = {}) =>
  spawnSync('node', [...NODE_TSX, CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  });

describe('provision-org input (ADR 0006 8.9)', () => {
  it('accepts a good file, defaults retention to 90, and trims', () => {
    assert.deepEqual(
      validateInput({
        orgName: ' A ',
        adminEmail: 'a@b.test',
        adminName: ' N ',
        expectedDatabase: 'pilot',
      }),
      {
        orgName: 'A',
        adminEmail: 'a@b.test',
        adminName: 'N',
        retentionDays: 90,
        expectedDatabase: 'pilot',
      },
    );
  });

  it('refuses unknown fields, bad retention, bad email and empty names, without echoing a value', () => {
    const bad = [
      { ...GOOD, extra: 1 },
      { ...GOOD, retentionDays: 6 },
      { ...GOOD, retentionDays: 731 },
      { ...GOOD, retentionDays: 30.5 },
      { ...GOOD, adminEmail: 'not-an-email SENTINEL' },
      { ...GOOD, orgName: '  ' },
      { ...GOOD, adminName: 'x'.repeat(201) },
      { ...GOOD, adminName: 'Pat\u0000Admin' },
      { ...GOOD, expectedDatabase: 'pilot; DROP' },
      { orgName: 'A', adminEmail: 'a@b.test', adminName: 'N' },
      { ...GOOD, 'a.admin@pilot-corp.example': '' },
      [],
      null,
    ];
    for (const raw of bad) {
      assert.throws(
        () => validateInput(raw),
        (e) =>
          e.name === 'InputError' && !e.message.includes('SENTINEL') && !e.message.includes(EMAIL),
      );
    }
    assert.throws(
      () => validateInput({ ...GOOD }, { forReissue: true }),
      (e) =>
        e.name === 'InputError' &&
        /unknown field/.test(e.message) &&
        !e.message.includes('adminName'),
    );
  });

  it('the job id uses an underscore, never a colon (ADR 0004 9.5)', () => {
    assert.equal(jobIdFor('u-1'), 'set-password_u-1');
    assert.equal(QUEUE_NAME, 'set-password');
    assert.equal(JOB_NAME, 'set-password');
  });
});

describe('provision-org command line (ADR 0006 8.9, ADR 0009)', () => {
  const env = {
    DATABASE_URL: 'postgresql://app_user:x@127.0.0.1:1/none',
    REDIS_URL: 'redis://127.0.0.1:1',
  };

  it('accepts only <create|reissue> --file <path>: no values on the command line', () => {
    for (const args of [
      [],
      ['create'],
      ['create', '--file'],
      ['drop', '--file', 'x'],
      ['create', '--file', 'x', '--email', EMAIL],
      ['create', '--org-name', ORG],
    ]) {
      const r = run(args, env);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /usage/);
      assert.ok(!(r.stdout + r.stderr).includes(EMAIL));
    }
  });

  it('needs DATABASE_URL and REDIS_URL, and ignores MIGRATION_DATABASE_URL', () => {
    const path = file('good.json', GOOD);
    assert.match(
      run(['create', '--file', path], { REDIS_URL: 'redis://x' }).stderr,
      /DATABASE_URL is not set/,
    );
    assert.match(
      run(['create', '--file', path], {
        DATABASE_URL: 'postgresql://x',
        MIGRATION_DATABASE_URL: 'postgresql://owner@x/db',
      }).stderr,
      /REDIS_URL is not set/,
    );
  });

  it('a missing, unreadable or non-JSON file is refused without echoing its content', () => {
    const r1 = run(['create', '--file', join(dir, 'missing.json')], env);
    assert.equal(r1.status, 1);
    const r2 = run(
      ['create', '--file', file('bad.json', `{ "adminEmail": "${EMAIL}" SENTINEL-NOT-JSON`)],
      env,
    );
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /not valid JSON/);
    assert.ok(!(r2.stdout + r2.stderr).includes('SENTINEL-NOT-JSON'));
    assert.ok(!(r2.stdout + r2.stderr).includes(EMAIL));
  });

  it('the input file must be a private regular file of reasonable size, and a link is refused', () => {
    const open = file('open.json', GOOD);
    chmodSync(open, 0o644);
    assert.match(
      run(['create', '--file', open], env).stderr,
      /must not be readable by group or others/,
    );
    const real = file('real.json', GOOD);
    const link = join(dir, 'link.json');
    symlinkSync(real, link);
    assert.match(run(['create', '--file', link], env).stderr, /regular file, not a link/);
    const big = file('big.json', ' '.repeat(70 * 1024));
    assert.match(run(['create', '--file', big], env).stderr, /larger than 64 KiB/);
    assert.match(run(['create', '--file', dir], env).stderr, /regular file/);
  });

  it('an email-shaped key in the file is never printed (a hand-edited file)', () => {
    const r = run(['create', '--file', file('keyed.json', { ...GOOD, [EMAIL]: '' })], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown field/);
    assert.ok(
      !(r.stdout + r.stderr).includes('pilot-corp') && !(r.stdout + r.stderr).includes(EMAIL),
    );
  });

  it('the test driver refuses to run without the test flag, or against a remote host', () => {
    for (const env2 of [
      { DATABASE_URL: 'postgresql://app_user:x@127.0.0.1:1/p' },
      { DATABASE_URL: 'postgresql://app_user:x@db.example.com/p', PROVISION_ORG_DRIVER: 'test' },
    ]) {
      const r = spawnSync('node', [...NODE_TSX, DRIVER], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env2 },
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /test only/);
    }
  });

  it('an invalid field is named, never its value', () => {
    const r = run(['create', '--file', file('range.json', { ...GOOD, retentionDays: 5000 })], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /retentionDays/);
    assert.ok(!r.stderr.includes('5000') && !r.stderr.includes(EMAIL));
  });
});

const skip = drillUnavailable(['psql']) ?? false;
if (skip) console.log(`# provision-org database tests skipped: ${skip}`);
it(
  'provision-org: the database tests can run when they are required',
  { skip: !(skip && process.env.REQUIRE_DB_DRILL === '1') },
  () => {
    assert.fail(`REQUIRE_DB_DRILL=1 but the database tests cannot run: ${skip}`);
  },
);

// The tests in this block depend on each other's rows (exact counts), so they run in this order.
describe('provision-org against a real database (ADR 0006 8.9, FR-105)', { skip }, () => {
  let pg;
  const appPassword = randomBytes(12).toString('hex');
  const q = (sql) => pg.psql('pilot', sql);
  const appUrl = () => `postgresql://app_user:${appPassword}@127.0.0.1:${pg.port}/pilot`;
  const driver = (command, content, extraEnv = {}) => {
    const r = spawnSync('node', [...NODE_TSX, DRIVER], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DATABASE_URL: appUrl(),
        PROVISION_ORG_DRIVER: 'test',
        DRIVER_COMMAND: command,
        DRIVER_FILE: file(`${command}-${randomBytes(3).toString('hex')}.json`, content),
        ...extraEnv,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      !(r.stdout + r.stderr).includes(EMAIL) || command === 'never',
      'the driver output never holds the email',
    );
    return JSON.parse(r.stdout.trim().split('\n').at(-1));
  };

  before(() => {
    pg = startPostgres();
    applyMigrations(pg, 'pilot');
    pg.psql('pilot', `ALTER ROLE app_user PASSWORD '${appPassword}'`);
  });
  after(() => pg?.stop());

  it('create: one org, one SUPER_ADMIN with no password, an already-expired placeholder, one audit row, one job', () => {
    const out = driver('create', GOOD);
    assert.equal(out.ok, true, JSON.stringify(out));
    const { orgId, userId } = out.result;
    assert.equal(
      q(
        `SELECT count(*) FROM organizations WHERE id = '${orgId}' AND retention_days = 30 AND current_consent_text_id IS NULL`,
      ),
      '1',
    );
    assert.equal(q('SELECT count(*) FROM organizations'), '1');
    assert.equal(q('SELECT count(*) FROM users'), '1');
    assert.equal(
      q(
        `SELECT role || '|' || (password_hash IS NULL) || '|' || (length(set_password_token_hash) = 64) || '|' || (set_password_expires_at <= now()) || '|' || is_active FROM users WHERE id = '${userId}' AND org_id = '${orgId}'`,
      ),
      'SUPER_ADMIN|true|true|true|true',
    );
    assert.equal(q(`SELECT count(*) FROM audit_logs`), '1');
    assert.equal(
      q(
        `SELECT action || '|' || (actor_id IS NULL) || '|' || entity_type || '|' || entity_id || '|' || (org_id = '${orgId}') FROM audit_logs`,
      ),
      `ORG_PROVISIONED|true|organization|${orgId}|true`,
    );
    assert.equal(
      q("SELECT string_agg(k, ',' ORDER BY k) FROM audit_logs, jsonb_object_keys(metadata) k"),
      'orgId,runId,userId',
    );
    assert.deepEqual(out.jobs, [
      {
        name: 'set-password',
        data: { orgId, userId },
        opts: {
          jobId: `set-password_${userId}`,
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 30000 },
        },
      },
    ]);
    // The email is stored once, on the user, and nowhere else.
    assert.equal(
      q(
        `SELECT count(*) FROM audit_logs WHERE metadata::text ILIKE '%pilot-corp%' OR action ILIKE '%pilot-corp%'`,
      ),
      '0',
    );
    assert.equal(q(`SELECT count(*) FROM users WHERE email = '${EMAIL}'`), '1');
  });

  it('the placeholder token can never be used: expired at insert, and different for every admin', () => {
    const second = driver('create', {
      ...GOOD,
      orgName: 'Second Org',
      adminEmail: 'second.admin@pilot-corp.example',
    });
    assert.equal(second.ok, true);
    assert.equal(q('SELECT count(DISTINCT set_password_token_hash) FROM users'), '2');
    assert.equal(q('SELECT count(*) FROM users WHERE set_password_expires_at > now()'), '0');
  });

  it('a second create with the same email fails without the address, and nothing is half-created', () => {
    const orgs = q('SELECT count(*) FROM organizations');
    const out = driver('create', { ...GOOD, orgName: 'Third Org' });
    assert.equal(out.ok, false);
    assert.equal(out.error.name, 'InputError');
    assert.match(out.error.message, /already exists/);
    assert.ok(!JSON.stringify(out).includes(EMAIL) && !JSON.stringify(out).includes('pilot-corp'));
    assert.equal(q('SELECT count(*) FROM organizations'), orgs, 'the org insert rolled back');
    assert.deepEqual(out.jobs, []);
  });

  it('a failed enqueue leaves the committed org and admin, names ids only, and reissue completes the job', () => {
    const mail = 'queue.down@pilot-corp.example';
    const out = driver(
      'create',
      { orgName: 'Queue Down Org', adminName: 'Q', adminEmail: mail, expectedDatabase: 'pilot' },
      { DRIVER_QUEUE: 'fail' },
    );
    assert.equal(out.ok, false);
    assert.equal(out.error.name, 'EnqueueError');
    assert.ok(out.ids.orgId && out.ids.userId);
    assert.ok(
      !JSON.stringify(out).includes('pilot-corp') && !JSON.stringify(out).includes('Queue Down'),
    );
    assert.equal(q(`SELECT count(*) FROM users WHERE id = '${out.ids.userId}'`), '1');
    const again = driver('reissue', {
      orgName: 'Queue Down Org',
      adminEmail: mail,
      expectedDatabase: 'pilot',
    });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(again.result, out.ids);
    assert.equal(again.jobs[0].opts.jobId, `set-password_${out.ids.userId}`);
    assert.equal(
      q(
        `SELECT count(*) FROM audit_logs WHERE entity_id = '${out.ids.userId}' AND action = 'SET_PASSWORD_REISSUED' AND entity_type = 'user'`,
      ),
      '1',
    );
  });

  it('reissue refuses a user who has a password, an inactive one, another org, and an unknown email', () => {
    const mail = 'has.password@pilot-corp.example';
    const out = driver('create', {
      orgName: 'Has Password Org',
      adminName: 'H',
      adminEmail: mail,
      expectedDatabase: 'pilot',
    });
    assert.equal(out.ok, true);
    const attempt = (orgName, adminEmail) => {
      const out = driver('reissue', { orgName, adminEmail, expectedDatabase: 'pilot' });
      return out;
    };
    const refused = (out) =>
      out.ok === false && out.error.name === 'InputError' && out.jobs.length === 0;
    q(
      `UPDATE users SET password_hash = 'argon2-hash', set_password_token_hash = NULL WHERE id = '${out.result.userId}'`,
    );
    assert.ok(refused(attempt('Has Password Org', mail)));
    q(
      `UPDATE users SET password_hash = NULL, set_password_token_hash = repeat('a', 64), is_active = false WHERE id = '${out.result.userId}'`,
    );
    assert.ok(refused(attempt('Has Password Org', mail)));
    q(`UPDATE users SET is_active = true WHERE id = '${out.result.userId}'`);
    assert.ok(refused(attempt('Pilot Corp SENTINEL-ORG', mail)));
    assert.ok(refused(attempt('Has Password Org', 'nobody@pilot-corp.example')));
    const refusal = attempt('Has Password Org', 'nobody@pilot-corp.example');
    assert.equal(
      q(
        "SELECT count(*) FROM audit_logs WHERE action = 'SET_PASSWORD_REISSUED' AND entity_id = (SELECT id::text FROM users WHERE email = '" +
          mail +
          "')",
      ),
      '0',
      'refused attempts leave no audit row',
    );
    assert.ok(!JSON.stringify(refusal).includes('nobody'));
    assert.equal(attempt('Has Password Org', mail).ok, true, 'and works once the user qualifies');
  });

  it('the CLI refuses a database other than the one the file names, before creating anything', () => {
    const path = file('wrongdb.json', {
      ...GOOD,
      orgName: 'Wrong Db Org',
      adminEmail: 'wrong.db@pilot-corp.example',
      expectedDatabase: 'staging',
    });
    const orgs = q('SELECT count(*) FROM organizations');
    const r = run(['create', '--file', path], {
      DATABASE_URL: appUrl(),
      REDIS_URL: 'redis://127.0.0.1:1',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /different database than expectedDatabase/);
    assert.equal(q('SELECT count(*) FROM organizations'), orgs);
    assert.ok(!(r.stdout + r.stderr).includes('pilot-corp'));
  });

  it('a reissue whose job cannot be queued is recorded as failed, not as sent', () => {
    const mail = 'reissue.fails@pilot-corp.example';
    const created = driver('create', {
      orgName: 'Reissue Fails Org',
      adminName: 'R',
      adminEmail: mail,
      expectedDatabase: 'pilot',
    });
    assert.equal(created.ok, true);
    const out = driver(
      'reissue',
      { orgName: 'Reissue Fails Org', adminEmail: mail, expectedDatabase: 'pilot' },
      { DRIVER_QUEUE: 'fail' },
    );
    assert.equal(out.error.name, 'EnqueueError');
    assert.equal(
      q(
        `SELECT string_agg(action, ',' ORDER BY id) FROM audit_logs WHERE entity_id = '${created.result.userId}' AND entity_type = 'user'`,
      ),
      'SET_PASSWORD_REISSUED,SET_PASSWORD_REISSUE_FAILED',
    );
  });

  it('the CLI refuses owner credentials, and without BullMQ it creates nothing', () => {
    const path = file('cli.json', {
      orgName: 'Cli Org',
      adminName: 'C',
      adminEmail: 'cli.admin@pilot-corp.example',
      expectedDatabase: 'pilot',
    });
    const orgs = q('SELECT count(*) FROM organizations');
    const asOwner = run(['create', '--file', path], {
      DATABASE_URL: `postgresql://postgres:${pg.env.PGPASSWORD}@127.0.0.1:${pg.port}/pilot`,
      REDIS_URL: 'redis://127.0.0.1:1',
    });
    assert.equal(asOwner.status, 1);
    assert.match(asOwner.stderr, /must connect as app_user/);
    const asApp = run(['create', '--file', path], {
      DATABASE_URL: appUrl(),
      REDIS_URL: 'redis://127.0.0.1:1',
    });
    assert.equal(asApp.status, 1);
    assert.match(asApp.stderr, /bullmq is not installed in apps\/api/);
    assert.equal(q('SELECT count(*) FROM organizations'), orgs);
    for (const r of [asOwner, asApp]) {
      assert.ok(
        !(r.stdout + r.stderr).includes('pilot-corp') &&
          !(r.stdout + r.stderr).includes(appPassword),
      );
    }
  });
});
