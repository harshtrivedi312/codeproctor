import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Env } from '../config/env';
import { SessionKeyConfigError, SessionKeyService } from './session-key.service';

// Records the buffers randomBytes hands out (a pass-through), so the zeroing can be observed.
jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, randomBytes: jest.fn(actual.randomBytes) };
});

const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');

function service(activeKid: string): SessionKeyService {
  const config = {
    get: (key: string) => (key === 'SESSION_KEY_ENC_ACTIVE_KID' ? activeKid : undefined),
  } as unknown as ConfigService<Env, true>;
  return new SessionKeyService(config);
}

describe('Per-session HMAC key (ADR 0013 section 2, FR-801)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SESSION_KEY_ENC_KEY_k1 = K1;
    process.env.SESSION_KEY_ENC_KEY_k2 = K2;
  });
  afterAll(() => {
    process.env = saved;
  });

  it('FR-801: wraps as v1:<kid>:<nonce>:<ciphertext+tag> and unwraps to the same 32 bytes', () => {
    const keys = service('k1');
    const sid = randomUUID();
    const stored = keys.generateWrapped(sid);
    expect(stored).toMatch(/^v1:k1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    const master = keys.unwrap(stored, sid);
    expect(master).toHaveLength(32);
    // Two keys for two sessions differ, and one session never gets the same wrapping twice.
    expect(keys.generateWrapped(sid)).not.toBe(stored);
  });

  it('FR-801: the stored value never contains the plain key', () => {
    const keys = service('k1');
    const sid = randomUUID();
    const master = randomBytes(32);
    const stored = keys.wrap(master, sid, 'k1');
    expect(stored).not.toContain(master.toString('base64'));
    expect(stored).not.toContain(master.toString('hex'));
  });

  it('FR-801: a ciphertext copied to another session row does not decrypt (AAD = session id)', () => {
    const keys = service('k1');
    const stored = keys.generateWrapped(randomUUID());
    expect(() => keys.unwrap(stored, randomUUID())).toThrow();
  });

  it('FR-801: a flipped bit, a short tag and a foreign format are refused', () => {
    const keys = service('k1');
    const sid = randomUUID();
    const stored = keys.generateWrapped(sid);
    const parts = stored.split(':');
    const body = Buffer.from(parts[3] as string, 'base64');
    body[0] = (body[0] as number) ^ 1;
    expect(() =>
      keys.unwrap([...parts.slice(0, 3), body.toString('base64')].join(':'), sid),
    ).toThrow();
    expect(() =>
      keys.unwrap([...parts.slice(0, 3), body.subarray(0, 40).toString('base64')].join(':'), sid),
    ).toThrow();
    expect(() => keys.unwrap('v2:k1:AAAA:BBBB', sid)).toThrow();
    expect(() => keys.unwrap('garbage', sid)).toThrow();
  });

  it('NFR-04: the wrapping key rotates by kid; old rows still open while their kid is configured', () => {
    const sid = randomUUID();
    const old = service('k1').generateWrapped(sid);
    const rotated = service('k2');
    const fresh = rotated.generateWrapped(sid);
    expect(fresh.startsWith('v1:k2:')).toBe(true);
    expect(rotated.unwrap(old, sid)).toHaveLength(32);
    delete process.env.SESSION_KEY_ENC_KEY_k1;
    expect(() => rotated.unwrap(old, sid)).toThrow(SessionKeyConfigError);
  });

  it('NFR-04: a missing or malformed wrapping key fails at use with a config error', () => {
    delete process.env.SESSION_KEY_ENC_KEY_k1;
    expect(() => service('k1').generateWrapped(randomUUID())).toThrow(SessionKeyConfigError);
    process.env.SESSION_KEY_ENC_KEY_k1 = Buffer.alloc(16).toString('base64');
    expect(() => service('k1').generateWrapped(randomUUID())).toThrow(SessionKeyConfigError);
    expect(() => service('bad kid!').generateWrapped(randomUUID())).toThrow(SessionKeyConfigError);
  });

  it('FR-801: K_e = HMAC-SHA256(M, "codeproctor:batch-key:v1:<sid>:<epoch>"), per epoch', () => {
    const keys = service('k1');
    const sid = randomUUID();
    const master = randomBytes(32);
    const k0 = keys.deriveBatchKey(master, sid, 0);
    const expected = createHmac('sha256', master)
      .update(`codeproctor:batch-key:v1:${sid}:0`)
      .digest();
    expect(k0.equals(expected)).toBe(true);
    expect(keys.deriveBatchKey(master, sid, 1).equals(k0)).toBe(false);
    expect(keys.deriveBatchKey(master, sid.toUpperCase(), 0).equals(k0)).toBe(true);
    expect(keys.deriveBatchKey(master, randomUUID(), 0).equals(k0)).toBe(false);
    expect(() => keys.deriveBatchKey(master, sid, -1)).toThrow();
    expect(() => keys.deriveBatchKey(master, sid, 1.5)).toThrow();
    expect(() => keys.deriveBatchKey(master, 'not-a-uuid', 0)).toThrow();
  });

  it('FR-801: batchKeyFor unwraps and derives the same key as deriveBatchKey', () => {
    const keys = service('k1');
    const sid = randomUUID();
    const master = randomBytes(32);
    const stored = keys.wrap(master, sid, 'k1');
    expect(keys.batchKeyFor(stored, sid, 3).equals(keys.deriveBatchKey(master, sid, 3))).toBe(true);
  });

  it('NFR-04: the plain master key is zeroed after it is wrapped', () => {
    const keys = service('k1');
    const mocked = randomBytes as unknown as jest.Mock<Buffer, [number]>;
    mocked.mockClear();
    keys.generateWrapped(randomUUID());
    const masters = mocked.mock.results
      .map((r, i) => ({ size: mocked.mock.calls[i]?.[0], value: r.value as Buffer }))
      .filter((r) => r.size === 32);
    expect(masters).toHaveLength(1);
    expect(masters[0]?.value.every((byte) => byte === 0)).toBe(true);
  });
});
