import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import * as React from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireRole } from '@/features/auth/require-role';
import { useAuth } from '@/features/auth/auth-provider';
import type { Schemas } from '@/lib/api/client';
import { apiBaseUrl } from '@/lib/env';
import { defaultSettings } from '@/mocks/admin-handlers';
import { MOCK_USERS, seedMockRefresh } from '@/mocks/auth-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { CandidatesPage } from './candidates-page';
import { DataSettingsPage } from './data-settings-page';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetAuthTestState());

const captured: { auth: ReturnType<typeof useAuth> | null } = { auth: null };
function Capture(): null {
  const value = useAuth();
  React.useEffect(() => {
    captured.auth = value;
  });
  return null;
}

/** Signs the user in as the app would after login, using the mock refresh cookie (admin needs 2FA). */
async function signInViaApi(user: { email: string }): Promise<void> {
  seedMockRefresh(user.email);
  const response = await fetch(`${apiBaseUrl}/v1/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });
  captured.auth!.signIn((await response.json()) as Schemas['AuthSession']);
}

describe('cached API data does not cross users (FR-103, FR-104)', () => {
  it('FR-103 FR-104: after sign-out, the next user never sees the previous user candidates', async () => {
    renderAsStaff(
      <>
        <Capture />
        <RequireRole>
          <CandidatesPage />
        </RequireRole>
      </>,
      MOCK_USERS.admin,
    );
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();

    await captured.auth!.signOut();
    await waitFor(() => expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument());

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get('*/v1/admin/candidates', async () => {
        await gate;
        return HttpResponse.json({ items: [] });
      }),
    );
    await signInViaApi(MOCK_USERS.recruiter);
    // Org B's answer has not arrived yet: nothing of org A may be on screen.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument());
  });

  it('FR-103 FR-104: settings forms do not start from the previous org values', async () => {
    renderAsStaff(
      <>
        <Capture />
        <RequireRole>
          <DataSettingsPage />
        </RequireRole>
      </>,
      MOCK_USERS.admin,
    );
    const field = await screen.findByLabelText('Keep recordings and ID images for (days)');
    expect(field).toHaveValue(90);

    await captured.auth!.signOut();
    await waitFor(() =>
      expect(screen.queryByLabelText('Keep recordings and ID images for (days)')).toBeNull(),
    );

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get('*/v1/admin/settings', async () => {
        await gate;
        return HttpResponse.json({ ...defaultSettings(), retentionDays: 30 });
      }),
    );
    await signInViaApi(MOCK_USERS.admin);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByLabelText('Keep recordings and ID images for (days)')).toBeNull();
    release();
    expect(await screen.findByLabelText('Keep recordings and ID images for (days)')).toHaveValue(
      30,
    );
  });
});
