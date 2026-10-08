// One command to a running local demo (docs/local-run.md; DL-52, D-67):
//
//   pnpm demo:up [--dry-run] [--no-apps] [--no-worker]
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
//   --no-worker do not start the face-match worker on the host (it is optional: without it the identity
//               check answers MANUAL_REVIEW and the candidate continues)
// It checks first that the ports it needs are free and stops with a message that names the port and what
// holds it. It never stops or reuses another stack's containers. Its containers and volumes belong to the
// compose project `codeproctor-demo` (COMPOSE_PROJECT_NAME overrides), never to the dev stack's `codeproctor`.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { parsePids } from './demo-down.mjs';
import {
  DEMO_PORTS,
  DEMO_PROJECT as DEMO_PROJECT_NAME,
  DEV_PROJECT,
  composeEnv,
  demoProject,
  dockerContainers,
  foreignContainers,
  foreignMessage,
  isFree,
  judgePort,
} from './demo-ports.mjs';

export const API_HEALTH = 'http://localhost:4000/api/v1/health';
export const WEB_LOGIN = 'http://localhost:3000/admin/login';
export const WORKER_HEALTH = 'http://127.0.0.1:8000/health';
export const WORKER_SCRIPT = 'apps/worker/tools/be08/run-local.sh';

/** The ordered steps (pure: used for --dry-run and the tests). */
export function planSteps({ hasEnv, hasModules, startApps, startWorker = false }) {
  const steps = [];
  if (!hasEnv)
    steps.push({
      name: 'write .env (random local secrets)',
      cmd: ['node', 'infra/scripts/local-env.mjs'],
    });
  steps.push(
    { name: 'check .env is a local development environment', check: 'env' },
    { name: 'check that the ports the demo needs are free', check: 'ports' },
  );
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
  if (startWorker) {
    steps.push({
      name: 'start the face-match worker on the host (optional; needs Python 3.12; not waited for)',
      app: 'worker',
    });
  }
  return steps;
}

/**
 * A hint for a failed step (pure): `P1000` (authentication failed) from the migrations or the seed means
 * the database volume was created with another .env's POSTGRES_PASSWORD (Postgres applies it only on
 * the first start), so the fix is a fresh volume of the demo's own project, never a reset.
 */
export function failureHint(cmd, output, project) {
  if (!/\bP1000\b|authentication failed/i.test(output)) return '';
  const stepName = cmd.join(' ');
  if (!/db:(migrate|seed)/.test(stepName)) return '';
  const own = project === DEMO_PROJECT_NAME;
  return (
    `\ndemo-up: the database refused the password in .env (P1000). The volume ${project}_postgres_data ` +
    `belongs to another .env: Postgres applies POSTGRES_PASSWORD only when the volume is first created. ` +
    (own
      ? `Restore the .env this demo was first started with, or ask a person to remove the demo's own volumes (\`docker volume rm ${project}_postgres_data\`; demo data only). `
      : `This run used the compose project "${project}" (COMPOSE_PROJECT_NAME is set). Unset it so the demo uses its own project, "${DEMO_PROJECT_NAME}". `) +
    `Never run db:reset or db push for this; the dev stack's data (project "${DEV_PROJECT}") is not touched by the demo.`
  );
}

/** The summary printed at the end (pure). `invite` is the output of demo-invite.mjs, or ''. */
export function summary({ invite, appsStarted, workerStatus = 'skipped' }) {
  const lines = [
    '',
    'Local demo is ready.',
    '',
    `  Web app (staff sign-in) ${WEB_LOGIN}`,
    `  API health              ${API_HEALTH}`,
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
  lines.push('', `  Face-match worker: ${workerStatus}`);
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

function run(root, cmd, { capture = false, env, watch = false } = {}) {
  // `watch` also pipes stderr, echoed unchanged, so a known failure can get a hint.
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: root,
    stdio: capture
      ? ['ignore', 'pipe', 'inherit']
      : watch
        ? ['inherit', 'inherit', 'pipe']
        : 'inherit',
    encoding: 'utf8',
    ...(env === undefined ? {} : { env }),
  });
  if (watch && r.stderr) process.stderr.write(r.stderr);
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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

function startApp(root, name, cmd, env) {
  const dir = join(root, '.demo');
  mkdirSync(dir, { recursive: true });
  const log = openSync(join(dir, `${name}.log`), 'a');
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    ...(env === undefined ? {} : { env }),
  });
  child.unref();
  const file = join(dir, 'pids.json');
  const pids = existsSync(file) ? parsePids(readFileSync(file, 'utf8')) : {};
  pids[name] = child.pid;
  writeFileSync(file, JSON.stringify(pids));
}

/**
 * Starts the face-match worker natively (apps/worker/tools/be08/run-local.sh, DL-57). It is optional: if
 * Python 3.12 is missing, the command is printed instead; if it does not answer in time, a warning is
 * printed and the demo goes on. It is not waited for: the first run installs large packages.
 */
async function startWorkerStep(root) {
  const command = `WORKER_OBJECT_STORE_BUCKET=<media bucket> ${WORKER_SCRIPT}`;
  if (await isUp(WORKER_HEALTH)) {
    console.log('already running, left alone.');
    return 'running';
  }
  if (spawnSync('python3.12', ['--version'], { stdio: 'ignore' }).status !== 0) {
    console.log(
      `Python 3.12 was not found, so the worker is not started. To start it later: ${command}`,
    );
    return `not started (Python 3.12 missing); command: ${command}`;
  }
  const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
  const workerEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) if (k.startsWith('WORKER_')) workerEnv[k] = v;
  if (!workerEnv.WORKER_OBJECT_STORE_ORIGINS && env.S3_ENDPOINT)
    workerEnv.WORKER_OBJECT_STORE_ORIGINS = env.S3_ENDPOINT;
  if (!workerEnv.WORKER_OBJECT_STORE_BUCKET)
    workerEnv.WORKER_OBJECT_STORE_BUCKET = env.S3_MEDIA_BUCKET ?? 'codeproctor-media';
  startApp(root, 'worker', ['bash', WORKER_SCRIPT], workerEnv);
  console.log(
    'started in the background (the first run installs packages and can take several minutes; log: .demo/worker.log; it answers at ' +
      WORKER_HEALTH +
      ' when ready).',
  );
  return `starting in the background (log .demo/worker.log; ready when ${WORKER_HEALTH} answers; no face models yet, so identity checks go to MANUAL_REVIEW)`;
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !['--dry-run', '--no-apps', '--no-worker'].includes(a));
  if (unknown.length > 0) {
    console.error('demo-up: usage: pnpm demo:up [--dry-run] [--no-apps] [--no-worker]');
    process.exit(1);
  }
  const dry = args.includes('--dry-run');
  const startApps = !args.includes('--no-apps');
  const startWorker = startApps && !args.includes('--no-worker');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const steps = planSteps({
    hasEnv: existsSync(join(root, '.env')),
    hasModules: existsSync(join(root, 'node_modules')),
    startApps,
    startWorker,
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
  let workerStatus = startWorker ? 'not started' : 'skipped (--no-worker)';
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
      if (!env.MINIO_ROOT_PASSWORD || env.MINIO_ROOT_PASSWORD.includes('change-me')) {
        console.error(
          'demo-up: .env has no real MINIO_ROOT_PASSWORD (it is from before the local object store, or hand-copied). Delete .env and run demo:up again to write a fresh one, or set MINIO_ROOT_USER, MINIO_ROOT_PASSWORD and the S3_* values by hand.',
        );
        process.exit(1);
      }
      continue;
    }
    if (step.check === 'ports') {
      const ourCompose = join(root, 'infra/docker-compose.yml');
      const project = demoProject();
      // The dev stack's containers too: they hold the same ports, whatever the project.
      const projects = project === DEV_PROJECT ? [project] : [project, DEV_PROJECT];
      const containers = projects.flatMap((p) => dockerContainers(p));
      const problems = [];
      const foreign = foreignContainers(dockerContainers(project), ourCompose);
      if (foreign.length > 0) problems.push(foreignMessage(foreign, project));
      for (const spec of DEMO_PORTS) {
        if (spec.kind === 'api' && !startApps) continue;
        if (spec.kind === 'web' && !startApps) continue;
        if (spec.kind === 'worker' && !startWorker) continue;
        const free = await isFree(spec.port);
        const url = { api: API_HEALTH, web: WEB_LOGIN, worker: WORKER_HEALTH }[spec.kind];
        const ourAppUp = !free && url !== undefined && (await isUp(url));
        const verdict = judgePort({ spec, free, containers, ourCompose, ourAppUp });
        if (!verdict.ok) problems.push(verdict.message);
        else if (verdict.note) console.log(verdict.note);
      }
      if (problems.length > 0) {
        console.error('\ndemo-up: cannot start, a port is taken:');
        for (const message of problems) console.error(`  - ${message}`);
        process.exit(1);
      }
      console.log('ports are free.');
      continue;
    }
    if (step.app === 'worker') {
      workerStatus = await startWorkerStep(root);
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
    const r = run(root, step.cmd, {
      capture: step.capture !== undefined,
      env: composeEnv(),
      watch: /db:(migrate|seed)/.test(step.cmd.join(' ')),
    });
    if (!r.ok) {
      console.error(`demo-up: step ${n} failed: ${step.cmd.join(' ')}`);
      const hint = failureHint(step.cmd, r.stderr, demoProject());
      if (hint !== '') console.error(hint);
      process.exit(1);
    }
    if (step.capture === 'invite') invite = r.stdout;
  }
  console.log(summary({ invite, appsStarted: startApps, workerStatus }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
