// The "an applied migration is never edited or removed" guard (FR-105, forward-only migrations).
// It compares prisma/migrations with origin/main, and fetches what it needs when the checkout is
// shallow (a CI checkout has depth 1 and no origin/main). Not a test file.
import { spawnSync } from 'node:child_process';

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const ok = (cwd, args) => git(cwd, args).status === 0;

/** True when origin/main exists and shares history with HEAD. */
function hasBase(cwd) {
  return (
    ok(cwd, ['rev-parse', '--verify', '--quiet', 'origin/main']) &&
    ok(cwd, ['merge-base', 'origin/main', 'HEAD'])
  );
}

/**
 * Makes origin/main and a merge base available: fetches main, then deepens the history in steps.
 * The fetch is anonymous https for this public repository (a CI checkout keeps no credentials).
 * @returns {{ ok: boolean, reason?: string }}
 */
export function ensureBase(cwd, { steps = 6, deepen = 100 } = {}) {
  if (hasBase(cwd)) return { ok: true };
  const fetched = git(cwd, [
    'fetch',
    '--no-tags',
    `--depth=${deepen}`,
    'origin',
    'main:refs/remotes/origin/main',
  ]);
  if (fetched.status !== 0)
    return {
      ok: false,
      reason: `git fetch origin main failed: ${fetched.stderr.trim().slice(0, 200)}`,
    };
  for (let i = 0; i < steps && !hasBase(cwd); i++) {
    const more = git(cwd, ['fetch', '--no-tags', `--deepen=${deepen}`, 'origin']);
    if (more.status !== 0) break;
  }
  if (!hasBase(cwd))
    return { ok: false, reason: 'origin/main and HEAD share no history within the fetched depth' };
  return { ok: true };
}

/**
 * Migration files that differ from origin/main other than by being new files in a new directory.
 * @returns {{ ok: false, reason: string } | { ok: true, changed: string[] }}
 */
export function migrationChanges(cwd) {
  const base = ensureBase(cwd);
  if (!base.ok) return { ok: false, reason: base.reason ?? 'no base' };
  const diff = git(cwd, [
    'diff',
    '--name-status',
    '--no-renames',
    'origin/main...HEAD',
    '--',
    'prisma/migrations',
  ]);
  if (diff.status !== 0)
    return { ok: false, reason: `git diff failed: ${diff.stderr.trim().slice(0, 200)}` };
  const changed = diff.stdout
    .trim()
    .split('\n')
    .filter((l) => {
      if (l === '') return false;
      if (!l.startsWith('A\t')) return true;
      // A new file is fine only inside a NEW migration directory.
      const parts = l.split('\t')[1].split('/');
      if (parts.length < 4) return true;
      return (
        git(cwd, ['cat-file', '-e', `origin/main:${parts.slice(0, 3).join('/')}`]).status === 0
      );
    });
  return { ok: true, changed };
}
