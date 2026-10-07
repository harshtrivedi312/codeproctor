// demo-up / demo-down (docs/local-run.md; DL-52, D-67): the plan, the summary and the guards. The real
// run needs Docker and free ports, so it is exercised by hand (the guide); these tests need neither.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { looksLikeOurs, parsePids } from './demo-down.mjs';
import { planSteps, summary } from './demo-up.mjs';
import { REPO_ROOT } from './test-support.mjs';

const names = (steps) => steps.map((s) => s.name);

describe('demo:up plan (local demo)', () => {
  it('on a fresh checkout it writes .env first, then checks it, builds, starts the stack, migrates, seeds, invites, starts the apps', () => {
    const steps = planSteps({ hasEnv: false, hasModules: false, startApps: true });
    const cmds = steps.map((s) => (s.cmd ? s.cmd.join(' ') : (s.check ?? s.app)));
    assert.deepEqual(cmds, [
      'node infra/scripts/local-env.mjs',
      'env',
      'pnpm install --frozen-lockfile',
      'pnpm --filter @codeproctor/shared build',
      'pnpm dev:infra',
      'pnpm db:generate',
      'pnpm db:migrate',
      'pnpm db:seed',
      'node infra/scripts/demo-invite.mjs',
      'api',
      'web',
    ]);
  });

  it('it skips the steps that are already done and --no-apps leaves the apps out', () => {
    const steps = planSteps({ hasEnv: true, hasModules: true, startApps: false });
    assert.ok(!names(steps).some((n) => /write \.env|install dependencies|background/.test(n)));
    assert.ok(names(steps).some((n) => /seed the demo data/.test(n)));
  });

  it('the env check always comes before anything that touches the database', () => {
    const steps = planSteps({ hasEnv: true, hasModules: true, startApps: true });
    const check = steps.findIndex((s) => s.check === 'env');
    const infra = steps.findIndex((s) => s.cmd?.join(' ') === 'pnpm dev:infra');
    assert.ok(check >= 0 && check < infra);
  });

  it('--dry-run prints the plan and runs nothing; unknown arguments are refused', () => {
    const dry = spawnSync('node', [`${REPO_ROOT}infra/scripts/demo-up.mjs`, '--dry-run'], {
      encoding: 'utf8',
    });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /seed the demo data/);
    assert.match(dry.stdout, /start the web app in the background/);
    const bad = spawnSync('node', [`${REPO_ROOT}infra/scripts/demo-up.mjs`, '--wat'], {
      encoding: 'utf8',
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /usage/);
  });

  it('the summary names the inbox, the accounts, where the password lives and how to stop, and never a password', () => {
    const text = summary({
      invite: 'candidate: avery.stone@candidates.example\nlink:      http://localhost:3000/t/abc\n',
      appsStarted: true,
    });
    assert.match(text, /Mailpit .*http:\/\/localhost:8025/);
    assert.match(text, /prisma\/seed\/guard\.ts/);
    assert.match(text, /link: {6}http:\/\/localhost:3000\/t\/abc/);
    assert.match(text, /pnpm demo:down/);
    assert.doesNotMatch(text, /ChangeMe/);
    assert.match(summary({ invite: '', appsStarted: false }), /pnpm dev:api/);
  });
});

describe('demo:down (local demo)', () => {
  it('reads only positive integer pids for api and web, and survives bad JSON', () => {
    assert.deepEqual(parsePids('{"api": 1234, "web": 5678, "evil": 9}'), { api: 1234, web: 5678 });
    assert.deepEqual(parsePids('{"api": -5, "web": "1", "x": 1}'), {});
    assert.deepEqual(parsePids('{"api": 1}'), {});
    assert.deepEqual(parsePids('not json'), {});
  });

  it('only a process group leader whose command is a pnpm dev command counts as ours', () => {
    assert.equal(looksLikeOurs('  4242 pnpm dev:api', 4242), true);
    assert.equal(looksLikeOurs('4242 node /x/pnpm.cjs --filter @codeproctor/api dev', 4242), true);
    assert.equal(looksLikeOurs('  4242 /usr/bin/zsh -l', 4242), false, 'a shell is not ours');
    assert.equal(looksLikeOurs('  1 pnpm dev:api', 4242), false, 'not the group leader');
    assert.equal(looksLikeOurs('', 4242), false);
  });

  it('refuses unknown arguments', () => {
    const r = spawnSync('node', [`${REPO_ROOT}infra/scripts/demo-down.mjs`, '--all'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage/);
  });
});

describe('local compose stack (D-67)', () => {
  const compose = readFileSync(`${REPO_ROOT}infra/docker-compose.yml`, 'utf8');

  it('every published port is bound to 127.0.0.1', () => {
    const ports = [...compose.matchAll(/^\s+- '([^']*:\d+:\d+)'$/gm)].map((m) => m[1]);
    assert.ok(ports.length >= 7, 'postgres, redis, adminer, mailpit x2, minio x2 at least');
    for (const p of ports) assert.match(p, /^127\.0\.0\.1:/, p);
  });

  it('no service is privileged or mounts a host path, and the new images are pinned by digest', () => {
    assert.doesNotMatch(compose, /privileged:/);
    assert.doesNotMatch(compose, /^\s+- (\.|\/|~)[^\n]*:/m, 'only named volumes');
    assert.match(compose, /image: axllent\/mailpit@sha256:[0-9a-f]{64}/);
    assert.match(compose, /image: bitnamilegacy\/minio@sha256:[0-9a-f]{64}/);
  });

  it('MinIO refuses to start without its login in .env (no known default password)', () => {
    assert.match(compose, /- MINIO_ROOT_PASSWORD=\$\{MINIO_ROOT_PASSWORD:\?/);
    assert.match(compose, /- MINIO_ROOT_USER=\$\{MINIO_ROOT_USER:\?/);
  });

  it('MinIO allows browser uploads from the local web origin only', () => {
    const origins = [...compose.matchAll(/MINIO_API_CORS_ALLOW_ORIGIN=(\S+)/g)].map((m) => m[1]);
    assert.deepEqual(origins, ['http://localhost:3000']);
  });

  it('the worker is behind a profile (it is not part of demo:up)', () => {
    assert.match(compose, /worker:\n\s+profiles: \['worker'\]/);
  });
});
