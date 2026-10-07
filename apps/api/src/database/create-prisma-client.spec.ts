// FU-BE-194: the pool options reach pg, and an idle connection outlives pg-pool's 10 s default so
// the boot warm-up is not thrown away before the first user (C-43).
import { PrismaPg } from '@prisma/adapter-pg';
import {
  createPrismaClient,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
} from './create-prisma-client';

jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: jest.fn() }));
jest.mock('../generated/prisma/client', () => ({ PrismaClient: jest.fn() }));

const URL = 'postgresql://u:p@127.0.0.1:5432/db';

const lastConfig = (): Record<string, unknown> => {
  const calls = (PrismaPg as unknown as jest.Mock).mock.calls as unknown[][];
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
};

describe('createPrismaClient pool options (FU-BE-194)', () => {
  it('FU-BE-194: defaults are explicit, never pg-pool defaults (idle 10 s, connect 0)', () => {
    createPrismaClient(URL);
    expect(lastConfig()).toMatchObject({
      max: DEFAULT_POOL_MAX,
      connectionTimeoutMillis: DEFAULT_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    });
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBeGreaterThan(10_000);
  });

  it('FU-BE-194: given values are used, and 0 or negative values fall back to the defaults', () => {
    createPrismaClient(URL, { max: 3, connectionTimeoutMillis: 700, idleTimeoutMillis: 120_000 });
    expect(lastConfig()).toMatchObject({
      max: 3,
      connectionTimeoutMillis: 700,
      idleTimeoutMillis: 120_000,
    });
    createPrismaClient(URL, { max: 0, connectionTimeoutMillis: 0, idleTimeoutMillis: -1 });
    expect(lastConfig()).toMatchObject({
      max: DEFAULT_POOL_MAX,
      connectionTimeoutMillis: DEFAULT_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    });
  });

  it('FU-BE-194: TCP keep-alive is on so a dead peer is noticed while a connection is idle', () => {
    createPrismaClient(URL);
    expect(lastConfig()).toMatchObject({ keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
  });

  it('FU-BE-194: the pool error handler reaches the adapter for pool and connection errors', () => {
    const onPoolError = jest.fn();
    createPrismaClient(URL, { onPoolError });
    const calls = (PrismaPg as unknown as jest.Mock).mock.calls as unknown[][];
    const options = calls[calls.length - 1]?.[1] as Record<string, (e: Error) => void>;
    options.onPoolError?.(new Error('x'));
    options.onConnectionError?.(new Error('y'));
    expect(onPoolError).toHaveBeenCalledTimes(2);
  });
});
