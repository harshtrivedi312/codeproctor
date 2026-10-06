import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './axe';

// Mock users: apps/web/src/mocks/auth-handlers.ts. Mock questions: src/mocks/question-seed.ts.
// The mock question bank lives in the page's memory: a full page load (page.goto) resets it, so
// each flow below stays inside the app and moves with links.
const AUTHOR = { email: 'author@example.test', password: 'Author-Pass-12345' };
const RECRUITER = { email: 'recruiter@example.test', password: 'Recruiter-Pass-1' };

async function signInAt(page: Page, user: { email: string; password: string }, target: string) {
  await page.goto(`/admin/login?next=${encodeURIComponent(target)}`);
  await page.getByLabel('Work email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${target}$`));
}

test.describe('FR-201..FR-205 question bank', () => {
  test('FR-201: list filters and search, then the editor tabs work with the keyboard and pass axe', async ({
    page,
  }) => {
    await signInAt(page, AUTHOR, '/admin/questions');
    await expect(page.getByRole('heading', { name: 'Question bank' })).toBeVisible();
    await expect(page.getByRole('row', { name: /Merge intervals/ })).toBeVisible();
    await expectNoAxeViolations(page);

    await page.getByLabel('Type', { exact: true }).selectOption('MCQ');
    await expect(page.getByRole('row', { name: /Merge intervals/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Cost of binary search/ })).toBeVisible();
    await page.getByLabel('Type', { exact: true }).selectOption('');
    await page.getByRole('searchbox').fill('rotate');
    await expect(page.getByRole('row', { name: /Rotate an array/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Two sum/ })).toHaveCount(0);

    await page.getByRole('link', { name: 'Rotate an array', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/questions\/q-rotate$/);
    await expect(page.getByRole('tablist', { name: 'Question sections' })).toBeVisible();
    await page.getByRole('tab', { name: 'Statement' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Languages and starter code' })).toBeFocused();
    // Real Monaco loads from the self-hosted files.
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 });
    await expectNoAxeViolations(page);
    await page.getByRole('tab', { name: 'Test cases' }).click();
    await expectNoAxeViolations(page);
    await page.getByRole('tab', { name: 'Variants' }).click();
    await expectNoAxeViolations(page);
    await page.getByRole('tab', { name: 'AI reference solutions' }).click();
    await expect(page.getByText('Collected solutions')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('TC-012 FR-203: validation names the failing variant and test; fixing it and adding AI solutions allows Publish', async ({
    page,
  }) => {
    await signInAt(page, AUTHOR, '/admin/questions');
    await page.getByRole('link', { name: 'Rotate an array', exact: true }).click();
    await expect(page.getByRole('tablist', { name: 'Question sections' })).toBeVisible();
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByText('Validation failed')).toBeVisible();
    const failing = page.getByRole('table', { name: 'Results for Variant 2' });
    await expect(failing.getByRole('row', { name: /Test 2/ })).toContainText('Wrong answer');
    await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await expectNoAxeViolations(page);

    await page.getByRole('tab', { name: 'Variants' }).click();
    const card = page.getByRole('region', { name: 'Variant 2' });
    await card.getByLabel('Expected output, slot 2').fill('4 5 6 1 2 3');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Saved\./)).toBeVisible();
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByText('Validation passed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled();

    await page.getByRole('tab', { name: 'AI reference solutions' }).click();
    for (const assistant of ['ChatGPT', 'Claude']) {
      await page.getByRole('button', { name: 'Add solution' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Assistant').fill(assistant);
      await dialog.getByLabel('Model label').fill('business plan');
      await dialog.locator('.monaco-editor').first().click();
      await page.keyboard.type('print(1)');
      await expectNoAxeViolations(page);
      await dialog.getByRole('button', { name: 'Add solution' }).click();
      await expect(dialog).toBeHidden();
    }
    await expect(page.getByRole('button', { name: 'Publish' })).toBeEnabled();
    // The API publishes only after a passing run of this very content and the AI gate (BE-04c).
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/Version 1 is published\. Editing it later/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await expectNoAxeViolations(page);
  });

  test('FR-204 TC-013: editing a published question creates a draft version; an older version is read-only', async ({
    page,
  }) => {
    await signInAt(page, AUTHOR, '/admin/questions');
    await page.getByRole('link', { name: 'Merge intervals', exact: true }).click();
    await expect(page.getByRole('tablist', { name: 'Question sections' })).toBeVisible();
    await expect(page.getByText(/Version 2 is published and cannot change/)).toBeVisible();
    await page.getByLabel('Title').fill('Merge intervals (revised)');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(
      page.getByText(/Saved as version 3 \(draft\)\. The published version 2 is unchanged\./),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Version history' }).click();
    await expect(page.getByRole('link', { name: 'Version 3' })).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByRole('link', { name: 'Version 1', exact: true }).click();
    await expect(page.getByText(/You are looking at version 1\. It is read-only/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(page.getByLabel('Title')).toBeDisabled();
    await expectNoAxeViolations(page);
  });

  test('FR-201: leaving with unsaved edits asks first', async ({ page }) => {
    await signInAt(page, AUTHOR, '/admin/questions');
    await page.getByRole('link', { name: 'Two sum', exact: true }).click();
    await expect(page.getByRole('tablist', { name: 'Question sections' })).toBeVisible();
    await page.getByLabel('Title').fill('Two sum, edited');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByRole('link', { name: 'Version history' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Leave without saving?')).toBeVisible();
    await expectNoAxeViolations(page);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(/\/admin\/questions\/q-twosum$/);
    await page.getByRole('link', { name: 'Version history' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Leave and discard' }).click();
    await expect(page).toHaveURL(/\/versions$/);
  });

  test('TC-012 FR-203: a complete multiple-choice draft publishes in one click, and then cannot be published again', async ({
    page,
  }) => {
    await signInAt(page, AUTHOR, '/admin/questions');
    await page.getByLabel('Status', { exact: true }).selectOption('DRAFT');
    await page.getByRole('link', { name: 'Cost of a hash lookup (draft)', exact: true }).click();
    await expect(page.getByRole('tablist', { name: 'Question sections' })).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/Version 1 is published\. Editing it later/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await expectNoAxeViolations(page);
  });

  test('DL-32 FR-103: a recruiter opening a question gets a read-only summary with the hidden parts left out', async ({
    page,
  }) => {
    await signInAt(page, RECRUITER, '/admin/questions');
    await page.goto('/admin/questions/q-merge');
    await expect(page.getByRole('heading', { name: 'Merge intervals', level: 1 })).toBeVisible();
    await expect(page.getByText(/hidden for your role/)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Visible sample test cases' })).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Save|Validate|Publish/ })).toHaveCount(0);
    expect(await page.content()).not.toContain('out.append');
    await expectNoAxeViolations(page);
  });

  test('FR-103 TC-004: a recruiter reads the list and opens the summary through the title link, never the editor', async ({
    page,
  }) => {
    await signInAt(page, RECRUITER, '/admin/questions');
    await expect(page.getByRole('row', { name: /Merge intervals/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New question' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Merge intervals', exact: true }).click();
    await expect(page.getByText(/hidden for your role/)).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
  });
});
