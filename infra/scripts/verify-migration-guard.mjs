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

const scrub = (text) =>
  text
    .trim()
    .replace(/\/\/[^@/\s]+@/g, '//')
    .slice(0, 200);
const MAIN = 'main:refs/remotes/origin/main';

/**
 * Makes origin/main and a merge base available. A complete clone gets a plain fetch of main. A
 * shallow one (a CI checkout: depth 1, no origin/main) gets main at limited depth and is then
 * deepened in steps until a merge base exists. A complete clone is never made shallow.
 * The fetch is anonymous https for this public repository (a CI checkout keeps no credentials).
 * @returns {{ ok: boolean, reason?: string }}
 */
export function ensureBase(cwd, { steps = 6, deepen = 100 } = {}) {
  if (hasBase(cwd)) return { ok: true };
  const shallow = git(cwd, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
  const first = git(cwd, [
    'fetch',
    '--no-tags',
    ...(shallow ? [`--depth=${deepen}`] : []),
    'origin',
    MAIN,
  ]);
  if (first.status !== 0)
    return { ok: false, reason: `git fetch origin main failed: ${scrub(first.stderr)}` };
  // Deepen main AND the commit that is checked out: the PR merge commit is on no configured
  // refspec, so deepening main alone would never connect the two histories. Naming both also keeps
  // the fetch to those two (without refspecs a CI checkout would fetch every branch head).
  const head = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  for (let i = 0; shallow && i < steps && !hasBase(cwd); i++) {
    const more = git(cwd, ['fetch', '--no-tags', `--deepen=${deepen}`, 'origin', MAIN, head]);
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
  // -z: NUL-separated, so a path with unusual characters is never quoted by git.
  const diff = git(cwd, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    'origin/main...HEAD',
    '--',
    'prisma/migrations',
  ]);
  if (diff.status !== 0) return { ok: false, reason: `git diff failed: ${scrub(diff.stderr)}` };
  const tokens = diff.stdout.split('\0').filter((t) => t !== '');
  const changed = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [status, path] = [tokens[i], tokens[i + 1]];
    if (status === 'A') {
      // A new file is fine only inside a NEW migration directory. The check is against the tip of
      // origin/main, which is stricter than the merge base: a name main already uses is refused.
      const parts = path.split('/');
      const inExistingDir =
        parts.length < 4 ||
        git(cwd, ['cat-file', '-e', `origin/main:${parts.slice(0, 3).join('/')}`]).status === 0;
      if (!inExistingDir) continue;
    }
    changed.push(`${status}\t${path}`);
  }
  return { ok: true, changed };
}
