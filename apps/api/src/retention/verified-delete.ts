// Verified deletion (ADR 0004 9.2): a marker, a column nulling or a consent row deletion may follow
// only if all three hold: every page was listed, DeleteObjects returned no `Errors`, and a fresh
// listing of the prefix comes back empty. Anything else is "not verified": the caller changes
// nothing and the tier runs again the next day. Nothing here logs or returns a key.
import { DELETE_BATCH_SIZE } from './retention.constants';
import type { ObjectStorePort, VersioningState } from './object-store.port';
import type { RetentionConfig } from './retention.config';

/** A runaway listing (a store that never stops paging) must end the run, not loop. */
const MAX_PAGES = 100_000;

export interface VerifiedDeleteResult {
  readonly verified: boolean;
  /** Keys DeleteObjects was asked to remove. A count only. */
  readonly deleted: number;
}

async function listAll(
  store: ObjectStorePort,
  prefix: string,
  keep: (key: string) => boolean,
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await store.listPage(prefix, token);
    for (const key of result.keys) if (!keep(key)) keys.push(key);
    if (result.nextToken === undefined) return keys;
    token = result.nextToken;
  }
  throw new Error('listing did not end');
}

/**
 * Deletes everything under each prefix except the keys `keep` returns true for (the media tier keeps
 * `reports/`), then re-lists to verify. Any store error is "not verified", never a thrown key.
 */
export async function deleteVerified(
  store: ObjectStorePort,
  prefixes: readonly string[],
  keep: (key: string) => boolean = () => false,
): Promise<VerifiedDeleteResult> {
  let deleted = 0;
  try {
    for (const prefix of prefixes) {
      const keys = await listAll(store, prefix, keep);
      for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
        const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
        const result = await store.deleteKeys(batch);
        deleted += batch.length;
        if (result.failed.length > 0) return { verified: false, deleted };
      }
    }
    for (const prefix of prefixes) {
      if ((await listAll(store, prefix, keep)).length > 0) return { verified: false, deleted };
    }
    return { verified: true, deleted };
  } catch {
    return { verified: false, deleted };
  }
}

export class VersioningUnsafeError extends Error {
  constructor(message = 'the object store may keep deleted objects as noncurrent versions') {
    super(message);
    this.name = 'VersioningUnsafeError';
  }
}

/** Pure decision for ADR 0004 9.2 "Versioning": safe only if versioning never was on, or old versions expire within a day. */
export function versioningIsSafe(state: VersioningState): boolean {
  if (state.kind === 'never-enabled') return true;
  if (state.kind === 'versioned')
    return state.noncurrentExpireDays !== null && state.noncurrentExpireDays <= 1;
  return false; // unsupported: fail closed unless the check is skipped by configuration
}

/** Fails closed (pilot and production) unless the config skips the check (staging, synthetic data only). */
export async function assertVersioningSafe(
  store: ObjectStorePort,
  config: Pick<RetentionConfig, 'RETENTION_VERSIONING_CHECK'>,
): Promise<void> {
  if (config.RETENTION_VERSIONING_CHECK === 'skip') return;
  let state: VersioningState;
  try {
    state = await store.versioning();
  } catch {
    throw new VersioningUnsafeError('the object store could not report its versioning state');
  }
  if (!versioningIsSafe(state)) throw new VersioningUnsafeError();
}
