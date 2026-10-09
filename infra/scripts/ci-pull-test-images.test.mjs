// The CI image pre-pull (infra/scripts/ci-pull-test-images.sh) must pin a digest for every image the
// tests start, and the tags must be the ones the tests use, or a version bump in a test would quietly
// start pulling from Docker Hub again (and hit its unauthenticated limit).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = readFileSync(`${root}infra/scripts/ci-pull-test-images.sh`, 'utf8');

const pinned = new Map(
  [...script.matchAll(/^pull_one (\S+) (\S+) (sha256:[0-9a-f]{64})$/gm)].map((m) => [
    `${m[1]}:${m[2]}`,
    m[3],
  ]),
);

function trackedFiles() {
  return execFileSync('git', ['ls-files', 'apps/api/src', 'apps/api/test'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts'));
}

test('FR-105 CI: the pre-pull pins postgres and redis by a sha256 digest', () => {
  assert.ok(pinned.has('postgres:16'), 'postgres:16 is pinned');
  assert.ok(pinned.has('redis:8.8'), 'redis:8.8 is pinned');
});

test('FR-105 CI: every Testcontainers Postgres and Redis image in apps/api is one the script pins', () => {
  const used = new Set();
  for (const file of trackedFiles()) {
    const text = readFileSync(`${root}${file}`, 'utf8');
    for (const m of text.matchAll(/new (?:PostgreSqlContainer|RedisContainer)\(\s*'([^']+)'/g)) {
      used.add(m[1]);
    }
  }
  assert.ok(used.size > 0, 'the test suite starts at least one container');
  for (const image of used) {
    assert.ok(pinned.has(image), `${image} is started by a test but not pinned in ci-pull-test-images.sh`);
  }
});

test('FR-105 CI: the script uses no credentials and no Docker Hub login', () => {
  assert.doesNotMatch(script, /docker login|--password|DOCKERHUB|docker\.io/i);
});
