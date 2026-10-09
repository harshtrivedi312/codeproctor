// Port checks for `pnpm demo:up` (docs/local-run.md): stop with a clear message when a port the demo
// needs is already in use, name what holds it, and say how to free it. It never stops, restarts or
// reuses another stack's containers: another checkout's local stack (the same compose project name) is
// a clash to report, not something to take over.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

/** The dev stack's compose project (`name:` in infra/docker-compose.yml) and the demo's own. */
export const DEV_PROJECT = 'codeproctor';
export const DEMO_PROJECT = 'codeproctor-demo';

/**
 * The compose project the demo uses: its own (`codeproctor-demo`), so its volumes never are the dev
 * stack's (the dev volume was initialised with another .env's passwords). COMPOSE_PROJECT_NAME in the
 * environment still wins, for someone who chooses a project on purpose.
 */
export function demoProject(env = process.env) {
  const name = env.COMPOSE_PROJECT_NAME;
  return typeof name === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(name) ? name : DEMO_PROJECT;
}

/** The environment for the docker compose commands the demo runs (pnpm dev:infra, dev:infra:down). */
export function composeEnv(env = process.env) {
  return { ...env, COMPOSE_PROJECT_NAME: demoProject(env) };
}

/** Every port the demo binds on 127.0.0.1, with what uses it. `kind` says who must be free of it. */
export const DEMO_PORTS = [
  { port: 5432, name: 'PostgreSQL', kind: 'infra' },
  { port: 6379, name: 'Redis', kind: 'infra' },
  { port: 8080, name: 'Adminer', kind: 'infra' },
  { port: 1025, name: 'Mailpit (SMTP)', kind: 'infra' },
  { port: 8025, name: 'Mailpit (web)', kind: 'infra' },
  { port: 9000, name: 'MinIO (S3 API)', kind: 'infra' },
  { port: 9001, name: 'MinIO (console)', kind: 'infra' },
  { port: 4000, name: 'the API', kind: 'api' },
  { port: 3000, name: 'the web app', kind: 'web' },
  { port: 8000, name: 'the face-match worker', kind: 'worker' },
];

/** True when nothing listens on 127.0.0.1:port. */
export function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * The containers of one compose project (running or stopped), from `docker ps -a`: [{ name, configFiles, ports }]. Reads only;
 * a missing docker gives an empty list.
 */
export function dockerContainers(project = DEV_PROJECT) {
  const r = spawnSync(
    'docker',
    [
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      '{{.Names}}\t{{.Label "com.docker.compose.project.config_files"}}\t{{.Ports}}',
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return [];
  return parseDockerPs(r.stdout).map((c) => ({ ...c, project }));
}

/** Pure: `docker ps` lines to containers with the host ports they publish. */
export function parseDockerPs(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const [name, configFiles = '', ports = ''] = line.split('\t');
    if (!name) continue;
    // `127.0.0.1:5432->5432/tcp`, or a range `127.0.0.1:9000-9001->9000-9001/tcp` (docker joins
    // consecutive ports of one container into one entry).
    const published = [
      ...ports.matchAll(/(?:\d+\.\d+\.\d+\.\d+|\[::\]|::):(\d+)(?:-(\d+))?->/g),
    ].flatMap((m) => {
      const from = Number(m[1]);
      const to = m[2] === undefined ? from : Number(m[2]);
      return to >= from && to - from < 1000
        ? Array.from({ length: to - from + 1 }, (_, k) => from + k)
        : [from];
    });
    out.push({ name, configFiles: configFiles.split(',').filter(Boolean), ports: published });
  }
  return out;
}

/**
 * Pure: containers of the demo's compose project that belong to ANOTHER checkout, running or
 * stopped. `docker compose up` here would recreate them and reuse their named volumes, which is taking
 * another stack over, so any such container is a clash even when its ports are free.
 */
export function foreignContainers(containers, ourCompose) {
  return containers.filter((c) => c.configFiles.length > 0 && !c.configFiles.includes(ourCompose));
}

export function foreignMessage(foreign, project = DEMO_PROJECT) {
  const names = foreign.map((c) => c.name).join(', ');
  const where = foreign[0]?.configFiles[0] ?? 'another checkout';
  return (
    `The compose project "${project}" already has containers from another checkout (${names}; ${where}). ` +
    `They share this project's name and volumes, so starting the stack here would recreate them and reuse their data. ` +
    `demo:up never stops or reuses another stack's containers. Fix: from that checkout run \`pnpm dev:infra:down\` ` +
    `(this keeps its data), then run demo:up again.`
  );
}

/**
 * Pure: is `port` fine for this run? `free` says nothing listens on it; `containers` is parseDockerPs
 * output; `ourCompose` is the absolute path of this checkout's infra/docker-compose.yml; `ourAppUp` says
 * an app of ours already answers its health URL on that port.
 * Returns { ok: true, note? } or { ok: false, message }.
 */
export function judgePort({
  spec,
  free,
  containers,
  ourCompose,
  ourAppUp,
  project = DEMO_PROJECT,
}) {
  if (free) return { ok: true };
  const holder = containers.find((c) => c.ports.includes(spec.port));
  if (holder !== undefined) {
    // Ours only in the demo's own project: this checkout's dev stack (project `codeproctor`) holds the same
    // ports and `docker compose up` for the demo would fail on them.
    if (holder.configFiles.includes(ourCompose) && (holder.project ?? project) === project) {
      return {
        ok: true,
        note: `${spec.name} (port ${spec.port}) is held by this checkout's own stack.`,
      };
    }
    const where = holder.configFiles[0] ?? 'another compose project';
    return {
      ok: false,
      message:
        `Port ${spec.port} (${spec.name}) is already in use by the container ${holder.name}, which belongs to another stack (${where}). ` +
        `demo:up never stops or reuses another stack's containers. Fix: from that checkout run \`pnpm dev:infra:down\` ` +
        `(or stop that container yourself), then run demo:up again.`,
    };
  }
  if (spec.kind !== 'infra' && ourAppUp) {
    return { ok: true, note: `${spec.name} (port ${spec.port}) is already running; left alone.` };
  }
  return {
    ok: false,
    message:
      `Port ${spec.port} (${spec.name}) is already in use by a program that is not one of this demo's containers. ` +
      `Fix: stop that program (on macOS: \`lsof -nP -iTCP:${spec.port} -sTCP:LISTEN\` shows which), then run demo:up again.`,
  };
}
