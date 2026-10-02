// Helpers for the script tests. Not a test file itself.
//
// Each sandbox is a directory that holds `node` plus stand-ins for `docker` and `pnpm`. A test
// spawns a script with PATH set to that directory plus /usr/bin:/bin and nothing inherited from
// the caller, so the real docker and pnpm can never be reached. The pnpm stand-in and every
// unexpected docker call write to a log, and tests assert that the log stays empty: that proves a
// script stopped before anything destructive.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Behaviour comes from FAKE_* variables that the test puts into the spawned environment.
const DOCKER_STUB = `#!/bin/sh
if [ "$1" = "context" ] && [ "$2" = "inspect" ]; then
  if [ -n "\${FAKE_CONTEXT_FAIL:-}" ]; then exit 1; fi
  echo "\${FAKE_CONTEXT_HOST-unix:///var/run/docker.sock}"
  exit 0
fi
if [ "$*" = "compose -f infra/docker-compose.yml port postgres 5432" ]; then
  if [ -n "\${FAKE_COMPOSE_FAIL:-}" ]; then echo 'service "postgres" is not running' >&2; exit 1; fi
  echo "\${FAKE_COMPOSE_PORT_OUTPUT:-}"
  exit 0
fi
echo "docker $*" >> "$STUB_LOG"
exit 99
`;

const PNPM_STUB = `#!/bin/sh
echo "pnpm $*" >> "$STUB_LOG"
exit 99
`;

/** @returns {{ dir: string, log: string, env: (extra?: Record<string, string>) => Record<string, string>, remove: () => void }} */
export function createSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'codeproctor-script-test-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'pnpm'), PNPM_STUB, { mode: 0o755 });
  const log = join(dir, 'stub.log');
  return {
    dir,
    log,
    env: (extra = {}) => ({ PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: log, ...extra }),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
