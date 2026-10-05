import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ACCESS_TTL_SECONDS } from './access-ttl';
import { MARKER_TTL_SECONDS, TokenValidityService } from './token-validity.service';

function serviceWith(stored: string | null): TokenValidityService {
  const redis = {
    status: 'ready',
    get: jest.fn().mockResolvedValue(stored),
  } as unknown as Redis;
  return new TokenValidityService(redis);
}

describe('TokenValidityService.isFresh (FR-104)', () => {
  it('FR-104: with no marker every token is fresh', async () => {
    await expect(serviceWith(null).isFresh('u', 1)).resolves.toBe(true);
  });

  it('FR-104: a token issued before the marker is refused', async () => {
    await expect(serviceWith('1000').isFresh('u', 999)).resolves.toBe(false);
  });

  it('FR-104: a token issued in the same second as the marker is refused', async () => {
    await expect(serviceWith('1000').isFresh('u', 1000)).resolves.toBe(false);
  });

  it('FR-104: a token issued after the marker is accepted', async () => {
    await expect(serviceWith('1000').isFresh('u', 1001)).resolves.toBe(true);
  });

  it('FR-104: a non-numeric marker fails closed', async () => {
    await expect(serviceWith('garbage').isFresh('u', 5000)).resolves.toBe(false);
  });

  it('FR-104: Redis errors are a 503, never a pass', async () => {
    const redis = {
      status: 'ready',
      get: jest.fn().mockRejectedValue(new Error('down')),
    } as unknown as Redis;
    await expect(new TokenValidityService(redis).isFresh('u', 1)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('FR-104: the marker outlives the access lifetime, derived from the single constant', () => {
    expect(MARKER_TTL_SECONDS).toBeGreaterThan(ACCESS_TTL_SECONDS);
  });

  it('FR-104: the marker is written with that TTL', async () => {
    const evalFn = jest.fn().mockResolvedValue(1);
    const svc = new TokenValidityService({ status: 'ready', eval: evalFn } as unknown as Redis);
    await svc.invalidateIssuedTokens('U-1');
    // The script only ever raises the marker (max of existing and now).
    expect(evalFn).toHaveBeenCalledWith(
      expect.stringContaining('now > cur'),
      1,
      'auth:tokens-valid-after:u-1',
      expect.any(String),
      String(MARKER_TTL_SECONDS),
    );
  });
});
