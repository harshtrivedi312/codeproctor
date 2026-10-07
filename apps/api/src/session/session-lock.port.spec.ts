import { randomUUID } from 'node:crypto';
import {
  SessionLockUnavailableError,
  SessionNotFoundError,
  StubSessionLockPort,
  UnwiredSessionLockPort,
  type SessionTx,
} from './session-lock.port';

const txWith = (row: { id: string } | null): SessionTx =>
  ({ session: { findUnique: jest.fn(() => Promise.resolve(row)) } }) as unknown as SessionTx;

describe('Session lock ports (stand-in for database/session-locks, FU-BEB-111)', () => {
  const saved = { node: process.env.NODE_ENV, app: process.env.APP_ENV };
  afterEach(() => {
    process.env.NODE_ENV = saved.node;
    if (saved.app === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = saved.app;
  });

  it('ADR 0013 5.7: the module default always throws, in every environment', async () => {
    for (const node of ['test', 'development', 'production']) {
      process.env.NODE_ENV = node;
      process.env.APP_ENV = 'test';
      await expect(new UnwiredSessionLockPort().guardLive()).rejects.toBeInstanceOf(
        SessionLockUnavailableError,
      );
    }
  });

  it('ADR 0013 5.7: the test stub answers LIVE for an existing session and SessionNotFound for a missing one', async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    const id = randomUUID();
    await expect(new StubSessionLockPort().guardLive(txWith({ id }), id)).resolves.toBe('LIVE');
    await expect(new StubSessionLockPort().lockAnySession(txWith({ id }), id)).resolves.toBe(
      'LIVE',
    );
    await expect(
      new StubSessionLockPort().lockForAccommodation(txWith({ id, status: 'OPENED' } as never), id),
    ).resolves.toBe('OPENED');
    await expect(new StubSessionLockPort().guardLive(txWith(null), id)).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('ADR 0013 5.7: the stub fails closed unless BOTH NODE_ENV and APP_ENV are "test"', async () => {
    const cases: Array<[string | undefined, string | undefined]> = [
      ['development', 'test'],
      ['production', 'test'],
      [undefined, 'test'],
      ['test', 'production'],
      ['test', 'pilot'],
      ['test', 'development'],
      ['test', undefined],
      [undefined, undefined],
    ];
    for (const [node, app] of cases) {
      if (node === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = node;
      if (app === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = app;
      await expect(
        new StubSessionLockPort().guardLive(txWith({ id: 'x' }), 'x'),
      ).rejects.toBeInstanceOf(SessionLockUnavailableError);
    }
  });
});
