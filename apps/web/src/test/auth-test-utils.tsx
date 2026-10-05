import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { setAccessToken } from '@/lib/auth-token';
import { nav, router } from './nav-mock';
import { AuthProvider } from '@/features/auth/auth-provider';
import { publishSession } from '@/lib/auth-session';
import { resetMockAuthState } from '@/mocks/auth-handlers';

export function resetAuthTestState(): void {
  router.push.mockReset();
  router.replace.mockReset();
  nav.pathname = '/admin';
  nav.search = new URLSearchParams();
  publishSession(null);
  resetMockAuthState();
}

export function renderWithAuth(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
}

export function setAccessTokenForTest(token: string | null): void {
  setAccessToken(token);
}
