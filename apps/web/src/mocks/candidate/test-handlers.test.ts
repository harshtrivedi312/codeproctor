import { setupServer } from 'msw/node';
import { describe, expect, it } from 'vitest';
import { apiBaseUrl } from '@/lib/env';
import { createHandlers } from '../handlers';

/**
 * The candidate test-screen mocks share paths with the older demo mocks (/t/demo/test, the QA
 * specs). A request with no Authorization header is the demo's and must reach the demo handler.
 */
describe('FU-FEB-08 candidate test mocks do not shadow the demo routes', () => {
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
