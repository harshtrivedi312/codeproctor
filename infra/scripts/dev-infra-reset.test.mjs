// Safety paths of infra/scripts/dev-infra-reset (review N14, SF5). Same method as
// db-reset.test.mjs: explicit environment, stand-in docker. A stand-in call other than
// `docker context inspect` would be destructive, so each case asserts the log stays empty.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { REPO_ROOT, createSandbox } from './test-support.mjs';

function runDevInfraReset(extraEnv = {}) {
  const sandbox = createSandbox();
  try {
    const result = spawnSync('/bin/sh', ['infra/scripts/dev-infra-reset'], {
      cwd: REPO_ROOT,
      env: sandbox.env(extraEnv),
      encoding: 'utf8',
      input: '',
    });
    return { ...result, reachedDestructiveCommand: existsSync(sandbox.log) };
  } finally {
    sandbox.remove();
  }
}

function assertRefused(result, messagePattern) {
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, messagePattern);
  assert.equal(result.reachedDestructiveCommand, false, 'docker was asked to do something');
}

test('NFR-04: CI=1 is refused', () => {
  assertRefused(runDevInfraReset({ CI: '1' }), /never runs in CI/);
});

test('NFR-04: a non-unix DOCKER_HOST is refused', () => {
  for (const host of [
    'tcp://remote.example.com:2375',
    'ssh://deploy@staging.example.com',
    'npipe:////./pipe/docker_engine',
  ]) {
    assertRefused(runDevInfraReset({ DOCKER_HOST: host }), /DOCKER_HOST is not a unix:\/\/ socket/);
  }
});

test('NFR-04: a Docker context that is not a unix socket is refused', () => {
  for (const host of ['tcp://remote.example.com:2376', 'ssh://deploy@staging.example.com', '']) {
    assertRefused(
      runDevInfraReset({ FAKE_CONTEXT_HOST: host }),
      /current Docker context is not a unix:\/\/ socket/,
    );
  }
});

test('NFR-04: it is refused when the Docker context cannot be read', () => {
  assertRefused(
    runDevInfraReset({ FAKE_CONTEXT_FAIL: '1' }),
    /current Docker context is not a unix:\/\/ socket/,
  );
});

test('NFR-04: with local Docker and no terminal it refuses with the "needs a human" message', () => {
  assertRefused(runDevInfraReset(), /needs a human at a terminal/);
  assertRefused(
    runDevInfraReset({ DOCKER_HOST: 'unix:///var/run/docker.sock' }),
    /needs a human at a terminal/,
  );
});
