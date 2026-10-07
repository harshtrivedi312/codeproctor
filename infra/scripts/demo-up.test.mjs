// demo-up / demo-down (docs/local-run.md; DL-52, D-67): the plan, the summary and the guards. The real
// run needs Docker and free ports, so it is exercised by hand (the guide); these tests need neither.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { looksLikeOurs, parsePids } from './demo-down.mjs';
import {
  DEMO_PORTS,
  foreignContainers,
  foreignMessage,
  judgePort,
  parseDockerPs,
} from './demo-ports.mjs';
import { planSteps, summary } from './demo-up.mjs';
import { REPO_ROOT } from './test-support.mjs';

const names = (steps) => steps.map((s) => s.name);

describe('demo:up plan (local demo)', () => {
  it('on a fresh checkout it writes .env first, then checks it, builds, starts the stack, migrates, seeds, invites, starts the apps', () => {
    const steps = planSteps({
      hasEnv: false,
      hasModules: false,
      startApps: true,
      startWorker: true,
    });
    const cmds = steps.map((s) => (s.cmd ? s.cmd.join(' ') : (s.check ?? s.app)));
    assert.deepEqual(cmds, [
      'node infra/scripts/local-env.mjs',
      'env',
      'ports',
      'pnpm install --frozen-lockfile',
      'pnpm --filter @codeproctor/shared build',
      'pnpm dev:infra',
      'pnpm db:generate',
      'pnpm db:migrate',
      'pnpm db:seed',
      'node infra/scripts/demo-invite.mjs',
      'api',
      'web',
      'worker',
    ]);
  });

  it('it skips the steps that are already done and --no-apps leaves the apps out', () => {
    const steps = planSteps({ hasEnv: true, hasModules: true, startApps: false });
    assert.ok(!names(steps).some((n) => /write \.env|install dependencies|background/.test(n)));
    assert.ok(names(steps).some((n) => /seed the demo data/.test(n)));
  });

  it('the port check comes right after the env check, before anything is installed or started', () => {
    const steps = planSteps({
      hasEnv: false,
      hasModules: false,
      startApps: true,
      startWorker: true,
    });
    const ports = steps.findIndex((s) => s.check === 'ports');
    const install = steps.findIndex((s) => s.cmd?.join(' ').startsWith('pnpm install'));
    assert.equal(ports, steps.findIndex((s) => s.check === 'env') + 1);
    assert.ok(ports < install);
  });

  it('the worker is optional: --no-worker and --no-apps leave it out', () => {
    const none = planSteps({ hasEnv: true, hasModules: true, startApps: true, startWorker: false });
    assert.ok(!names(none).some((n) => /worker/.test(n)));
    const dry = spawnSync(
      'node',
      [`${REPO_ROOT}infra/scripts/demo-up.mjs`, '--dry-run', '--no-worker'],
      { encoding: 'utf8' },
    );
    assert.equal(dry.status, 0, dry.stderr);
    assert.doesNotMatch(dry.stdout, /face-match worker/);
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
    assert.match(
      summary({ invite: '', appsStarted: true, workerStatus: 'running' }),
      /Face-match worker: running/,
    );
    assert.doesNotMatch(text, /ChangeMe/);
    assert.match(summary({ invite: '', appsStarted: false }), /pnpm dev:api/);
  });
});

describe('port checks (local demo)', () => {
  const ourCompose = '/work/codeproctor/infra/docker-compose.yml';
  const pg = DEMO_PORTS.find((p) => p.port === 5432);
  const api = DEMO_PORTS.find((p) => p.port === 4000);

  it('every demo port is listed once and all are loopback services', () => {
    const ports = DEMO_PORTS.map((p) => p.port);
    assert.equal(new Set(ports).size, ports.length);
    for (const p of [5432, 6379, 8080, 1025, 8025, 9000, 9001, 4000, 3000, 8000])
      assert.ok(ports.includes(p), String(p));
  });

  it('parses docker ps lines into the host ports they publish', () => {
    const text =
      'codeproctor-postgres-1\t/other/infra/docker-compose.yml\t127.0.0.1:5432->5432/tcp\n' +
      'web\t\t0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp\n\n';
    assert.deepEqual(parseDockerPs(text), [
      {
        name: 'codeproctor-postgres-1',
        configFiles: ['/other/infra/docker-compose.yml'],
        ports: [5432],
      },
      { name: 'web', configFiles: [], ports: [3000, 3000] },
    ]);
  });

  it('DL-57: a stopped container of another checkout in the shared project is a clash even when its ports are free', () => {
    const containers = [
      {
        name: 'codeproctor-postgres-1',
        configFiles: ['/other/infra/docker-compose.yml'],
        ports: [],
      },
      { name: 'codeproctor-redis-1', configFiles: [ourCompose], ports: [] },
      { name: 'unlabelled', configFiles: [], ports: [] },
    ];
    const foreign = foreignContainers(containers, ourCompose);
    assert.deepEqual(
      foreign.map((c) => c.name),
      ['codeproctor-postgres-1'],
    );
    const message = foreignMessage(foreign);
    assert.match(message, /codeproctor-postgres-1/);
    assert.match(message, /\/other\/infra\/docker-compose\.yml/);
    assert.match(message, /pnpm dev:infra:down/);
    assert.deepEqual(foreignContainers([containers[1]], ourCompose), []);
  });

  it('a free port is fine', () => {
    assert.deepEqual(
      judgePort({ spec: pg, free: true, containers: [], ourCompose, ourAppUp: false }),
      {
        ok: true,
      },
    );
  });

  it("another checkout's stack is a clash: the message names the port, the container and the fix, and nothing is taken over", () => {
    const containers = [
      {
        name: 'codeproctor-postgres-1',
        configFiles: ['/other/infra/docker-compose.yml'],
        ports: [5432],
      },
    ];
    const v = judgePort({ spec: pg, free: false, containers, ourCompose, ourAppUp: false });
    assert.equal(v.ok, false);
    assert.match(v.message, /Port 5432 \(PostgreSQL\)/);
    assert.match(v.message, /codeproctor-postgres-1/);
    assert.match(v.message, /\/other\/infra\/docker-compose\.yml/);
    assert.match(v.message, /never stops or reuses another stack's containers/);
    assert.match(v.message, /pnpm dev:infra:down/);
  });

  it("this checkout's own stack is fine (a second demo:up is safe)", () => {
    const containers = [
      { name: 'codeproctor-postgres-1', configFiles: [ourCompose], ports: [5432] },
    ];
    assert.equal(
      judgePort({ spec: pg, free: false, containers, ourCompose, ourAppUp: false }).ok,
      true,
    );
  });

  it('a program that is not a container is a clash; an app of ours that already answers is fine', () => {
    const v = judgePort({ spec: pg, free: false, containers: [], ourCompose, ourAppUp: false });
    assert.equal(v.ok, false);
    assert.match(v.message, /not one of this demo's containers/);
    assert.match(v.message, /lsof -nP -iTCP:5432/);
    assert.equal(
      judgePort({ spec: api, free: false, containers: [], ourCompose, ourAppUp: true }).ok,
      true,
    );
    // An infra port is never excused by an app answering.
    assert.equal(
      judgePort({ spec: pg, free: false, containers: [], ourCompose, ourAppUp: true }).ok,
      false,
    );
  });
});

describe('demo:down (local demo)', () => {
  it('reads only positive integer pids for api and web, and survives bad JSON', () => {
    assert.deepEqual(parsePids('{"api": 1234, "web": 5678, "evil": 9}'), { api: 1234, web: 5678 });
    assert.deepEqual(parsePids('{"api": -5, "web": "1", "x": 1}'), {});
    assert.deepEqual(parsePids('{"api": 1, "worker": 4321}'), { worker: 4321 });
    assert.deepEqual(parsePids('not json'), {});
  });

  it('only a process group leader whose command is a pnpm dev command counts as ours', () => {
    assert.equal(looksLikeOurs('  4242 pnpm dev:api', 4242), true);
    assert.equal(looksLikeOurs('4242 node /x/pnpm.cjs --filter @codeproctor/api dev', 4242), true);
    assert.equal(looksLikeOurs('  4242 /usr/bin/zsh -l', 4242), false, 'a shell is not ours');
    assert.equal(looksLikeOurs('  1 pnpm dev:api', 4242), false, 'not the group leader');
    assert.equal(looksLikeOurs('', 4242), false);
    assert.equal(
      looksLikeOurs(
        '4242 /x/.venv/bin/python /x/.venv/bin/uvicorn worker.app:app --port 8000',
        4242,
      ),
      true,
    );
    assert.equal(looksLikeOurs('4242 bash apps/worker/tools/be08/run-local.sh', 4242), true);
    assert.equal(looksLikeOurs('4242 /usr/bin/python3 -m http.server', 4242), false);
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
    assert.match(compose, /MINIO_ROOT_USER and MINIO_ROOT_PASSWORD must be set in \.env/);
    assert.match(compose, /\[ -n "\$\$\{MINIO_ROOT_PASSWORD:-\}" \]/);
    assert.doesNotMatch(compose, /MINIO_ROOT_PASSWORD=[^$\s]/, 'no literal default');
  });

  it('MinIO allows browser uploads from the local web origin only', () => {
    const origins = [...compose.matchAll(/MINIO_API_CORS_ALLOW_ORIGIN=(\S+)/g)].map((m) => m[1]);
    assert.deepEqual(origins, ['http://localhost:3000']);
  });

  it('the worker is behind a profile (it is not part of demo:up)', () => {
    assert.match(compose, /worker:\n\s+profiles: \['worker'\]/);
  });
});
