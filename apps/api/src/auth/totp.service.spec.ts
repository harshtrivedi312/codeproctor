import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { authenticator } from 'otplib';
import type { Env } from '../config/env';
import { encryptSecret } from './crypto.util';
import { TotpService } from './totp.service';

const SECRET = 'JBSWY3DPEHPK3PXP';
const KEY = Buffer.alloc(32, 7);
const STEP_MS = 30_000;

type SetMock = jest.Mock<Promise<string | null>, [string, ...unknown[]]>;

function build(set: SetMock): TotpService {
  const config = {
    get: (name: string) => (name === 'ENCRYPTION_KEY' ? KEY.toString('base64') : 'CodeProctor'),
  } as unknown as ConfigService<Env, true>;
  return new TotpService(config, { status: 'ready', set } as unknown as Redis);
}

describe('TotpService step handling (FR-102, FU-BE-20)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('TC-003: the recorded step is the one the code matched when a step boundary passes mid-verify', async () => {
    const set: SetMock = jest
      .fn<Promise<string | null>, [string, ...unknown[]]>()
      .mockResolvedValue('OK');
    const totp = build(set);
    const encrypted = encryptSecret(SECRET, KEY);
    const stepStart = 1_000_000 * STEP_MS;
    const lastMsOfStep = stepStart + STEP_MS - 1;
    const code = authenticator.clone({ epoch: lastMsOfStep }).generate(SECRET);
    // The first clock read is the last millisecond of the step; any later read is past the boundary.
    let reads = 0;
    jest
      .spyOn(Date, 'now')
      .mockImplementation(() => (reads++ === 0 ? lastMsOfStep : lastMsOfStep + 5_000));

    expect(await totp.verify('user-1', encrypted, code)).toBe(true);
    expect(set.mock.calls[0]?.[0]).toBe('auth:totp:used:user-1:1000000');
  });

  it('TC-003: a code from the previous step is recorded under that step, not the current one', async () => {
    const set: SetMock = jest
      .fn<Promise<string | null>, [string, ...unknown[]]>()
      .mockResolvedValue('OK');
    const totp = build(set);
    const now = 2_000_000 * STEP_MS + 10_000;
    const code = authenticator.clone({ epoch: now - STEP_MS }).generate(SECRET);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    expect(await totp.verify('user-1', encryptSecret(SECRET, KEY), code)).toBe(true);
    expect(set.mock.calls[0]?.[0]).toBe('auth:totp:used:user-1:1999999');
  });

  it('TC-003: a replayed step is refused', async () => {
    const set: SetMock = jest
      .fn<Promise<string | null>, [string, ...unknown[]]>()
      .mockResolvedValue(null);
    const now = 2_000_000 * STEP_MS;
    const code = authenticator.clone({ epoch: now }).generate(SECRET);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    expect(await build(set).verify('u', encryptSecret(SECRET, KEY), code)).toBe(false);
  });

  it('TC-003: a Redis failure is a 503, never a plain wrong code', async () => {
    const set: SetMock = jest
      .fn<Promise<string | null>, [string, ...unknown[]]>()
      .mockRejectedValue(new Error('redis down'));
    const now = 2_000_000 * STEP_MS;
    const code = authenticator.clone({ epoch: now }).generate(SECRET);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await expect(build(set).verify('u', encryptSecret(SECRET, KEY), code)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
