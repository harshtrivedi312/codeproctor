import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './axe';

// Mock users and codes: apps/web/src/mocks/auth-handlers.ts
const RECRUITER = { email: 'recruiter@example.test', password: 'Recruiter-Pass-1' };
const ADMIN = { email: 'admin@example.test', password: 'Admin-Pass-12345' };
const TOTP = '123456';

async function login(page: Page, user: { email: string; password: string }) {
  await page.goto('/admin/login');
  await page.getByLabel('Work email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function openSecurity(page: Page) {
  await page.getByTestId('user-menu').click();
  await page.getByRole('menuitem', { name: 'Security' }).click();
  await expect(page).toHaveURL(/\/admin\/security$/);
  await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
  await expect(page.getByTestId('two-factor-status')).toBeVisible();
}

test.describe('FR-102 Security page', () => {
  test('FR-102: wrong password shows "Password incorrect", keeps the dialog open and the user signed in; the right one continues', async ({
    page,
  }) => {
    await login(page, RECRUITER);
    await openSecurity(page);
    await expectNoAxeViolations(page);

    await page.getByRole('button', { name: 'Set up 2FA' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Current password')).toHaveAttribute('type', 'password');
    await expectNoAxeViolations(page);
    await dialog.getByLabel('Current password').fill('not-my-password');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog.getByText('Password incorrect', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Current password')).toHaveValue('');
    await expectNoAxeViolations(page);

    await dialog.getByLabel('Current password').fill(RECRUITER.password);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog.getByTestId('manual-key')).toBeVisible();
    await expect(dialog.getByAltText(/QR code/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // Still signed in after the failure: a reload restores the session and the page.
    await page.reload();
    await expect(page.getByTestId('two-factor-status')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/security$/);
  });

  test('FR-102: set up 2FA, download recovery codes, regenerate them, then disable (signs out everywhere)', async ({
    page,
  }) => {
    await login(page, RECRUITER);
    await openSecurity(page);
    await expect(page.getByRole('button', { name: 'Disable 2FA' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Set up 2FA' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Current password').fill(RECRUITER.password);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByLabel('6-digit code').fill(TOTP);
    await dialog.getByRole('button', { name: 'Confirm and turn on' }).click();
    await expect(dialog.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(10);
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download recovery codes' }).click();
    expect((await download).suggestedFilename()).toBe('codeproctor-recovery-codes.txt');
    await expectNoAxeViolations(page);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('button', { name: 'Disable 2FA' })).toBeVisible();

    await page.getByRole('button', { name: 'Regenerate recovery codes' }).click();
    await dialog.getByLabel('Current password').fill(RECRUITER.password);
    await dialog.getByRole('button', { name: 'Get new codes' }).click();
    await expect(dialog.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(10);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: 'Disable 2FA' }).click();
    await dialog.getByLabel('Current password').fill(RECRUITER.password);
    await expect(dialog.getByLabel('6-digit code')).toHaveAttribute(
      'autocomplete',
      'one-time-code',
    );
    await expectNoAxeViolations(page);
    // A wrong code keeps the dialog open and the session.
    await dialog.getByLabel('6-digit code').fill('000000');
    await dialog.getByRole('button', { name: 'Turn off 2FA' }).click();
    await expect(dialog.getByText('Password or code incorrect')).toBeVisible();
    await dialog.getByLabel('Current password').fill(RECRUITER.password);
    await dialog.getByLabel('6-digit code').fill(TOTP);
    await dialog.getByRole('button', { name: 'Turn off 2FA' }).click();

    // Turning 2FA off ends every session: back at login with a one-time notice.
    await expect(page).toHaveURL(/\/admin\/login\?reason=two-factor-off/);
    await expect(
      page.getByText('Two-factor sign-in is turned off and you were signed out on all devices.'),
    ).toBeVisible();
    await expect(page.getByText('could not confirm you were signed out')).toHaveCount(0);
    await expectNoAxeViolations(page);
    // The session is really gone, and 2FA is off for the next sign-in.
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login\?reason=expired/);
    await login(page, RECRUITER);
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('FR-102: Super Admin cannot disable 2FA and sees why', async ({ page }) => {
    await login(page, ADMIN);
    await page.getByLabel(/Authenticator code/).fill(TOTP);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await openSecurity(page);
    await expect(page.getByRole('button', { name: 'Disable 2FA' })).toHaveCount(0);
    await expect(page.getByTestId('two-factor-required')).toContainText('required for your role');
    await expect(page.getByRole('button', { name: 'Regenerate recovery codes' })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
