// DL-72 development-only stopgap: after grading, GRADED -> UNDER_REVIEW happens only when APP_ENV is
// exactly 'development' (NODE_ENV not production). Every other environment keeps today's behaviour:
// the session stays GRADED for BE-12 (FU-BEB-145). TC-099 / FR-506 / C-28.
import type { ConfigService } from '@nestjs/config';
import { devReviewFlowEnabled } from '../config/env';
import type { Env } from '../config/env';
import { SessionStateConflictError } from '../session/session-state.errors';
import { GradeSessionService } from './grade-session.service';

describe('devReviewFlowEnabled (DL-72)', () => {
  const appEnvs = [
    'development',
    'test',
    'staging',
    'pilot',
    'production',
    'Development',
    'dev',
    '',
    undefined,
  ];
  const nodeEnvs = ['development', 'test', 'production', undefined];
  for (const appEnv of appEnvs) {
    for (const nodeEnv of nodeEnvs) {
      const expected = appEnv === 'development' && nodeEnv !== 'production';
      it(`TC-099: APP_ENV=${String(appEnv)} NODE_ENV=${String(nodeEnv)} is ${String(expected)}`, () => {
        expect(devReviewFlowEnabled({ APP_ENV: appEnv, NODE_ENV: nodeEnv })).toBe(expected);
      });
    }
  }
});

function build(appEnv: string, nodeEnv: string, status: string) {
  const transition = jest.fn<Promise<void>, [{ from: string; to: string; sessionId: string }]>();
  transition.mockResolvedValue(undefined);
  const tx = {
    sessionQuestion: { findMany: jest.fn().mockResolvedValue([]) },
    session: { update: jest.fn().mockResolvedValue({}) },
  };
  const client = {
    session: { findUnique: jest.fn().mockResolvedValue({ status }) },
    sessionSection: { findMany: jest.fn().mockResolvedValue([]) },
    sessionQuestion: { findMany: jest.fn().mockResolvedValue([]) },
    testQuestion: { findMany: jest.fn().mockResolvedValue([]) },
    questionVersion: { findMany: jest.fn().mockResolvedValue([]) },
    question: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const orgContext = {
    runInOrg: jest.fn((_org: string, fn: () => unknown) => Promise.resolve(fn())),
  };
  const enqueueAnalyze = jest.fn().mockResolvedValue(undefined);
  const values: Record<string, string> = { APP_ENV: appEnv, NODE_ENV: nodeEnv };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
  const service = new GradeSessionService(
    { client } as never,
    orgContext as never,
    { transition } as never,
    {} as never,
    {} as never,
    { enqueueAnalyze } as never,
    {} as never,
    config,
  );
  return { service, transition, enqueueAnalyze };
}

type Calls = readonly (readonly [{ from: string; to: string; sessionId: string }])[];
const edges = (calls: Calls): string[][] => calls.map((c) => [c[0].from, c[0].to]);

describe('grade-session dev review flow (DL-72; BE-12 and FU-BEB-145 own the real behaviour)', () => {
  it('FR-506: development moves a freshly graded session to UNDER_REVIEW after the GRADED transition', async () => {
    const { service, transition, enqueueAnalyze } = build(
      'development',
      'development',
      'SUBMITTED',
    );
    await expect(service.grade('o1', 's1')).resolves.toBe('graded');
    expect(edges(transition.mock.calls)).toEqual([
      ['SUBMITTED', 'GRADED'],
      ['GRADED', 'UNDER_REVIEW'],
    ]);
    expect(transition.mock.calls[1]?.[0].sessionId).toBe('s1');
    expect(enqueueAnalyze).toHaveBeenCalledTimes(1);
  });

  it('FR-506: development, a redelivery that finds GRADED moves it to UNDER_REVIEW once', async () => {
    const { service, transition } = build('development', 'development', 'GRADED');
    await expect(service.grade('o1', 's1')).resolves.toBe('already-graded');
    expect(edges(transition.mock.calls)).toEqual([['GRADED', 'UNDER_REVIEW']]);
  });

  it('FR-506: development, a session already UNDER_REVIEW or COMPLETED is left alone', async () => {
    for (const status of ['UNDER_REVIEW', 'COMPLETED']) {
      const { service, transition } = build('development', 'development', status);
      await expect(service.grade('o1', 's1')).resolves.toBe('skipped');
      expect(transition).not.toHaveBeenCalled();
    }
  });

  it('FR-506: development, losing the GRADED -> UNDER_REVIEW race is not an error', async () => {
    const { service, transition } = build('development', 'development', 'GRADED');
    transition.mockRejectedValueOnce(new SessionStateConflictError('UNDER_REVIEW'));
    await expect(service.grade('o1', 's1')).resolves.toBe('already-graded');
  });

  it('FR-506: development, a throwing enqueue leaves the session GRADED (not moved) so the retry enqueues again', async () => {
    const { service, transition, enqueueAnalyze } = build(
      'development',
      'development',
      'SUBMITTED',
    );
    enqueueAnalyze.mockRejectedValueOnce(new Error('queue down'));
    await expect(service.grade('o1', 's1')).rejects.toThrow('queue down');
    expect(edges(transition.mock.calls)).toEqual([['SUBMITTED', 'GRADED']]);
    const retry = build('development', 'development', 'GRADED');
    retry.enqueueAnalyze.mockRejectedValueOnce(new Error('queue down'));
    await expect(retry.service.grade('o1', 's1')).rejects.toThrow('queue down');
    expect(retry.transition).not.toHaveBeenCalled();
  });

  it('FR-506: development, losing the GRADED -> UNDER_REVIEW race on the fresh path is still graded', async () => {
    const { service, transition } = build('development', 'development', 'SUBMITTED');
    transition.mockResolvedValueOnce(undefined);
    transition.mockRejectedValueOnce(new SessionStateConflictError('UNDER_REVIEW'));
    await expect(service.grade('o1', 's1')).resolves.toBe('graded');
    expect(transition).toHaveBeenCalledTimes(2);
  });

  const others: [string, string][] = [
    ['staging', 'production'],
    ['pilot', 'production'],
    ['production', 'production'],
    ['test', 'test'],
    ['', 'test'],
    ['Development', 'development'],
    ['development', 'production'],
  ];
  for (const [appEnv, nodeEnv] of others) {
    it(`FR-506, C-28: APP_ENV='${appEnv}' NODE_ENV=${nodeEnv} leaves the session GRADED (BE-12 moves it)`, async () => {
      const fresh = build(appEnv, nodeEnv, 'SUBMITTED');
      await expect(fresh.service.grade('o1', 's1')).resolves.toBe('graded');
      expect(edges(fresh.transition.mock.calls)).toEqual([['SUBMITTED', 'GRADED']]);
      const redelivered = build(appEnv, nodeEnv, 'GRADED');
      await expect(redelivered.service.grade('o1', 's1')).resolves.toBe('already-graded');
      expect(redelivered.transition).not.toHaveBeenCalled();
    });
  }
});
