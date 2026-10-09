// How a worker answer becomes an identity status (FR-403, TC-033, ADR 0004 section 1, ADR 0014 6.2):
// never a rejection, and an answer that contradicts itself is a match error, not a pass.
import { resolve } from './face-match.service';
import type { FaceMatchResponse } from './worker-client';

const base = { workerVersion: '0', lockDigest: 'abc', modelId: 'm', threshold: 0.75, detail: null };
const answer = (over: Partial<FaceMatchResponse>): FaceMatchResponse => ({
  ...base,
  decision: 'MATCH',
  reason: null,
  score: 0.9,
  ...over,
});

describe('resolve (FR-403, TC-033)', () => {
  it('TC-033: a clean MATCH is PASSED on either attempt', () => {
    expect(resolve(1, answer({})).status).toBe('PASSED');
    expect(resolve(2, answer({})).status).toBe('PASSED');
  });

  it.each(['BELOW_THRESHOLD', 'NO_FACE', 'MULTIPLE_FACES', 'LIVENESS_NOT_CONFIRMED'] as const)(
    'TC-033/TC-034: %s is LOW_CONFIDENCE on attempt 1 (a retry) and MANUAL_REVIEW on attempt 2',
    (reason) => {
      const a = answer({ decision: 'MANUAL_REVIEW', reason, score: 0.3 });
      expect(resolve(1, a)).toMatchObject({ status: 'LOW_CONFIDENCE', reason });
      expect(resolve(2, a)).toMatchObject({ status: 'MANUAL_REVIEW', reason });
    },
  );

  it('D-05: a match error, or no answer at all, is MANUAL_REVIEW at once, with no retry asked', () => {
    const a = answer({ decision: 'MANUAL_REVIEW', reason: 'MATCH_ERROR', score: null });
    expect(resolve(1, a)).toMatchObject({ status: 'MANUAL_REVIEW', reason: 'MATCH_ERROR' });
    expect(resolve(1, null)).toMatchObject({ status: 'MANUAL_REVIEW', reason: 'MATCH_ERROR' });
  });

  it('a self-contradicting answer is a match error, never a pass', () => {
    for (const bad of [
      answer({ decision: 'MATCH', reason: 'BELOW_THRESHOLD' }),
      answer({ decision: 'MATCH', score: null }),
      answer({ decision: 'MANUAL_REVIEW', reason: null }),
    ]) {
      expect(resolve(1, bad)).toMatchObject({ status: 'MANUAL_REVIEW', reason: 'MATCH_ERROR' });
    }
  });

  it('there is no way to produce a rejection: every result is one of three statuses', () => {
    const statuses = new Set<string>();
    for (const reason of [null, 'BELOW_THRESHOLD', 'MATCH_ERROR', 'NO_FACE'] as const) {
      for (const decision of ['MATCH', 'MANUAL_REVIEW'] as const) {
        for (const attempt of [1, 2])
          statuses.add(resolve(attempt, answer({ decision, reason })).status);
      }
    }
    expect([...statuses].sort()).toEqual(['LOW_CONFIDENCE', 'MANUAL_REVIEW', 'PASSED']);
  });
});
