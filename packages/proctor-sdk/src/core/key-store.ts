import { IdbStore, STORES } from './idb';

/** The signing key of one session and the epoch it belongs to (ADR 0013 section 2). */
export interface StoredKey {
  key: CryptoKey;
  epoch: number;
}

/**
 * Where the non-extractable CryptoKey lives between page loads. A seam so tests (and a browser
 * that cannot clone CryptoKeys into IndexedDB) can swap the storage; the SDK default is IndexedDB.
 * No other secret is ever stored here: never the candidate token.
 */
export interface KeyStore {
  get(sessionId: string): Promise<StoredKey | null>;
  put(sessionId: string, value: StoredKey): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/** Meta-store key `<sessionId>:hmacKey`: the retention sweep reads the session id before the first colon. */
export const hmacKeyName = (sessionId: string): string => `${sessionId}:hmacKey`;

function isUsable(v: unknown): v is StoredKey {
  if (typeof v !== 'object' || v === null) return false;
  const { key, epoch } = v as { key?: unknown; epoch?: unknown };
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return false;
  if (typeof key !== 'object' || key === null) return false;
  const k = key as { type?: unknown; extractable?: unknown };
  // Only a non-extractable secret key is accepted back: anything else is not ours.
  return k.type === 'secret' && k.extractable === false;
}

export class IdbKeyStore implements KeyStore {
  constructor(private readonly store: IdbStore) {}

  async get(sessionId: string): Promise<StoredKey | null> {
    try {
      const v = await this.store.get<unknown>(STORES.meta, hmacKeyName(sessionId));
      return isUsable(v) ? { key: v.key, epoch: v.epoch } : null;
    } catch {
      return null; // unreadable: the app asks the server (or the candidate does an OTP resume)
    }
  }

  async put(sessionId: string, value: StoredKey): Promise<void> {
    await this.store.put(STORES.meta, hmacKeyName(sessionId), {
      key: value.key,
      epoch: value.epoch,
    });
  }

  async delete(sessionId: string): Promise<void> {
    await this.store.delete(STORES.meta, hmacKeyName(sessionId)).catch(() => undefined);
  }
}
