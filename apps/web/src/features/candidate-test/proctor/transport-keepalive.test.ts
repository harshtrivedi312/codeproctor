import type { SignedBatch } from '@codeproctor/proctor-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setSessionToken,
  clearCandidateCredentials,
} from '@/features/candidate-flow/session-store';
import { createProctorTransport } from './transport';

vi.mock('@/lib/mock-ready', () => ({
  mockingReady: Promise.resolve(),
  markMockingReady: () => undefined,
}));

const hooks = {
  onState: vi.fn(),
  onNotActive: vi.fn(),
  onReauthRequired: vi.fn(),
};
const batch = (body: string): SignedBatch => ({ body, signature: 'a'.repeat(64), seq: 0 });

beforeEach(() => setSessionToken('t'.repeat(40)));
afterEach(() => {
  vi.unstubAllGlobals();
  clearCandidateCredentials();
});

describe('keystroke and event transport: keepalive is measured in bytes (FR-608, ADR 0013 5.2)', () => {
  it('FR-608: a small ASCII batch is sent with keepalive', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const t = createProctorTransport(hooks);
    expect(await t.sendKeystrokeBatch(batch('{"seq":0}'))).toBe('OK');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ keepalive: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/candidate/session/keystrokes');
  });

  it('FR-608: a batch under 60 000 characters but over 60 000 bytes (editor text in CJK) is sent without keepalive', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = JSON.stringify({ seq: 0, text: '漢'.repeat(30_000) }); // ~30k chars, ~90k bytes
    expect(body.length).toBeLessThan(60_000);
    const t = createProctorTransport(hooks);
    expect(await t.sendKeystrokeBatch(batch(body))).toBe('OK');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ keepalive: false });
  });

  it('FR-608: if a keepalive request fails (the browser quota is shared), it is tried once without keepalive', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('quota'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const t = createProctorTransport(hooks);
    expect(await t.sendBatch(batch('{"seq":0}'))).toBe('OK');
    expect(fetchMock.mock.calls.map((c) => (c[1] as { keepalive: boolean }).keepalive)).toEqual([
      true,
      false,
    ]);
  });

  it('FR-608: a network failure without keepalive is a retry, not a loss', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const t = createProctorTransport(hooks);
    expect(await t.sendKeystrokeBatch(batch('{"seq":0}'))).toBe('RETRY');
  });

  it('FR-608: 413 is a refused batch (counted by the SDK), 429 and 5xx are retries', async () => {
    const t = createProctorTransport(hooks);
    for (const [status, expected] of [
      [413, 'REJECTED'],
      [429, 'RETRY'],
      [503, 'RETRY'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
      expect(await t.sendKeystrokeBatch(batch('{"seq":0}'))).toBe(expected);
    }
  });
});
