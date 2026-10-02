import { vi } from 'vitest';

export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const nav = { pathname: '/admin', search: new URLSearchParams() };

/** Used as: vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock()) */
export function navigationMock() {
  return {
    useRouter: () => router,
    usePathname: () => nav.pathname,
    useSearchParams: () => nav.search,
  };
}
