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
  async function openInviteDialog(page: Page) {
    await signInAt(page, '/admin/tests');
    await page
      .getByRole('link', { name: /Frontend and algorithms/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Invite candidates' }).click();
    return page.getByRole('dialog');
  }

  test('FR-303: invite one candidate; the mail is queued for delivery (not "sent")', async ({
    page,
  }) => {
    const dialog = await openInviteDialog(page);
    await dialog.getByLabel('Candidate name').fill('Pia Playwright');
    await dialog.getByLabel('Candidate email').fill('pia.playwright@example.test');
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/queued for delivery/)).toBeVisible();
  });

  test('FR-303: accommodations and the identity waiver are not offered while the API cannot take them', async ({
    page,
  }) => {
    const dialog = await openInviteDialog(page);
    await expect(dialog.getByTestId('accommodations-unavailable')).toBeVisible();
    await expect(dialog.getByLabel('No face match / no identity check')).toHaveCount(0);
    await expect(dialog.getByLabel('Extra time (%)')).toHaveCount(0);
    await expectNoAxeViolations(page);
  });

  // Re-enable when the DTO accepts accommodations (ADR 0015, INVITE_CAPABILITIES.accommodations in
  // features/invitations/schemas.ts; followup in docs/followups/frontend.md). The waiver, its
  // reason and the video-call advice are covered by the unit tests with the capability switched on.
  test.skip('FR-303 C-19: invite one candidate with a waived identity check, which needs a reason', async () => {});

  test('FR-303: with no mail provider the invitation exists but the dialog never says it was sent', async ({
    page,
  }) => {
    await signInAt(page, '/admin/tests');
    await page
      .getByRole('link', { name: /Frontend and algorithms/ })
      .first()
      .click();
    await page.evaluate(() =>
      window.__cpMockInvitations?.setInvitationScenario({ mail: 'disabled' }),
    );
    await page.getByRole('button', { name: 'Invite candidates' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Candidate name').fill('Quinn Quiet');
    await dialog.getByLabel('Candidate email').fill('quinn.quiet@example.test');
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    const warning = dialog.getByRole('alert');
    await expect(warning).toContainText('Invitation created, but the email could not be sent');
    await expect(warning).toContainText(/no email was sent/i);
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeEnabled();
    await expectNoAxeViolations(page);
    await dialog.getByRole('button', { name: 'Invite another candidate' }).click();
    await expect(dialog.getByTestId('mail-not-sent')).toHaveCount(0);
    await expect(dialog.getByLabel('Candidate email')).toHaveValue('');
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
    await expect(dialog.getByTestId('bulk-result')).toContainText('1 queued for delivery');
    await expectNoAxeViolations(page);
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
