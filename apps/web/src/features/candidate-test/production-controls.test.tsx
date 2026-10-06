/** With mock mode off, the demo-only controls must not render (Frontend step-1 follow-up 9, FR-601). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '@/mocks/server';
import { TestScreen } from './test-screen';

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_API_MOCKING;
});

vi.mock('next/dynamic', () => ({ default: () => () => <textarea aria-label="Code editor" /> }));

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('FR-601 production build has no demo controls', () => {
  it('FR-601 the start gate has no way around fullscreen and there is no demo banner or shortcut', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TestScreen />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Enter fullscreen to begin')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue without fullscreen/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /simulate fullscreen exit/i })).toBeNull();
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });
});
