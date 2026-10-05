// Helpers for the script tests. Not a test file itself.
//
// Each sandbox is a directory that holds `node` plus stand-ins for `docker` and `pnpm`. A test
// spawns a script with PATH set to that directory plus /usr/bin:/bin and nothing inherited from
// the caller, so the real docker and pnpm can never be reached. The pnpm stand-in and every
// unexpected docker call write to a log, and tests assert that the log stays empty: that proves a
// script stopped before anything destructive.
//
// A stand-in logs one line with the command, then one line per argument, each starting with a tab
// (see LOG_CALL and readCalls). An argument that contains a space stays one line, so a test can tell
// `--name "two words"` from `--name two words` and catch a regression of the "$@" quoting.
//
// Tests of infra/scripts/db-migrate need a pnpm call that succeeds (FAKE_PNPM_EXIT=0) and a way
// to see whether the password script was started. createSandbox({ stubPasswordScript: true })
// replaces `node` with a shim: it logs a call to set-app-user-password.mjs and does not run it,
// and it runs the real node for everything else, so the localhost guard still runs for real.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Shell lines that append one call to the log: the command, then one tab-indented line per argument. */
const LOG_CALL = (command) => `{
  printf '%s\\n' "${command}"
  for arg in "$@"; do printf '\\t%s\\n' "$arg"; done
} >> "$STUB_LOG"`;

/**
 * Reads the log a stand-in wrote: one entry per call.
 * @param {string} text the contents of the log file
 * @returns {{ command: string, args: string[] }[]}
 */
export function readCalls(text) {
  const calls = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('\t')) calls.at(-1)?.args.push(line.slice(1));
    else calls.push({ command: line, args: [] });
  }
  return calls;
}

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
${LOG_CALL('docker')}
exit 99
`;

const PNPM_STUB = `#!/bin/sh
${LOG_CALL('pnpm')}
exit "\${FAKE_PNPM_EXIT:-99}"
`;

const nodeShim = (realNode) => `#!/bin/sh
case "$1" in
  infra/scripts/set-app-user-password.mjs)
    ${LOG_CALL('node')}
    exit "\${FAKE_PASSWORD_SCRIPT_EXIT:-0}"
    ;;
esac
exec "${realNode}" "$@"
`;

/**
 * @param {{ stubPasswordScript?: boolean }} [options]
 * @returns {{ dir: string, log: string, env: (extra?: Record<string, string>) => Record<string, string>, remove: () => void }}
 */
export function createSandbox(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codeproctor-script-test-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (options.stubPasswordScript) {
    writeFileSync(join(bin, 'node'), nodeShim(process.execPath), { mode: 0o755 });
  } else {
    symlinkSync(process.execPath, join(bin, 'node'));
  }
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
