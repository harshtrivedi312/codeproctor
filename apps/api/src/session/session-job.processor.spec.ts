// SessionJobProcessor (ADR 0013 section 5.7, CS-4.1, CS-4.7; FR-505, NFR-04). A fake transaction
// and a recording lock port prove the order and the outcomes; the real scope is real.
import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { SessionStatus } from '../generated/prisma/enums.js';
import { randomUUID } from 'node:crypto';
import { OrgContextService } from '../database/org-context';
import type { PrismaService } from '../database/prisma.service';
import { ANY_SESSION_JOBS, SessionJobProcessor, type AnySessionJob } from './session-job.processor';
import {
  SessionLockPort,
  SessionLockRetryError,
  SessionLockUnavailableError,
  SessionNotFoundError,
  type SessionLockState,
  type SessionTx,
} from './session-lock.port';

const ORG = randomUUID();
const SID = randomUUID();

class Locks extends SessionLockPort {
  state: SessionLockState | Error = 'LIVE';
  constructor(private readonly events: string[]) {
    super();
  }
  guardLive(_tx: SessionTx, sessionId: string): Promise<SessionLockState> {
    this.events.push(`guardLive ${sessionId}`);
    return this.state instanceof Error ? Promise.reject(this.state) : Promise.resolve(this.state);
  }
  lockAnySession(_tx: SessionTx, sessionId: string): Promise<SessionLockState> {
    this.events.push(`lockAnySession ${sessionId}`);
    return this.state instanceof Error ? Promise.reject(this.state) : Promise.resolve(this.state);
  }
  lockForAccommodation(): Promise<SessionStatus> {
    return Promise.reject(new Error('not used by session jobs'));
  }
}

class Probe extends SessionJobProcessor {
  protected readonly logger = new Logger('Probe');
  protected override readonly anySessionJobs: readonly AnySessionJob[] = ANY_SESSION_JOBS;
  constructor(prisma: PrismaService, orgContext: OrgContextService, locks: SessionLockPort) {
    super(prisma, orgContext, locks);
  }
  live<T>(fn: (tx: SessionTx) => Promise<T>) {
    return this.withLiveSession(SID, ORG, fn);
  }
  any<T>(job: AnySessionJob, fn: (tx: SessionTx) => Promise<T>) {
    return this.withAnySession(job, SID, ORG, fn);
  }
}

function setup() {
  const events: string[] = [];
  const orgContext = new OrgContextService();
  const tx = { marker: 'tx' } as unknown as SessionTx;
  const prisma = {
    client: {
      $transaction: jest.fn(async (fn: (t: SessionTx) => Promise<unknown>) => {
        events.push('begin');
        try {
          const out = await fn(tx);
          events.push('commit');
          return out;
        } catch (e) {
          events.push('rollback');
          throw e;
        }
      }),
    },
  } as unknown as PrismaService;
  const locks = new Locks(events);
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return {
    events,
    orgContext,
    tx,
    prisma,
    locks,
    warn,
    probe: new Probe(prisma, orgContext, locks),
  };
}

afterEach(() => jest.restoreAllMocks());

describe('SessionJobProcessor (ADR 0013 section 5.7, CS-4.7)', () => {
  it('FR-505, ADR 0013 5.7: guardLive is the first statement of the transaction, and fn runs after it in the same transaction', async () => {
    const { probe, events, tx } = setup();
    const result = await probe.live((t) => {
      events.push('fn');
      expect(t).toBe(tx);
      return Promise.resolve(42);
    });
    expect(result).toEqual({ outcome: 'LIVE', value: 42 });
    expect(events).toEqual(['begin', `guardLive ${SID}`, 'fn', 'commit']);
  });

  it('ADR 0013 5.7: fn runs inside the SERVICE scope of this one session, and the scope is left afterwards', async () => {
    const { probe, orgContext } = setup();
    await probe.live(() => {
      const scope = orgContext.current()?.scope;
      expect(scope).toMatchObject({
        kind: 'org',
        orgId: ORG,
        session: { actor: 'SERVICE', sessionId: SID },
      });
      return Promise.resolve();
    });
    expect(orgContext.current()?.scope).toBeUndefined();
  });

  it('ADR 0013 5.7: an ERASED session writes nothing: fn is not called and the outcome says ERASED', async () => {
    const { probe, locks, events } = setup();
    locks.state = 'ERASED';
    const fn = jest.fn();
    expect(await probe.live(fn)).toEqual({ outcome: 'ERASED' });
    expect(fn).not.toHaveBeenCalled();
    expect(events).toEqual(['begin', `guardLive ${SID}`, 'commit']);
  });

  it('ADR 0013 5.7: a session that is not found drops the job (no retry) and logs ids only', async () => {
    const { probe, locks, warn } = setup();
    locks.state = new SessionNotFoundError();
    const fn = jest.fn();
    expect(await probe.live(fn)).toEqual({ outcome: 'DROPPED' });
    expect(fn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toBe(`Session job dropped: session ${SID} not found in org ${ORG}`);
  });

  it('ADR 0013 5.7: a busy lock is rethrown so BullMQ retries, and the transaction rolls back', async () => {
    const { probe, locks, events } = setup();
    locks.state = new SessionLockRetryError();
    const fn = jest.fn();
    await expect(probe.live(fn)).rejects.toBeInstanceOf(SessionLockRetryError);
    expect(fn).not.toHaveBeenCalled();
    expect(events).toEqual(['begin', `guardLive ${SID}`, 'rollback']);
  });

  it('ADR 0013 5.7: an error in fn rolls back and propagates (the job retries)', async () => {
    const { probe, events } = setup();
    await expect(probe.live(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(events).toEqual(['begin', `guardLive ${SID}`, 'rollback']);
  });

  it('ADR 0013 CS-4.1: a session job cannot start from inside another scope (detachForSessionJob refuses)', async () => {
    const { probe, orgContext } = setup();
    await expect(
      orgContext.runInOrg(ORG, () => probe.live(() => Promise.resolve(1))),
    ).rejects.toThrow();
  });

  it('ADR 0013 5.7: withAnySession runs fn on an ERASED session after the same lock, only for the listed jobs', async () => {
    const { probe, locks, events } = setup();
    expect([...ANY_SESSION_JOBS].sort()).toEqual([
      'consent-pdf',
      'erasure-rerun',
      'evidence-expire',
      'ingest-close',
      'sweep-1',
      'sweep-2',
    ]);
    for (const job of ANY_SESSION_JOBS) {
      for (const state of ['LIVE', 'ERASED'] as const) {
        locks.state = state;
        events.length = 0;
        const fn = jest.fn(() => Promise.resolve('done'));
        expect(await probe.any(job, fn)).toEqual({ outcome: state, value: 'done' });
        expect(events[1]).toBe(`lockAnySession ${SID}`);
        expect(fn).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('ADR 0013 5.7: any other job name is refused by withAnySession, before a transaction opens', async () => {
    const { probe, events } = setup();
    for (const job of ['grade-session', 'verify-session', 'close-section', 'anything']) {
      await expect(probe.any(job as AnySessionJob, () => Promise.resolve(1))).rejects.toThrow(
        /may not use withAnySession/,
      );
    }
    expect(events).toEqual([]);
  });

  it('ADR 0013 5.7: withAnySession also drops a missing session and retries a busy lock', async () => {
    const { probe, locks } = setup();
    locks.state = new SessionNotFoundError();
    expect(await probe.any('ingest-close', () => Promise.resolve(1))).toEqual({
      outcome: 'DROPPED',
    });
    locks.state = new SessionLockRetryError();
    await expect(probe.any('ingest-close', () => Promise.resolve(1))).rejects.toBeInstanceOf(
      SessionLockRetryError,
    );
  });

  it('ADR 0013 5.7: a processor that declares no ERASED-tolerant jobs cannot use withAnySession even for a listed job', async () => {
    const { prisma, orgContext, locks, events } = setup();
    class Plain extends SessionJobProcessor {
      protected readonly logger = new Logger('Plain');
      constructor() {
        super(prisma, orgContext, locks);
      }
      attempt() {
        return this.withAnySession('ingest-close', SID, ORG, () => Promise.resolve(1));
      }
    }
    await expect(new Plain().attempt()).rejects.toThrow(/may not use withAnySession/);
    expect(events).toEqual([]);
  });

  it('ADR 0013 5.7: an unwired lock layer fails the job for good (UnrecoverableError, class name only) and rolls back', async () => {
    const { probe, locks, events } = setup();
    locks.state = new SessionLockUnavailableError();
    const error: unknown = await probe.live(() => Promise.resolve(1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('SessionLockUnavailableError');
    expect(events).toEqual(['begin', `guardLive ${SID}`, 'rollback']);
  });

  it('ADR 0013 5.7: Postgres lock_timeout (55P03), deadlock (40P01) and Prisma P2034 become a BullMQ retry, also when wrapped', async () => {
    const { probe, locks } = setup();
    const wrapped = (code: string): Error =>
      Object.assign(new Error('driver'), { cause: Object.assign(new Error('pg'), { code }) });
    const prismaMeta = Object.assign(new Error('P2010'), {
      code: 'P2010',
      meta: { code: '55P03' },
    });
    for (const e of [
      wrapped('55P03'),
      wrapped('40P01'),
      Object.assign(new Error('x'), { code: 'P2034' }),
      Object.assign(new Error('x'), { code: 'P2028' }),
      prismaMeta,
    ]) {
      locks.state = e;
      await expect(probe.live(() => Promise.resolve(1))).rejects.toBeInstanceOf(
        SessionLockRetryError,
      );
      await expect(probe.any('ingest-close', () => Promise.resolve(1))).rejects.toBeInstanceOf(
        SessionLockRetryError,
      );
    }
    // An unrelated error is not turned into a retry: it propagates as it is.
    locks.state = Object.assign(new Error('unique'), { code: 'P2002' });
    await expect(probe.live(() => Promise.resolve(1))).rejects.toThrow('unique');
  });
});
