import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './axe';

// Mock users: src/mocks/auth-handlers.ts. Mock tests and questions: src/mocks/test-handlers.ts and
// question-seed.ts. The mock state lives in the page's memory: a full page load resets it, so each
// flow stays inside the app and moves with links.
const RECRUITER = { email: 'recruiter@example.test', password: 'Recruiter-Pass-1' };

async function signInAt(page: Page, target: string) {
  await page.goto(`/admin/login?next=${encodeURIComponent(target)}`);
  await page.getByLabel('Work email').fill(RECRUITER.email);
  await page.getByLabel('Password').fill(RECRUITER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${target}$`));
}

test.describe('FR-301 FR-302 test builder', () => {
  test('FR-301: the tests list passes axe, and a recruiter builds, reorders and saves a test with the keyboard', async ({
    page,
  }) => {
    await signInAt(page, '/admin/tests');
    await expect(page.getByRole('heading', { name: 'Tests', level: 1 })).toBeVisible();
    await expect(page.getByRole('row', { name: /Backend engineer screening/ })).toContainText(
      'In use',
    );
    await expectNoAxeViolations(page);

    await page.getByRole('link', { name: 'New test' }).first().click();
    await expect(page).toHaveURL(/\/admin\/tests\/new$/);
    await page.getByLabel('Name', { exact: true }).fill('Playwright round');
    await expect(page.getByText(/Sections run in the order shown/)).toBeVisible();

    // Profile explanation, STRICT.
    await expect(page.getByText(/also a second camera/)).toBeVisible();
    await page.getByRole('radio', { name: /Strict/ }).check();
    await expect(page.getByTestId('profile-selected')).toContainText('Strict');

    // A fixed question from the bank into section 1.
    await page.getByRole('button', { name: /Add a question from the bank/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Add Two sum' }).click();
    await expectNoAxeViolations(page);
    await dialog.getByRole('button', { name: 'Done' }).click();

    // A second section with a random pick; reorder the sections with the keyboard.
    await page.getByRole('button', { name: 'Add section' }).click();
    await page.getByLabel('Section 2 name').fill('Randoms');
    await page.getByRole('button', { name: /Add random question to section 2/ }).click();
    await page.getByLabel('Tags (all must match)').fill('arrays');
    const down = page.getByRole('button', { name: 'Move section 1 down' });
    await down.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Section 1 name')).toHaveValue('Randoms');
    await expect(page.getByText('Section Section 1 moved to position 2 of 2.')).toBeAttached();
    await expectNoAxeViolations(page);

    await page.getByRole('button', { name: 'Create test' }).click();
    await expect(page).toHaveURL(/\/admin\/tests\/test-\d+$/);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Playwright round');
    await expect(page.getByLabel('Section 1 name')).toHaveValue('Randoms');
    await expect(page.getByRole('radio', { name: /Strict/ })).toBeChecked();
  });

  test('FR-301 ADR 0002: limits above the duration are explained next to the field, and a test in use is read-only', async ({
    page,
  }) => {
    await signInAt(page, '/admin/tests');
    await page.getByRole('link', { name: 'New test' }).first().click();
    await page.getByLabel('Name', { exact: true }).fill('Too long');
    await page.getByLabel('Total duration (minutes)').fill('20');
    await page.getByLabel('Section 1 time limit (minutes)').fill('30');
    await page.getByRole('button', { name: 'Create test' }).click();
    await expect(
      page.getByText(
        /The section time limits add up to 30 minutes, more than the 20 minute duration/,
      ),
    ).toBeVisible();
    await expect(page.getByText('Add at least one question to this section.')).toBeVisible();
    await expectNoAxeViolations(page);

    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Tests' })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Leave and discard' }).click();
    await page.getByRole('link', { name: 'Backend engineer screening' }).click();
    await expect(page.getByText('This test is in use')).toBeVisible();
    await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
    await expectNoAxeViolations(page);
  });
});
