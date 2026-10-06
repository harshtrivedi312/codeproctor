import { describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_SERVER_CLOCK_AHEAD_MS, createHandlers } from './handlers';

describe('FU-FEB-01 mocked server clock', () => {
  it('FU-FEB-01 /v1/time and savedAt share the same +90 s offset', async () => {
    const server = setupServer(...createHandlers({ saveLatencyMs: 0 }));
    server.listen({ onUnhandledFrame: 'error' });
    try {
      const before = Date.now();
      const time = (await (await fetch(`${apiBaseUrl}/v1/time`)).json()) as { serverNow: string };
      const saved = (await (
        await fetch(`${apiBaseUrl}/v1/candidate/questions/q1/draft`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'x', language: 'python' }),
        })
      ).json()) as { savedAt: string };
      const after = Date.now();
      for (const iso of [time.serverNow, saved.savedAt]) {
        const offset = Date.parse(iso) - before;
        expect(offset).toBeGreaterThanOrEqual(MOCK_SERVER_CLOCK_AHEAD_MS);
        expect(offset).toBeLessThanOrEqual(MOCK_SERVER_CLOCK_AHEAD_MS + (after - before) + 50);
      }
      expect(MOCK_SERVER_CLOCK_AHEAD_MS).toBe(90_000);
    } finally {
      server.close();
    }
  });
});

describe('FU-FEB-08 candidate mocks are registered in mock mode', () => {
  it('FU-FEB-08 the candidate flow routes answer through createHandlers, next to the older test-screen mocks', async () => {
    const server = setupServer(...createHandlers({ saveLatencyMs: 0 }));
    server.listen({ onUnhandledFrame: 'error' });
    try {
      const link = await fetch(`${apiBaseUrl}/v1/candidate/session/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitationToken: 'a'.repeat(32) }),
      });
      expect(link.status).toBe(200);
      expect(((await link.json()) as { state: string }).state).toBe('OTP_REQUIRED');
      // A candidate route with an invalid token is the candidate mock's 404, not an unhandled request.
      const bad = await fetch(`${apiBaseUrl}/v1/candidate/session/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitationToken: 'short' }),
      });
      expect(bad.status).toBe(404);
      // The older test-screen mocks still answer.
      expect((await fetch(`${apiBaseUrl}/v1/candidate/session`)).status).toBe(200);
    } finally {
      server.close();
    }
  });
});
