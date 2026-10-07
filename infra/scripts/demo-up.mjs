// One command to a running local demo (docs/local-run.md; DL-52, D-67):
//
//   pnpm demo:up [--dry-run] [--no-apps]
//
// It writes .env if missing, starts the local stack (PostgreSQL, Redis, Mailpit, MinIO, Adminer),
// builds the shared package, migrates, seeds, gives one seeded invitation a real link, starts the API
// and the web app in the background (logs and process ids under .demo/), waits until both answer, and
// prints where everything is. Run it again at any time: every step is idempotent, and apps that are
// already running are left alone. `pnpm demo:down` stops the apps (and `--infra` the containers).
//
// Local development only: it refuses unless .env says APP_ENV=development, and the database commands
// it runs carry their own localhost guard (ADR 0009). Synthetic seed data only. It never prints a
// secret; the demo password lives in prisma/seed/guard.ts (DEMO_PASSWORD).
//   --dry-run   print the steps, run nothing
//   --no-apps   do everything except start the API and the web app (start them in your own terminals)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export const API_HEALTH = 'http://localhost:4000/api/v1/health';
export const WEB_LOGIN = 'http://localhost:3000/admin/login';

/** The ordered steps (pure: used for --dry-run and the tests). */
export function planSteps({ hasEnv, hasModules, startApps }) {
  const steps = [];
  if (!hasEnv)
    steps.push({
      name: 'write .env (random local secrets)',
      cmd: ['node', 'infra/scripts/local-env.mjs'],
    });
  steps.push({ name: 'check .env is a local development environment', check: 'env' });
  if (!hasModules)
    steps.push({ name: 'install dependencies', cmd: ['pnpm', 'install', '--frozen-lockfile'] });
  steps.push(
    { name: 'build the shared package', cmd: ['pnpm', '--filter', '@codeproctor/shared', 'build'] },
    {
      name: 'start the local stack (PostgreSQL, Redis, Mailpit, MinIO, Adminer)',
      cmd: ['pnpm', 'dev:infra'],
    },
    { name: 'generate the database client', cmd: ['pnpm', 'db:generate'] },
    { name: 'apply the migrations', cmd: ['pnpm', 'db:migrate'] },
    { name: 'seed the demo data (idempotent)', cmd: ['pnpm', 'db:seed'] },
    {
      name: 'give the seeded invitation a real link',
      cmd: ['node', 'infra/scripts/demo-invite.mjs'],
      capture: 'invite',
    },
  );
  if (startApps) {
    steps.push(
      { name: 'start the API in the background', app: 'api' },
      { name: 'start the web app in the background', app: 'web' },
    );
  }
  return steps;
}

/** The summary printed at the end (pure). `invite` is the output of demo-invite.mjs, or ''. */
export function summary({ invite, appsStarted }) {
  const lines = [
    '',
    'Local demo is ready.',
    '',
    `  Web app (staff sign-in) ${WEB_LOGIN.replace('/admin/login', '/admin/login')}`,
    '  API health              http://localhost:4000/api/v1/health',
    '  Mailpit (email inbox)   http://localhost:8025',
    '  MinIO console           http://localhost:9001   (login: MINIO_ROOT_USER / MINIO_ROOT_PASSWORD in .env)',
    '  Adminer (database)      http://localhost:8080',
    '',
    '  Staff accounts: admin, recruiter, author, reviewer @demo-corp.example',
    '  Password: the development password in prisma/seed/guard.ts (DEMO_PASSWORD).',
    '  The admin must enrol an authenticator on first sign-in; get codes with',
    '    node infra/scripts/demo-totp.mjs <the manual key shown on the page>',
    '  Use Chrome or Firefox, and open the web app as http://localhost:3000.',
  ];
  if (invite.trim() !== '') {
    lines.push(
      '',
      '  Candidate invitation:',
      ...invite
        .trim()
        .split('\n')
        .map((l) => `    ${l}`),
    );
  }
  if (appsStarted) {
    lines.push(
      '',
      '  Logs: .demo/api.log and .demo/web.log. Stop with: pnpm demo:down (add --infra for the containers).',
    );
  } else {
    lines.push('', '  Start the apps yourself: pnpm dev:api  and  pnpm dev:web');
  }
  return lines.join('\n');
}

function run(root, cmd, { capture = false } = {}) {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
}

async function waitFor(url, label, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline)
      throw new Error(`${label} did not answer within ${seconds} seconds (see .demo/*.log).`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function isUp(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

function startApp(root, name, cmd) {
  const dir = join(root, '.demo');
  mkdirSync(dir, { recursive: true });
  const log = openSync(join(dir, `${name}.log`), 'a');
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  const file = join(dir, 'pids.json');
  const pids = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  pids[name] = child.pid;
  writeFileSync(file, JSON.stringify(pids));
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--dry-run' && a !== '--no-apps');
  if (unknown.length > 0) {
    console.error('demo-up: usage: pnpm demo:up [--dry-run] [--no-apps]');
    process.exit(1);
  }
  const dry = args.includes('--dry-run');
  const startApps = !args.includes('--no-apps');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const steps = planSteps({
    hasEnv: existsSync(join(root, '.env')),
    hasModules: existsSync(join(root, 'node_modules')),
    startApps,
  });
  if (dry) {
    steps.forEach((s, i) =>
      console.log(`${i + 1}. ${s.name}${s.cmd ? `   (${s.cmd.join(' ')})` : ''}`),
    );
    return;
  }
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    console.error('demo-up: Docker is not running. Start Docker Desktop and try again.');
    process.exit(1);
  }
  let invite = '';
  let n = 0;
  for (const step of steps) {
    n += 1;
    console.log(`\n[${n}/${steps.length}] ${step.name}`);
    if (step.check === 'env') {
      const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
      if (env.APP_ENV !== 'development') {
        console.error('demo-up: .env must say APP_ENV=development. This is for a local run only.');
        process.exit(1);
      }
      continue;
    }
    if (step.app) {
      const url = step.app === 'api' ? API_HEALTH : WEB_LOGIN;
      if (await isUp(url)) {
        console.log('already running, left alone.');
        continue;
      }
      startApp(root, step.app, step.app === 'api' ? ['pnpm', 'dev:api'] : ['pnpm', 'dev:web']);
      await waitFor(
        url,
        step.app === 'api' ? 'the API' : 'the web app',
        step.app === 'api' ? 180 : 240,
      );
      console.log('up.');
      continue;
    }
    const r = run(root, step.cmd, { capture: step.capture !== undefined });
    if (!r.ok) {
      console.error(`demo-up: step ${n} failed: ${step.cmd.join(' ')}`);
      process.exit(1);
    }
    if (step.capture === 'invite') invite = r.stdout;
  }
  console.log(summary({ invite, appsStarted: startApps }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
