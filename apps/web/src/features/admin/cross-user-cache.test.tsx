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
import { useQueryClient } from '@tanstack/react-query';
import { CandidatesPage } from './candidates-page';
import { DataSettingsPage } from './data-settings-page';
import { adminKeys, useUpdateSettings } from './queries';

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
    // Org B has no candidates: its own empty state renders, and still none of org A's rows.
    expect(await screen.findByTestId('table-empty')).toBeInTheDocument();
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
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

  it('FR-103 FR-104: a settings save still in flight when the user changes cannot write into the new cache', async () => {
    const holder: {
      save: ((retentionDays: number) => Promise<unknown>) | null;
      read: (() => unknown) | null;
    } = { save: null, read: null };
    function Saver(): null {
      const mutation = useUpdateSettings();
      const qc = useQueryClient();
      React.useEffect(() => {
        holder.save = (retentionDays) => mutation.mutateAsync({ retentionDays });
        holder.read = () => qc.getQueryData(adminKeys.settings);
      });
      return null;
    }
    renderAsStaff(
      <>
        <Capture />
        <Saver />
        <RequireRole>
          <DataSettingsPage />
        </RequireRole>
      </>,
      MOCK_USERS.admin,
    );
    await screen.findByLabelText('Keep recordings and ID images for (days)');

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.patch('*/v1/admin/settings', async () => {
        await gate;
        return HttpResponse.json({ ...defaultSettings(), retentionDays: 45 }); // org A's value
      }),
    );
    const saving = holder.save!(45);
    await captured.auth!.signOut();
    await waitFor(() =>
      expect(screen.queryByLabelText('Keep recordings and ID images for (days)')).toBeNull(),
    );
    server.use(
      http.get('*/v1/admin/settings', () =>
        HttpResponse.json({ ...defaultSettings(), retentionDays: 30 }),
      ),
    );
    await signInViaApi(MOCK_USERS.admin);
    expect(await screen.findByLabelText('Keep recordings and ID images for (days)')).toHaveValue(
      30,
    );
    release();
    await saving;
    expect((holder.read!() as { retentionDays: number }).retentionDays).toBe(30);
    expect(screen.getByLabelText('Keep recordings and ID images for (days)')).toHaveValue(30);
  });
});
