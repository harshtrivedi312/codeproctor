// Stops what `pnpm demo:up` started (docs/local-run.md):
//
//   pnpm demo:down [--infra]
//
// Stops the API and the web app (the process groups recorded in .demo/pids.json) and removes the
// record. With --infra it also stops the containers (pnpm dev:infra:down); the data stays in the Docker
// volumes. Never deletes data: `pnpm db:reset` (a person, local only) is the way to a clean database.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Process ids from a pids.json text: only positive integers, for names we started. */
export function parsePids(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  const out = {};
  for (const name of ['api', 'web', 'worker']) {
    const pid = data?.[name];
    if (Number.isInteger(pid) && pid > 1) out[name] = pid;
  }
  return out;
}

/**
 * Does `ps -o pgid=,command= -p <pid>` output show a process group leader that we started (a pnpm
 * dev command)? A recorded pid can be stale after a reboot or a crash and belong to something else.
 */
export function looksLikeOurs(psOutput, pid) {
  const m = /^\s*(\d+)\s+(.*)$/.exec(psOutput.trim());
  if (m === null) return false;
  if (Number(m[1]) !== pid) return false;
  const command = m[2];
  // The API and the web app start through pnpm; the worker through its run-local.sh or uvicorn.
  if (/\bpnpm\b/.test(command) && /\bdev(:api|:web)?\b/.test(command)) return true;
  return /run-local\.sh|\buvicorn\b.*\bworker\.app:app\b/.test(command);
}

function ownsPid(pid) {
  const r = spawnSync('ps', ['-o', 'pgid=,command=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && looksLikeOurs(r.stdout, pid);
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--infra')) {
    console.error('demo-down: usage: pnpm demo:down [--infra]');
    process.exit(1);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const file = join(root, '.demo/pids.json');
  if (existsSync(file)) {
    for (const [name, pid] of Object.entries(parsePids(readFileSync(file, 'utf8')))) {
      if (!ownsPid(pid)) {
        console.log(`${name}: the recorded process is gone or is not ours; nothing killed.`);
        continue;
      }
      try {
        process.kill(-pid, 'SIGTERM'); // the whole process group: pnpm and the server under it
        console.log(`stopped ${name}.`);
      } catch {
        console.log(`${name} was not running.`);
      }
    }
    rmSync(file, { force: true });
  } else {
    console.log('no apps recorded in .demo/pids.json.');
  }
  if (args.includes('--infra')) {
    const r = spawnSync('pnpm', ['dev:infra:down'], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
