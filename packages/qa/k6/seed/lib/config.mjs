// Reads configuration. Base URL and staff credentials come from environment variables only, at
// run time. argv carries non-secret switches only; an unknown or secret-looking flag is refused.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTarget, parseHost, LOCAL_HOSTS, DENY } from '../../lib/guard.js';
import { assertSyntheticDomain, RUN_ID_RE } from './synthetic.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Inside the repo only the k6 folder's git-ignored patterns are acceptable (packages/qa/k6/.gitignore).
const IGNORED_IN_REPO = /^packages\/qa\/k6\/(?:sessions[^/]*\.json|\.local\/.+)$/;

export const USAGE = `Usage: node seed.mjs [--count N] [--out FILE] [--dry-run] [--allow-partial] [--force]
       node seed.mjs --cleanup --run-id ID [--manifest FILE]
Configuration is read from environment variables only (see seed/README.md).`;

const FLAGS_WITH_VALUE = new Set(['--count', '--out', '--run-id', '--manifest']);
const FLAGS = new Set(['--dry-run', '--cleanup', '--allow-partial', '--force', '--help']);

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) args[a.slice(2)] = true;
    else if (FLAGS_WITH_VALUE.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value.`);
      args[a.slice(2)] = v;
    } else {
      // Never echo the offending token: it could be a secret typed on the command line by mistake.
      throw new Error('Unknown argument. Credentials and URLs go in environment variables.');
    }
  }
  return args;
}

function intIn(name, raw, min, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return n;
}

// Returns the path if it is safe for a file holding bearer tokens, or throws.
export function assertSafeOutPath(file, repoRoot = REPO_ROOT) {
  if (!path.isAbsolute(file)) throw new Error('The output path must be absolute.');
  const resolved = path.resolve(file);
  const rel = path.relative(repoRoot, resolved);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (inside && !IGNORED_IN_REPO.test(rel.split(path.sep).join('/'))) {
    throw new Error(
      'The output path is inside the repository. Use a path outside it, or a git-ignored one ' +
        'under packages/qa/k6 (sessions*.json or .local/).',
    );
  }
  return resolved;
}

export function checkStorageUrl(url, storageAllowedText, apiIsLocal) {
  if (/\\/.test(url)) throw new Error('storage URL refused');
  const bare = url.split(/[?#]/)[0];
  const host = parseHost(bare); // strict pattern; throws otherwise
  if (new URL(url).hostname !== host) throw new Error('storage URL refused');
  if (DENY.some((d) => host.includes(d))) throw new Error('storage URL refused');
  const allowed = (storageAllowedText || '')
    .toLowerCase()
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const local = apiIsLocal && LOCAL_HOSTS.includes(host);
  if (!local && !allowed.includes(host)) throw new Error('storage URL refused');
  if (!local && !bare.toLowerCase().startsWith('https://')) throw new Error('storage URL refused');
  return host;
}

// Validates and normalises. Throws Error with a message that never contains a secret value.
export function loadConfig(argv, env) {
  const args = parseArgs(argv);
  if (args.help) return { help: true };
  const cleanup = Boolean(args.cleanup);
  const dryRun = Boolean(args['dry-run']);
  const missing = [];
  const need = (name) => {
    if (!env[name]) missing.push(name);
    return env[name];
  };

  const apiBase = (need('API_BASE_URL') ?? '').replace(/\/+$/, '');
  let host = null;
  if (apiBase) host = checkTarget(apiBase, env.ALLOWED_HOSTS); // same guard as the k6 scripts
  need('SEED_STAFF_EMAIL');
  need('SEED_STAFF_PASSWORD');
  const orgName = need('SEED_ORG_NAME');
  if (orgName && !/synthetic/i.test(orgName)) {
    throw new Error(
      'SEED_ORG_NAME must name a SYNTHETIC organisation (its name contains "synthetic").',
    );
  }
  const testId = cleanup ? undefined : need('SEED_TEST_ID');
  if (testId && !UUID_RE.test(testId)) throw new Error('SEED_TEST_ID must be a UUID.');

  let mailUrl = null;
  if (!cleanup) {
    mailUrl = (need('SEED_MAIL_URL') ?? '').replace(/\/+$/, '');
    if (mailUrl) checkTarget(mailUrl, env.ALLOWED_HOSTS); // the mail sink holds tokens: same guard
  }
  const domain = assertSyntheticDomain(env.SEED_EMAIL_DOMAIN || 'example.test');
  if (env.SEED_STAFF_TOTP_SECRET !== undefined && env.SEED_STAFF_TOTP_SECRET === '') {
    throw new Error('SEED_STAFF_TOTP_SECRET is set but empty.');
  }

  let out = args.out ?? env.SEED_OUT;
  let count = 0;
  let runId = args['run-id'];
  let manifest = args.manifest;
  if (cleanup) {
    if (!runId) missing.push('--run-id');
    else if (!RUN_ID_RE.test(runId))
      throw new Error('--run-id must look like k6seed-<14 digits>-<6 hex>.');
    if (!manifest && !out) missing.push('--manifest or SEED_OUT');
  } else {
    count = intIn('count', args.count ?? env.SEED_COUNT ?? '200', 1, 1000);
    if (!out && !dryRun) missing.push('--out or SEED_OUT');
  }
  if (out) out = assertSafeOutPath(out);
  if (manifest) manifest = assertSafeOutPath(manifest);
  if (!manifest && out) manifest = `${out}.manifest.json`;

  if (missing.length && !dryRun) {
    throw new Error(`Missing configuration: ${missing.join(', ')}.`);
  }

  return {
    help: false,
    cleanup,
    dryRun,
    allowPartial: Boolean(args['allow-partial']),
    force: Boolean(args.force),
    missing,
    apiBase,
    host,
    apiIsLocal: host !== null && LOCAL_HOSTS.includes(host),
    storageAllowed: env.STORAGE_ALLOWED_HOSTS || '',
    staff: {
      email: env.SEED_STAFF_EMAIL,
      password: env.SEED_STAFF_PASSWORD,
      totpSecret: env.SEED_STAFF_TOTP_SECRET,
    },
    orgName,
    testId,
    mailUrl,
    linkRe: env.SEED_INVITE_LINK_REGEX,
    domain,
    count,
    runId,
    out,
    manifest,
    rps: intIn('SEED_RPS', env.SEED_RPS ?? '5', 1, 50),
    concurrency: intIn('SEED_CONCURRENCY', env.SEED_CONCURRENCY ?? '4', 1, 16),
    roomScanBytes: intIn('SEED_ROOM_SCAN_BYTES', env.SEED_ROOM_SCAN_BYTES ?? '256', 1, 65536),
    verifyTimeoutMs:
      intIn('SEED_VERIFY_TIMEOUT_S', env.SEED_VERIFY_TIMEOUT_S ?? '60', 1, 600) * 1000,
  };
}
