import { createHash } from 'node:crypto';

/**
 * Model lock manifest helpers (SHA-256 pinning for self-hosted model files, FR-606, FR-607).
 * The shape follows the proposal in ADR 0013 section 6 (Proposed) so it can be folded into
 * `packages/proctor-sdk/models.lock.json`: `{ schema: 1, files: [{ name, component, source,
 * version, sha256, bytes, licence, licenceUrl, flag, status }] }`. `licence` and `status` are
 * edited by hand and are never changed by an update.
 */
export const LOCK_SCHEMA = 1;

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Compare scanned files ({ name, sha256, bytes }) with a lock; returns a list of problems. */
export function verifyAgainstLock(scanned, lock) {
  const problems = [];
  const locked = new Map(lock.files.map((f) => [f.name, f]));
  const seen = new Set();
  for (const f of scanned) {
    seen.add(f.name);
    const e = locked.get(f.name);
    if (!e) problems.push(`${f.name}: not in the lock (run update after review)`);
    else if (e.sha256 !== f.sha256) problems.push(`${f.name}: SHA-256 mismatch`);
    else if (e.bytes !== f.bytes) problems.push(`${f.name}: size mismatch`);
  }
  for (const name of locked.keys()) {
    if (!seen.has(name)) problems.push(`${name}: in the lock but missing from the output`);
  }
  return problems;
}

/**
 * New lock from scanned files. Existing entries keep `licence`, `licenceUrl`, `flag` and `status`;
 * new entries start as `unverified`. `describe(name)` supplies source, version and component.
 */
export function updateLock(scanned, previous, describe) {
  const old = new Map((previous?.files ?? []).map((f) => [f.name, f]));
  const files = scanned
    .map((f) => {
      const d = describe(f.name);
      const o = old.get(f.name);
      return {
        name: f.name,
        component: d.component,
        source: d.source,
        version: d.version,
        sha256: f.sha256,
        bytes: f.bytes,
        licence: o?.licence ?? 'unverified',
        licenceUrl: o?.licenceUrl ?? null,
        flag: o?.flag ?? d.flag ?? null,
        status: o?.status ?? 'unverified',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { schema: LOCK_SCHEMA, files };
}
