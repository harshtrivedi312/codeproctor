import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ notFound }));
vi.mock('./proctor-demo-client', () => ({ ProctorDemoClient: () => <div>demo client</div> }));

afterEach(() => {
  vi.unstubAllEnvs();
  notFound.mockClear();
});

describe('/dev/proctor page (dev only)', () => {
  it('404s in production builds', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { default: Page } = await import('./page');
    expect(() => Page()).toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });
  it('renders the demo outside production and says the API is mocked', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { default: Page } = await import('./page');
    render(<Page />);
    expect(screen.getByText('demo client')).toBeInTheDocument();
    expect(screen.getByText(/assumptions pending/i)).toBeInTheDocument();
  });
});
