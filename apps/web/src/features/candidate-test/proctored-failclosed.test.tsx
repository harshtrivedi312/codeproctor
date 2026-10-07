import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  recordRequests,
  renderWithQuery,
  setupCandidateServer,
} from '@/features/candidate-flow/test-helpers';
import { createAdrSource } from './adr-source';
import { ProctoredTest } from './proctored-test';
import { setupDevices, startedSession } from './proctor/test-support';

// Mock mode is OFF in this file, as in a real build: a token that is not a JWT with a `sid` claim
// has no session id, and the test must not start.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_MOCKING = '';
});
vi.mock('next/dynamic', async () => {
  const { editorStub } = await import('@/features/candidate-flow/test-helpers');
  return { default: () => editorStub() };
});

setupCandidateServer();

describe('proctored test fails closed without a session id (S-f)', () => {
  it('ADR 0013 5.10: no sid claim outside mock mode ends the test at once, and never asks for the key or a device', async () => {
    const devices = setupDevices();
    await startedSession();
    const seen = recordRequests();
    const onSessionEnded = vi.fn();
    renderWithQuery(
      <main id="main">
        <ProctoredTest
          source={createAdrSource({ onSessionEnded })}
          onSessionEnded={onSessionEnded}
          onSubmitted={vi.fn()}
        />
      </main>,
    );
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
    expect(seen.some((q) => q.url.endsWith('/proctor-key'))).toBe(false);
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(devices.getDisplayMedia).not.toHaveBeenCalled();
  });
});
