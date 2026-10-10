import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './axe';

// Mock users and codes: apps/web/src/mocks/auth-handlers.ts
const RECRUITER = { email: 'recruiter@example.test', password: 'Recruiter-Pass-1' };
const AUTHOR = { email: 'author@example.test', password: 'Author-Pass-12345' };
const ADMIN = { email: 'admin@example.test', password: 'Admin-Pass-12345' };
const TOTP = '123456';

const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

async function fillLogin(page: Page, user: { email: string; password: string }) {
  await page.getByLabel('Work email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs in and ends on `target` (the 2FA step is handled for the super admin). */
async function signInAt(page: Page, user: { email: string; password: string }, target: string) {
  await page.goto(`/admin/login?next=${encodeURIComponent(target)}`);
  await fillLogin(page, user);
  if (user === ADMIN) {
    await page.getByLabel(/Authenticator code/).fill(TOTP);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
  }
  await expect(page).toHaveURL(new RegExp(`${target}$`));
  await expect(mainNav(page)).toBeVisible();
}

test.describe('FR-103 role-based navigation', () => {
  test('TC-004: a recruiter does not see Settings, and the Settings URL explains why', async ({
    page,
  }) => {
    await signInAt(page, RECRUITER, '/admin');
    await expect(mainNav(page).getByRole('link')).toHaveText([
      'Dashboard',
      'Questions',
      'Tests',
      'Candidates',
      'Reports',
    ]);
    await expect(page.getByTestId('org-name')).toHaveText('Acme Hiring (demo)');
    await page.goto('/admin/settings/users');
    await expect(page.getByText(/Your role does not have access/)).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expectNoAxeViolations(page);
  });

  test('FR-103: an author sees only the dashboard and questions', async ({ page }) => {
    await signInAt(page, AUTHOR, '/admin');
    await expect(mainNav(page).getByRole('link')).toHaveText(['Dashboard', 'Questions']);
    await page.goto('/admin/tests');
    await expect(page.getByText(/Your role does not have access/)).toBeVisible();
  });

  test('FR-102 FR-103: a deep link survives the 2FA step for a super admin, who sees every section', async ({
    page,
  }) => {
    await page.goto('/admin/settings/risk');
    await expect(page).toHaveURL(/\/admin\/login\?reason=expired&next=%2Fadmin%2Fsettings%2Frisk/);
    await fillLogin(page, ADMIN);
    await expect(page).toHaveURL(/\/admin\/2fa\?next=%2Fadmin%2Fsettings%2Frisk/);
    await page.getByLabel(/Authenticator code/).fill(TOTP);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page).toHaveURL(/\/admin\/settings\/risk$/);
    await expect(page.getByRole('heading', { name: 'Risk scoring' })).toBeVisible();
    await expect(mainNav(page).getByRole('link')).toHaveCount(8);
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'Risk scoring',
    );
  });

  test('FR-103: section placeholders and the dashboard have no axe violations', async ({
    page,
  }) => {
    await signInAt(page, ADMIN, '/admin');
    await expectNoAxeViolations(page);
    // Questions is the real question bank now (FE-04; its own spec runs axe on it).
    await mainNav(page).locator('a[href="/admin/questions"]').click();
    await expect(page.getByRole('heading', { name: 'Question bank' })).toBeVisible();
    await expectNoAxeViolations(page);
    // The review queue is real now (D-67 demo; its own tests run axe on it).
    await mainNav(page).locator('a[href="/admin/review"]').click();
    await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();
    await expectNoAxeViolations(page);
    for (const href of ['/admin/live', '/admin/reports']) {
      await mainNav(page).locator(`a[href="${href}"]`).click();
      await expect(page.getByTestId('section-placeholder')).toBeVisible();
      await expectNoAxeViolations(page);
    }
  });
});

test.describe('FE-03 DataTable', () => {
  test('FR-103: sorts, searches and pages the candidates table', async ({ page }) => {
    await signInAt(page, ADMIN, '/admin/candidates');
    const rows = page.getByRole('table').locator('tbody tr');
    await expect(rows).toHaveCount(10);
    await expect(page.getByTestId('table-range')).toHaveText('Showing 1–10 of 14');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(rows).toHaveCount(4);

    // Sorted by name ascending by default; one click flips it.
    const nameHeader = page.getByRole('columnheader', { name: /Name/ });
    await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
    await page.getByRole('button', { name: /^Name/ }).click();
    await expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
    await page.getByLabel('Search candidates').fill('hopper');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Grace Hopper');
    await page.getByLabel('Search candidates').fill('zzz');
    await expect(page.getByTestId('table-no-matches')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByTestId('table-range')).toHaveText('Showing 1–10 of 14');
    await expectNoAxeViolations(page);
  });

  test('FR-103: shows a loading state before the rows arrive', async ({ page }) => {
    await signInAt(page, ADMIN, '/admin');
    await mainNav(page).getByRole('link', { name: 'Candidates' }).click();
    await expect(page.getByTestId('table-skeleton-row').first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible();
  });
});

test.describe('NFR-05 D-19 candidate erasure', () => {
  test('TC-094: erasing a candidate with an open appeal waits and says so; one with nothing open is scheduled', async ({
    page,
  }) => {
    await signInAt(page, ADMIN, '/admin/candidates');
    await page.getByRole('button', { name: 'Erase data for Grace Hopper' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Erase data' }).click();
    const grace = page.getByRole('row', { name: /Grace Hopper/ });
    await expect(grace).toContainText('Waiting for appeal');
    await expect(grace).toContainText('runs as soon as the appeal closes');

    await page.getByRole('button', { name: 'Erase data for Ada Lovelace' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Erase data' }).click();
    await expect(page.getByRole('row', { name: /Ada Lovelace/ })).toContainText(
      'Erasure scheduled',
    );
  });

  test('FR-103: a recruiter sees candidates without the erase action', async ({ page }) => {
    await signInAt(page, RECRUITER, '/admin/candidates');
    await expect(page.getByRole('cell', { name: 'Ada Lovelace', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Erase data/ })).toHaveCount(0);
  });
});

test.describe('FR-103 FR-704 FR-804 D-17 Settings', () => {
  test('FR-103: users page lets a super admin invite, and has no axe violations', async ({
    page,
  }) => {
    await signInAt(page, ADMIN, '/admin/settings/users');
    await expect(page.getByRole('row', { name: /Casey Newhire/ })).toContainText('Invited');
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: 'Invite a user' }).click();
    await page.getByLabel('Full name').fill('Jo Newperson');
    await page.getByLabel('Work email').fill('jo@example.test');
    await page.getByRole('dialog').getByLabel('Role').selectOption('AUTHOR');
    await page.getByRole('button', { name: 'Continue' }).click();
    // FR-102 step-up: the admin confirms with their own password.
    await page.getByLabel('Your password').fill(ADMIN.password);
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByRole('row', { name: /Jo Newperson/ })).toContainText('Invited');
  });

  test('FR-704 D-19: data and privacy shows the default hold and passes axe', async ({ page }) => {
    await signInAt(page, ADMIN, '/admin/settings/data');
    await expect(page.getByLabel('Wait while a review or appeal is open')).toBeChecked();
    await expectNoAxeViolations(page);
    await page.getByLabel('Wait while a review or appeal is open').uncheck();
    await expect(page.getByText('Erasure will not wait')).toBeVisible();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  });

  test('TC-075 FR-804: risk scoring example and weights table pass axe', async ({ page }) => {
    await signInAt(page, ADMIN, '/admin/settings/risk');
    await expect(page.getByTestId('risk-example')).toContainText('score 64, band HIGH');
    await expectNoAxeViolations(page);
  });

  test('D-17: consent versions show the placeholder label, and the page passes axe', async ({
    page,
  }) => {
    await signInAt(page, ADMIN, '/admin/settings/consent');
    await expect(page.getByRole('row', { name: /v0.1-placeholder/ })).toContainText(
      'Placeholder, not approved by Legal',
    );
    await expect(page.getByLabel('Contact shown after declining')).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
