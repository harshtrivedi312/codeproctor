// demo-invite.mjs (docs/local-run.md): the guards, and the update against a throwaway Postgres.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import {
  applyMigrations,
  drillUnavailable,
  loadFixture,
  startPostgres,
} from './verify-drill-support.mjs';
import { REPO_ROOT } from './test-support.mjs';

const SCRIPT = `${REPO_ROOT}infra/scripts/demo-invite.mjs`;
const skip = drillUnavailable(['psql']) ?? false;

const run = (env) =>
  new Promise((resolve) => {
    const child = spawn('node', [SCRIPT], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

describe('demo-invite guards (local demo)', () => {
  const local = 'postgresql://owner:pw@127.0.0.1:5432/db';
  it('refuses unless APP_ENV is "development"', async () => {
    // An empty value is set (not missing) so a developer's own .env cannot fill it in.
    for (const appEnv of ['', 'staging', 'pilot']) {
      const r = await run({
        APP_ENV: appEnv,
        DATABASE_URL: local,
        MIGRATION_DATABASE_URL: local,
      });
      assert.equal(r.status, 1, String(appEnv));
      assert.match(r.stderr, /APP_ENV must be "development"/);
    }
  });

  it('refuses a database that is not on this machine, and never prints the URL or password', async () => {
    const remote = 'postgresql://owner:SECRETpw@db.staging.example.com:5432/db';
    const r = await run({
      APP_ENV: 'development',
      DATABASE_URL: remote,
      MIGRATION_DATABASE_URL: remote,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing to run/);
    assert.doesNotMatch(r.stderr + r.stdout, /SECRETpw|owner:/);
  });

  it('takes no arguments', async () => {
    const child = spawn('node', [SCRIPT, 'x'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const status = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(status, 1);
    assert.match(stderr, /takes no arguments/);
  });
});

describe('demo-invite against a throwaway database (local demo)', { skip }, () => {
  let pg;
  let env;
  before(() => {
    pg = startPostgres();
    applyMigrations(pg, 'demo');
    loadFixture(pg, 'demo');
    // The script only picks the seed's synthetic candidates (@candidates.example).
    pg.psql('demo', "UPDATE candidates SET email = id || '@candidates.example'");
    const url = `postgresql://postgres:${pg.env.PGPASSWORD}@127.0.0.1:${pg.port}/demo`;
    env = { APP_ENV: 'development', DATABASE_URL: url, MIGRATION_DATABASE_URL: url };
  });
  after(() => pg?.stop());

  /** The hash the script wrote: the one invitation whose hash is not the fixture's own. */
  const hashOf = () =>
    pg.psql(
      'demo',
      "SELECT i.token_hash FROM invitations i JOIN sessions s ON s.invitation_id = i.id WHERE s.status = 'INVITED' ORDER BY i.created_at, i.id LIMIT 1",
    );

  it('FR-106: stores the SHA-256 of the printed token, opens the window, and a second run replaces it', async () => {
    const first = await run(env);
    assert.equal(first.status, 0, first.stderr);
    const token = /\/t\/([A-Za-z0-9_-]{20,128})\n/.exec(first.stdout)?.[1];
    assert.ok(token, 'a link is printed');
    assert.equal(hashOf(), createHash('sha256').update(token).digest('hex'));
    assert.equal(
      pg.psql(
        'demo',
        `SELECT window_start < now() AND window_end > now() + interval '6 days' AND used_at IS NULL FROM invitations WHERE token_hash = '${hashOf()}'`,
      ),
      't',
    );
    assert.match(first.stdout, /candidate: \S+@\S+/);
    assert.doesNotMatch(first.stderr + first.stdout, new RegExp(pg.env.PGPASSWORD));
    const second = await run(env);
    assert.equal(second.status, 0, second.stderr);
    const token2 = /\/t\/([A-Za-z0-9_-]+)\n/.exec(second.stdout)?.[1];
    assert.notEqual(token2, token);
    assert.equal(hashOf(), createHash('sha256').update(token2).digest('hex'));
  });

  it('says so when no seeded session is still INVITED, and changes nothing', async () => {
    pg.psql('demo', "UPDATE sessions SET status = 'EXPIRED'");
    const hashBefore = hashOf();
    const r = await run(env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no seeded invitation is still INVITED/);
    assert.equal(hashOf(), hashBefore);
  });
});
