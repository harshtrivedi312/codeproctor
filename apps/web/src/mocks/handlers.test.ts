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
