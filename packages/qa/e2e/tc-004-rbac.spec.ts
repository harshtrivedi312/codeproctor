import { expect, test, type Page } from '@playwright/test';

/**
 * TC-004 (FR-103), browser side: every staff role against every staff page, opened directly by URL
 * (never through the menu). Expected access comes from docs/fsd.md section 4 (who owns which
 * route) and the permission matrix in packages/shared; it is written out here on purpose so a
 * change in the app's own table cannot change what the test expects. The API is the enforcer
 * (apps/api/test/integration/tc-004.int.test.ts); this checks the web does not show data to a role
 * that must not see it. Runs against the mocked API of the production build.
 */
type Role = 'SUPER_ADMIN' | 'RECRUITER' | 'AUTHOR' | 'REVIEWER';

const USERS: Record<Role, { email: string; password: string }> = {
  SUPER_ADMIN: { email: 'admin@example.test', password: 'Admin-Pass-12345' },
  RECRUITER: { email: 'recruiter@example.test', password: 'Recruiter-Pass-1' },
  AUTHOR: { email: 'author@example.test', password: 'Author-Pass-12345' },
  REVIEWER: { email: 'reviewer@example.test', password: 'Reviewer-Pass-12' },
};
const TOTP = '123456';

const PAGES: { path: string; allowed: Role[] }[] = [
  { path: '/admin', allowed: ['SUPER_ADMIN', 'RECRUITER', 'AUTHOR', 'REVIEWER'] },
  { path: '/admin/questions', allowed: ['SUPER_ADMIN', 'AUTHOR', 'RECRUITER'] },
  { path: '/admin/tests', allowed: ['SUPER_ADMIN', 'RECRUITER'] },
  { path: '/admin/candidates', allowed: ['SUPER_ADMIN', 'RECRUITER'] },
  { path: '/admin/review', allowed: ['SUPER_ADMIN', 'REVIEWER'] },
  { path: '/admin/live', allowed: ['SUPER_ADMIN', 'REVIEWER'] },
  { path: '/admin/reports', allowed: ['SUPER_ADMIN', 'RECRUITER', 'REVIEWER'] },
  { path: '/admin/settings', allowed: ['SUPER_ADMIN'] },
  { path: '/admin/settings/users', allowed: ['SUPER_ADMIN'] },
  { path: '/admin/settings/risk', allowed: ['SUPER_ADMIN'] },
  { path: '/admin/settings/consent', allowed: ['SUPER_ADMIN'] },
  { path: '/admin/settings/data', allowed: ['SUPER_ADMIN'] },
];

async function signIn(page: Page, role: Role): Promise<void> {
  const u = USERS[role];
  await page.goto('/admin/login');
  await page.getByLabel('Work email').fill(u.email);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (role === 'SUPER_ADMIN') {
    await page.getByLabel(/Authenticator code/).fill(TOTP);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
  }
  if (role === 'REVIEWER') {
    await page.getByLabel('6-digit code').fill(TOTP);
    await page.getByRole('button', { name: 'Confirm and continue' }).click();
    await page.getByLabel(/I have saved these recovery codes/).check();
    await page.getByRole('button', { name: 'Continue to CodeProctor' }).click();
  }
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

for (const role of ['RECRUITER', 'AUTHOR', 'REVIEWER', 'SUPER_ADMIN'] as const) {
  test(`TC-004: ${role} opens only the staff pages it is allowed to, by direct URL`, async ({
    page,
  }) => {
    await signIn(page, role);
    for (const { path, allowed } of PAGES) {
      // A hard navigation drops the in-memory token; the silent refresh signs the user back in.
      await page.goto(path);
      // Wait for the page to settle (a heading, or the denial message) so an empty page cannot pass.
      const denied = page.getByText(/Your role does not have access/);
      await expect(
        page.getByRole('main').getByRole('heading').first().or(denied).first(),
        `${role} ${path}`,
      ).toBeVisible();
      if (allowed.includes(role)) {
        await expect(page.getByRole('main'), `${role} ${path}`).toBeVisible();
        await expect(denied, `${role} ${path} must not be denied`).toHaveCount(0);
      } else {
        await expect(denied, `${role} ${path} must be denied`).toBeVisible();
        // No data table, form or invite button is rendered behind the message.
        await expect(page.getByRole('table'), `${role} ${path}`).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Invite a user|Erase data/ })).toHaveCount(0);
      }
    }
  });
}

test('TC-004: a signed-out visitor opening any staff page is sent to the login page with no data shown', async ({
  page,
}) => {
  for (const { path } of PAGES) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.getByRole('table')).toHaveCount(0);
  }
});
