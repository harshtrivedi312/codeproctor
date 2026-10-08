import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './axe';

// Mock users and codes: apps/web/src/mocks/auth-handlers.ts
const RECRUITER = { email: 'recruiter@example.test', password: 'Recruiter-Pass-1' };
const ADMIN = { email: 'admin@example.test', password: 'Admin-Pass-12345' };
const REVIEWER = { email: 'reviewer@example.test', password: 'Reviewer-Pass-12' };
const TOTP = '123456';

// Next.js adds its own role=alert route announcer; skip it.
const appAlert = (page: Page) => page.locator('[role=alert]:not(#__next-route-announcer__)');

async function signOut(page: Page) {
  await page.getByTestId('user-menu').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
}

async function login(page: Page, user: { email: string; password: string }) {
  await page.goto('/admin/login');
  await page.getByLabel('Work email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('FR-101 login', () => {
  test('TC-001: valid staff login without 2FA reaches the dashboard, and sign out returns to login', async ({
    page,
  }) => {
    await login(page, RECRUITER);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: 'Staff dashboard' })).toBeVisible();
    await expect(page.getByText('Signed in as recruiter@example.test')).toBeVisible();
    await signOut(page);
    await expect(page).toHaveURL(/\/admin\/login$/);
    // The refresh cookie is gone, so going back to the dashboard asks for a login.
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login\?reason=expired/);
  });

  test('TC-001: valid login with 2FA enabled shows the 2FA prompt, then the dashboard', async ({
    page,
  }) => {
    await login(page, ADMIN);
    await expect(page).toHaveURL(/\/admin\/2fa/);
    await expect(page.getByRole('heading', { name: 'Two-factor sign-in' })).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByLabel(/Authenticator code/).fill(TOTP);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page.getByText('Signed in as admin@example.test (Super Admin)')).toBeVisible();
  });

  test('FR-102: a recovery code works in place of the authenticator code, once', async ({
    page,
  }) => {
    await login(page, ADMIN);
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill('ABCD-EFGH-2345-6723');
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Staff dashboard' })).toBeVisible();

    await signOut(page);
    await login(page, ADMIN);
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill('ABCDEFGH23456723');
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(appAlert(page)).toContainText('Each recovery code works only once');
  });

  test('TC-002: five wrong passwords lock the account; the sixth, correct attempt is refused (UI message)', async ({
    page,
  }) => {
    await page.goto('/admin/login');
    for (let i = 0; i < 5; i++) {
      await page.getByLabel('Work email').fill(RECRUITER.email);
      await page.getByLabel('Password').fill('wrong-password-1');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(appAlert(page)).toContainText('Sign-in failed.');
    }
    await page.getByLabel('Password').fill(RECRUITER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const alert = appAlert(page);
    await expect(alert).toHaveText(
      'Sign-in failed. If this keeps happening, wait 15 minutes or contact your administrator.',
    );
    await expect(alert).not.toContainText(/locked/i);
    await expect(page).toHaveURL(/\/admin\/login/);
    await expectNoAxeViolations(page);
  });
});

test.describe('FR-102 optional two-factor sign-in', () => {
  test('FR-102 TC-003 (D-70): a reviewer without TOTP signs in with a password alone, sees the recommendation and can dismiss it', async ({
    page,
  }) => {
    await login(page, REVIEWER);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText('Signed in as reviewer@example.test (Reviewer)')).toBeVisible();
    const nudge = page.getByTestId('two-factor-nudge');
    await expect(nudge).toContainText('We recommend turning on two-factor sign-in');
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: 'Dismiss the two-factor recommendation' }).click();
    await expect(nudge).toBeHidden();
  });

  test('FR-102 TC-003 (D-70): set-up from the nudge can be skipped, or finished so the nudge goes away', async ({
    page,
  }) => {
    await login(page, REVIEWER);
    await page.getByRole('link', { name: 'Set it up in Security' }).click();
    await expect(page).toHaveURL(/\/admin\/security$/);
    await page.getByRole('button', { name: 'Set up 2FA' }).click();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.getByRole('button', { name: 'Set up 2FA' }).click();
    await page.getByLabel('Current password').fill(REVIEWER.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('6-digit code').fill(TOTP);
    await page.getByRole('button', { name: 'Confirm and turn on' }).click();
    await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download recovery codes' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('codeproctor-recovery-codes.txt');
    await page.getByLabel(/I have saved these recovery codes/).check();
    await page.getByRole('button', { name: 'Done' }).click();
    // The server ended every session: the user signs in again, now with an authenticator code.
    await expect(page).toHaveURL(/\/admin\/login\?reason=two-factor-on/);
    await expect(
      page.getByText('Two-factor sign-in is on. Sign in again with your authenticator code.'),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    await login(page, REVIEWER);
    await page.getByLabel(/Authenticator code/).fill(TOTP);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId('two-factor-nudge')).toBeHidden();
  });
});

test.describe('FR-107 password reset', () => {
  test('TC-098: forgot password gives the same confirmation for a known and an unknown email', async ({
    page,
  }) => {
    const seen: string[] = [];
    for (const email of [REVIEWER.email, 'nobody@example.test']) {
      await page.goto('/admin/forgot-password');
      await page.getByLabel('Work email').fill(email);
      await page.getByRole('button', { name: 'Send reset link' }).click();
      const status = page.getByRole('status').filter({ hasText: 'Check your email' });
      await expect(status).toBeVisible();
      seen.push((await status.textContent()) ?? '');
    }
    expect(seen[0]).toBe(seen[1]);
    await expectNoAxeViolations(page);
  });

  test('TC-098: the emailed link sets a password once, never leaks the token, and TOTP is still asked at next login', async ({
    page,
  }) => {
    const consoleText: string[] = [];
    const requestUrls: string[] = [];
    page.on('console', (m) => consoleText.push(m.text()));
    page.on('request', (r) => requestUrls.push(r.url()));

    const response = await page.goto('/admin/reset-password#token=mock-reset-token');
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    await expect(page.getByRole('list', { name: 'Password rules' })).toContainText(
      'At least 12 characters',
    );
    // The token left the address bar and was not stored anywhere.
    await expect(page).toHaveURL(/\/admin\/reset-password$/);
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain('mock-reset-token');
    await expectNoAxeViolations(page);

    await page.getByLabel('New password', { exact: true }).fill('Correct-Horse-9');
    await page.getByLabel('Repeat the new password').fill('Correct-Horse-9');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page).toHaveURL(/\/admin\/login\?reset=done/);
    await expect(page.getByRole('status')).toContainText('Password saved');

    // The user is not signed in; a Super Admin still passes TOTP.
    await page.getByLabel('Work email').fill(ADMIN.email);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/admin\/2fa/);

    // Second use of the same link is refused.
    await page.goto('/admin/reset-password#token=mock-reset-token');
    await page.getByLabel('New password', { exact: true }).fill('Another-Pass-99');
    await page.getByLabel('Repeat the new password').fill('Another-Pass-99');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(appAlert(page)).toContainText('This link cannot be used');
    await expect(appAlert(page)).toContainText('expired or was already used');

    expect(consoleText.join('\n')).not.toContain('mock-reset-token');
    expect(requestUrls.join('\n')).not.toContain('mock-reset-token');
  });

  test('TC-098: an expired link is refused with a way to get a new one', async ({ page }) => {
    await page.goto('/admin/reset-password#token=mock-expired-token');
    await page.getByLabel('New password', { exact: true }).fill('Correct-Horse-9');
    await page.getByLabel('Repeat the new password').fill('Correct-Horse-9');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(appAlert(page)).toContainText('This link cannot be used');
    await expect(page.getByRole('link', { name: 'request a new reset link' })).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('ADR 0003: the staff invite page uses the same rules and sends the user to login', async ({
    page,
  }) => {
    const response = await page.goto('/admin/set-password#token=mock-invite-token');
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    await page.getByLabel('New password', { exact: true }).fill('Welcome-Pass-12');
    await page.getByLabel('Repeat the new password').fill('Welcome-Pass-12');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page).toHaveURL(/\/admin\/login\?reset=done/);
  });
});

test.describe('axe on the sign-in page', () => {
  test('WCAG 2.1 AA: login page', async ({ page }) => {
    await page.goto('/admin/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
