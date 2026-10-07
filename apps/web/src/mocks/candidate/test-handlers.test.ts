import { setupServer } from 'msw/node';
import { describe, expect, it } from 'vitest';
import { apiBaseUrl } from '@/lib/env';
import { candidateApi } from '@/features/candidate-flow/api';
import { MOCK_OTP, MOCK_TOKENS } from './handlers';
import { createHandlers } from '../handlers';

/**
 * The candidate test-screen mocks share paths with the older demo mocks (/t/demo/test, the QA
 * specs). A request with no Authorization header is the demo's and must reach the demo handler.
 */
describe('FU-FEB-08 FR-505 candidate test mocks do not shadow the demo routes', () => {
  it('FU-FEB-08 a request without a credential gets the demo answers, one with an unknown token the candidate 401', async () => {
    const server = setupServer(...createHandlers({ saveLatencyMs: 0, runLatencyMs: 0 }));
    server.listen({ onUnhandledFrame: 'error' });
    try {
      const demo = await fetch(`${apiBaseUrl}/v1/candidate/session`);
      expect(demo.status).toBe(200);
      expect(Object.keys((await demo.json()) as object)).toContain('testTitle');
      const draft = await fetch(`${apiBaseUrl}/v1/candidate/questions/q1/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'code', language: 'python', code: 'x' }),
      });
      expect(draft.status).toBe(200);
      const finish = await fetch(`${apiBaseUrl}/v1/candidate/sections/s1/finish`, {
        method: 'POST',
      });
      expect(finish.status).toBe(200);
      const candidate = await fetch(`${apiBaseUrl}/v1/candidate/session`, {
        headers: { Authorization: 'Bearer not-a-known-token' },
      });
      expect(candidate.status).toBe(401);
    } finally {
      server.close();
    }
  });
});

describe('BE-11 ADR 0013 5.11 the section finish mock follows the documented contract', () => {
  it('rejects bad bodies and unknown positions, refuses a section not yet open, and is idempotent', async () => {
    const server = setupServer(...createHandlers({ saveLatencyMs: 0, runLatencyMs: 0 }));
    server.listen({ onUnhandledFrame: 'error' });
    try {
      const r = await candidateApi.startSession(MOCK_TOKENS.consented, MOCK_OTP);
      if (!r.ok) throw new Error('sign-in failed');
      await fetch(`${apiBaseUrl}/v1/candidate/session/test/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${r.data.sessionToken}` },
      });
      const finish = (body: unknown) =>
        fetch(`${apiBaseUrl}/v1/candidate/session/section/finish`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${r.data.sessionToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      expect((await finish({ position: 0 })).status).toBe(400);
      expect((await finish({ position: '1' })).status).toBe(400);
      expect((await finish({})).status).toBe(400);
      expect((await finish({ position: 3 })).status).toBe(404);
      expect((await finish({ position: 2 })).status).toBe(409);
      const first = await finish({ position: 1 });
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ accepted: true });
      expect((await finish({ position: 1 })).status).toBe(202);
    } finally {
      server.close();
    }
  });
});
