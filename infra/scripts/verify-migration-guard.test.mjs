// Tests of the migration guard itself (FR-105): a shallow, single-branch clone (what CI checks out)
// must fetch its base and still catch an edited, removed or misplaced migration. Local file
// repositories only; no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ensureBase, migrationChanges } from './verify-migration-guard.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.test',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
    },
  );
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (repo, path, text) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

describe('DB-08 migration guard on a shallow checkout (FR-105)', () => {
  let root;
  let origin;
  const M1 = 'prisma/migrations/20261002000001_init/migration.sql';

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'guard-'));
    origin = join(root, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    write(origin, M1, 'CREATE TABLE a (id int);\n');
    write(origin, 'prisma/migrations/migration_lock.toml', 'provider = "postgresql"\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'init');
    for (let i = 0; i < 3; i++) {
      write(origin, `notes${i}.txt`, `${i}`);
      git(origin, 'add', '-A');
      git(origin, 'commit', '-q', '-m', `main ${i}`);
    }
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  /** A depth-1, single-branch clone of a feature branch made by `change`, like a CI checkout. */
  function ciCheckout(name, change) {
    git(origin, 'checkout', '-q', '-B', name, 'main');
    change(origin);
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', name);
    git(origin, 'checkout', '-q', 'main');
    const clone = join(root, `clone-${name}`);
    git(
      root,
      'clone',
      '-q',
      '--depth=1',
      '--single-branch',
      '--branch',
      name,
      `file://${origin}`,
      clone,
    );
    return clone;
  }

  it('the shallow clone really has no origin/main and a single commit', () => {
    const clone = ciCheckout('probe', (r) => write(r, 'x.txt', 'x'));
    assert.equal(
      spawnSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd: clone }).status,
      1,
    );
    assert.equal(git(clone, 'rev-list', '--count', 'HEAD'), '1');
  });

  it('fetches the base and accepts a new migration directory', () => {
    const clone = ciCheckout('adds', (r) =>
      write(r, 'prisma/migrations/20261003000001_more/migration.sql', 'CREATE TABLE b (id int);\n'),
    );
    assert.deepEqual(ensureBase(clone), { ok: true });
    assert.deepEqual(migrationChanges(clone), { ok: true, changed: [] });
  });

  it('catches an edited migration in a shallow checkout', () => {
    const clone = ciCheckout('edits', (r) => write(r, M1, 'CREATE TABLE a (id bigint);\n'));
    assert.deepEqual(migrationChanges(clone), { ok: true, changed: [`M\t${M1}`] });
  });

  it('catches a removed migration in a shallow checkout', () => {
    const clone = ciCheckout('removes', (r) =>
      rmSync(join(r, 'prisma/migrations/20261002000001_init'), { recursive: true }),
    );
    assert.deepEqual(migrationChanges(clone), { ok: true, changed: [`D\t${M1}`] });
  });

  it('catches a file added inside an existing migration directory', () => {
    const clone = ciCheckout('extra', (r) =>
      write(r, 'prisma/migrations/20261002000001_init/extra.sql', 'SELECT 1;\n'),
    );
    assert.deepEqual(migrationChanges(clone), {
      ok: true,
      changed: ['A\tprisma/migrations/20261002000001_init/extra.sql'],
    });
  });

  it('reports, never passes, when the base cannot be fetched', () => {
    const clone = ciCheckout('offline', (r) => write(r, 'y.txt', 'y'));
    git(clone, 'remote', 'set-url', 'origin', join(root, 'does-not-exist'));
    const result = migrationChanges(clone);
    assert.equal(result.ok, false);
    assert.match(result.reason, /git fetch origin main failed/);
  });
});
