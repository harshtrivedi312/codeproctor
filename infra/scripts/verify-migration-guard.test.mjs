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
    assert.deepEqual(ensureBase(clone), { ok: true, headRef: 'HEAD' });
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

  it('a rename is caught (it shows as a removal plus an addition)', () => {
    const clone = ciCheckout('renames', (r) =>
      git(
        r,
        'mv',
        'prisma/migrations/20261002000001_init',
        'prisma/migrations/20261002000009_renamed',
      ),
    );
    const result = migrationChanges(clone);
    assert.equal(result.ok, true);
    assert.deepEqual(result.changed, [`D\t${M1}`]);
  });

  it('a bare file directly under prisma/migrations is flagged', () => {
    const clone = ciCheckout('bare', (r) => write(r, 'prisma/migrations/foo.sql', 'SELECT 1;\n'));
    assert.deepEqual(migrationChanges(clone), {
      ok: true,
      changed: ['A\tprisma/migrations/foo.sql'],
    });
  });

  it('a path with unusual characters inside an existing directory is flagged, not quoted away', () => {
    const clone = ciCheckout('odd', (r) =>
      write(r, 'prisma/migrations/20261002000001_init/caf\u00e9 \u00fc.sql', 'SELECT 1;\n'),
    );
    const result = migrationChanges(clone);
    assert.equal(result.ok, true);
    assert.equal(result.changed.length, 1);
  });

  it('works on the checkout actions/checkout makes: a detached depth-1 PR merge commit', () => {
    // main moves on after the PR branched, and GitHub's refs/pull/N/merge is a merge of both.
    const run = (name, change) => {
      git(origin, 'checkout', '-q', '-B', name, 'main');
      change(origin);
      git(origin, 'add', '-A');
      git(origin, 'commit', '-q', '-m', name);
      git(origin, 'checkout', '-q', 'main');
      write(origin, `moved-${name}.txt`, 'main moved');
      git(origin, 'add', '-A');
      git(origin, 'commit', '-q', '-m', `main after ${name}`);
      git(origin, 'checkout', '-q', '--detach', 'main');
      git(origin, 'merge', '-q', '--no-ff', '-m', `merge ${name}`, name);
      git(origin, 'update-ref', `refs/pull/${name}/merge`, 'HEAD');
      git(origin, 'checkout', '-q', 'main');
      const clone = join(root, `pr-${name}`);
      mkdirSync(clone);
      git(clone, 'init', '-q');
      git(clone, 'remote', 'add', 'origin', `file://${origin}`);
      git(
        clone,
        'fetch',
        '-q',
        '--no-tags',
        '--depth=1',
        'origin',
        `+refs/pull/${name}/merge:refs/remotes/pull/${name}/merge`,
      );
      git(clone, 'checkout', '-q', '--detach', `refs/remotes/pull/${name}/merge`);
      return clone;
    };
    const good = run('prgood', (r) =>
      write(r, 'prisma/migrations/20261004000001_new/migration.sql', 'SELECT 1;\n'),
    );
    assert.equal(git(good, 'rev-parse', '--is-shallow-repository'), 'true');
    assert.deepEqual(migrationChanges(good), { ok: true, changed: [] });
    const bad = run('prbad', (r) => write(r, M1, 'CREATE TABLE a (id text);\n'));
    assert.deepEqual(migrationChanges(bad), { ok: true, changed: [`M\t${M1}`] });
  });

  it('FR-105: when main moves during the run and the checked-out merge commit can no longer be fetched, it compares the current merge ref', () => {
    // GitHub builds refs/pull/N/merge from main and the PR, and rebuilds it when main moves.
    const build = (name, change) => {
      git(origin, 'checkout', '-q', '-B', name, 'main');
      change(origin);
      git(origin, 'add', '-A');
      git(origin, 'commit', '-q', '-m', name);
      git(origin, 'checkout', '-q', '--detach', 'main');
      git(origin, 'merge', '-q', '--no-ff', '-m', `merge ${name} 1`, name);
      git(origin, 'update-ref', `refs/pull/77/merge`, 'HEAD');
      git(origin, 'checkout', '-q', 'main');
      const clone = join(root, `moved-${name}`);
      mkdirSync(clone);
      git(clone, 'init', '-q');
      git(clone, 'remote', 'add', 'origin', `file://${origin}`);
      git(
        clone,
        'fetch',
        '-q',
        '--no-tags',
        '--depth=1',
        'origin',
        '+refs/pull/77/merge:refs/remotes/pull/77/merge',
      );
      git(clone, 'checkout', '-q', '--detach', 'refs/remotes/pull/77/merge');
      // Main moves on; GitHub rebuilds the merge ref, and the old merge commit is unreachable.
      write(origin, `moved-after-${name}.txt`, 'main moved');
      git(origin, 'add', '-A');
      git(origin, 'commit', '-q', '-m', `main moved after ${name}`);
      git(origin, 'checkout', '-q', '--detach', 'main');
      git(origin, 'merge', '-q', '--no-ff', '-m', `merge ${name} 2`, name);
      git(origin, 'update-ref', 'refs/pull/77/merge', 'HEAD');
      git(origin, 'checkout', '-q', 'main');
      return clone;
    };
    const options = { githubRef: 'refs/pull/77/merge', headBySha: false };
    const good = build('movedgood', (r) =>
      write(r, 'prisma/migrations/20261005000001_x/migration.sql', 'SELECT 1;\n'),
    );
    assert.deepEqual(migrationChanges(good, options), { ok: true, changed: [] });
    const bad = build('movedbad', (r) => write(r, M1, 'CREATE TABLE a (id text);\n'));
    assert.deepEqual(migrationChanges(bad, options), { ok: true, changed: [`M\t${M1}`] });
  });

  it('without a usable merge ref it reports, never passes, when the checked-out commit cannot be fetched', () => {
    const clone = ciCheckout('noref', (r) => write(r, 'z.txt', 'z'));
    const result = migrationChanges(clone, { githubRef: undefined, headBySha: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /share no history/);
  });

  it('a GITHUB_REF that is not a pull-request merge ref is never fetched', () => {
    const clone = ciCheckout('oddref', (r) => write(r, 'q.txt', 'q'));
    const result = migrationChanges(clone, { githubRef: 'refs/heads/main', headBySha: false });
    assert.equal(result.ok, false);
  });

  it('a complete clone is never made shallow by the guard', () => {
    const full = join(root, 'full');
    git(root, 'clone', '-q', '--single-branch', '--branch', 'edits', `file://${origin}`, full);
    assert.equal(git(full, 'rev-parse', '--is-shallow-repository'), 'false');
    const result = migrationChanges(full);
    assert.equal(result.ok, true);
    assert.equal(git(full, 'rev-parse', '--is-shallow-repository'), 'false');
  });

  it('reports, never passes, when the base cannot be fetched', () => {
    const clone = ciCheckout('offline', (r) => write(r, 'y.txt', 'y'));
    git(clone, 'remote', 'set-url', 'origin', join(root, 'does-not-exist'));
    const result = migrationChanges(clone);
    assert.equal(result.ok, false);
    assert.match(result.reason, /git fetch origin main failed/);
  });
});
