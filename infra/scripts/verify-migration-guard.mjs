// The "an applied migration is never edited or removed" guard (FR-105, forward-only migrations).
// It compares prisma/migrations with origin/main, and fetches what it needs when the checkout is
// shallow (a CI checkout has depth 1 and no origin/main). Not a test file.
import { spawnSync } from 'node:child_process';

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const ok = (cwd, args) => git(cwd, args).status === 0;

/** True when origin/main exists and shares history with `headRef`. */
function hasBase(cwd, headRef = 'HEAD') {
  return (
    ok(cwd, ['rev-parse', '--verify', '--quiet', 'origin/main']) &&
    ok(cwd, ['merge-base', 'origin/main', headRef])
  );
}

/** The ref a CI pull-request checkout was made from (GitHub moves it when main moves). */
const PR_MERGE_REF = /^refs\/pull\/\d+\/merge$/;

/**
 * The second parent (the pull-request head) of the checked-out commit, read from the raw object:
 * `HEAD^2` fails in a shallow clone, whose parents are cut off. Null when HEAD is not a merge commit.
 */
function secondParent(cwd) {
  const parents = git(cwd, ['cat-file', '-p', 'HEAD'])
    .stdout.split('\n')
    .filter((line) => line.startsWith('parent '));
  return parents.length >= 2 ? parents[1].slice('parent '.length).trim() : null;
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
 *
 * When main moves during a CI run, GitHub moves `refs/pull/N/merge` to a new merge commit and the one
 * that was checked out becomes unreachable, so fetching it by SHA is refused. Then the guard fetches
 * the current merge ref itself (`githubRef`, from GITHUB_REF) and compares that: it holds the same pull
 * request content on top of the new main. `headBySha: false` forces that path (a test knob).
 * It only does so when the new merge commit has the same pull-request head as the checked-out one
 * (same second parent): the guard must judge exactly the content CI tested. The base is then that
 * merge commit's own first parent, the main it was merged onto. `headBySha` is a test knob.
 * @returns {{ ok: boolean, reason?: string, headRef?: string, baseRef?: string }}
 */
export function ensureBase(
  cwd,
  { steps = 6, deepen = 100, githubRef = process.env.GITHUB_REF, headBySha = true } = {},
) {
  if (hasBase(cwd)) return { ok: true, headRef: 'HEAD', baseRef: 'origin/main' };
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
  let headRef = 'HEAD';
  let viaRef = false;
  for (let i = 0; shallow && i < steps && !hasBase(cwd, headRef); i++) {
    const more =
      headBySha && !viaRef
        ? git(cwd, ['fetch', '--no-tags', `--deepen=${deepen}`, 'origin', MAIN, head])
        : { status: 1, stderr: '' };
    if (more.status === 0) continue;
    if (viaRef) break;
    if (typeof githubRef !== 'string' || !PR_MERGE_REF.test(githubRef)) break;
    const wanted = secondParent(cwd);
    if (wanted === null) break; // not a merge commit: another checkout shape, nothing to follow
    const fetched = git(cwd, [
      'fetch',
      '--no-tags',
      `--depth=${deepen}`,
      'origin',
      `+${githubRef}:refs/remotes/pr-merge`,
    ]);
    if (fetched.status !== 0) break;
    const got = git(cwd, [
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/pr-merge^2',
    ]).stdout.trim();
    if (got !== wanted) {
      return {
        ok: false,
        reason: 'the pull request head moved during the run: not comparing different content',
      };
    }
    headRef = 'refs/remotes/pr-merge';
    viaRef = true;
  }
  if (!hasBase(cwd, headRef))
    return {
      ok: false,
      reason: `origin/main and ${headRef} share no history within the fetched depth`,
    };
  return { ok: true, headRef, baseRef: viaRef ? 'refs/remotes/pr-merge^1' : 'origin/main' };
}

/**
 * Migration files that differ from origin/main other than by being new files in a new directory.
 * @returns {{ ok: false, reason: string } | { ok: true, changed: string[] }}
 */
export function migrationChanges(cwd, options = {}) {
  const base = ensureBase(cwd, options);
  if (!base.ok) return { ok: false, reason: base.reason ?? 'no base' };
  // -z: NUL-separated, so a path with unusual characters is never quoted by git.
  const diff = git(cwd, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    `${base.baseRef ?? 'origin/main'}...${base.headRef ?? 'HEAD'}`,
    '--',
    'prisma/migrations',
  ]);
  if (diff.status !== 0) return { ok: false, reason: `git diff failed: ${scrub(diff.stderr)}` };
  const tokens = diff.stdout.split('\0').filter((t) => t !== '');
  const changed = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [status, path] = [tokens[i], tokens[i + 1]];
    if (status === 'A') {
      // A new file is fine only inside a NEW migration directory. The check is against the base ref
      // (origin/main, or the new merge commit's first parent), which is stricter than the merge base: a name main already uses is refused.
      const parts = path.split('/');
      const inExistingDir =
        parts.length < 4 ||
        git(cwd, [
          'cat-file',
          '-e',
          `${base.baseRef ?? 'origin/main'}:${parts.slice(0, 3).join('/')}`,
        ]).status === 0;
      if (!inExistingDir) continue;
    }
    changed.push(`${status}\t${path}`);
  }
  return { ok: true, changed };
}
