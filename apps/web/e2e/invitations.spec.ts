import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './axe';

// Provisional [BE-06b]: the invitation routes are WEB-ONLY mocks. Mock state lives in the page's
// memory, so each flow stays inside the app and moves with links.
const RECRUITER = { email: 'recruiter@example.test', password: 'Recruiter-Pass-1' };

async function signInAt(page: Page, target: string) {
  await page.goto(`/admin/login?next=${encodeURIComponent(target)}`);
  await page.getByLabel('Work email').fill(RECRUITER.email);
  await page.getByLabel('Password').fill(RECRUITER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${target}$`));
}

test.describe('FR-303 FR-304 FR-305 invitations', () => {
  test('FR-303 C-19: invite one candidate with a waived identity check, which needs a reason', async ({
    page,
  }) => {
    await signInAt(page, '/admin/tests');
    await page
      .getByRole('link', { name: /Frontend and algorithms/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Invite candidates' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Candidate name').fill('Pia Playwright');
    await dialog.getByLabel('Candidate email').fill('pia.playwright@example.test');
    await dialog.getByLabel('No face match / no identity check').check();
    await expect(dialog.getByText(/Check the candidate’s ID on a video call/)).toBeVisible();
    await expectNoAxeViolations(page);
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(dialog.getByText(/Choose why the identity check is waived/)).toBeVisible();
    await dialog
      .getByLabel(/Why is the identity check waived/)
      .selectOption('CANNOT_COMPLETE_ID_CHECK');
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(dialog).toBeHidden();
  });

  test('FR-304 TC-023: a CSV shows a row preview before anything is sent', async ({ page }) => {
    await signInAt(page, '/admin/candidates');
    await page.getByRole('button', { name: 'Invite candidates' }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('Test', { exact: true })
      .selectOption({ label: 'Backend engineer screening' });
    await dialog.getByLabel('Several, from a CSV file').check();
    await dialog.getByLabel('CSV file', { exact: true }).setInputFiles({
      name: 'people.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'email,name\r\nzed@example.test,Zed\r\nnot-an-email,Bad\r\nzed@example.test,Dup\r\n',
      ),
    });
    await expect(dialog.getByTestId('csv-summary')).toContainText(
      '3 rows: 1 can be invited, 2 cannot',
    );
    await expectNoAxeViolations(page);
    await dialog.getByRole('button', { name: 'Invite 1 candidate' }).click();
    await expect(dialog.getByTestId('bulk-result')).toContainText('1 invitation created');
  });

  test('FR-303 ADR 0002: the candidates page shows each status and a timeline', async ({
    page,
  }) => {
    await signInAt(page, '/admin/candidates');
    const row = page.getByRole('row', { name: /Ada Lovelace/ });
    await expect(row).toContainText('Completed');
    await row.getByRole('button', { name: 'Timeline for Ada Lovelace' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('list', { name: /Progress for/ })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
