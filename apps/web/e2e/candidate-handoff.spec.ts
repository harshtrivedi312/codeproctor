import { expect, test, type Page } from '@playwright/test';

/**
 * WRITTEN, NOT RUN (FU-FEB-23): the hand-off of the invitation token and the phone link token must
 * leave no token in the address bar, history state or router state. jsdom cannot show this, so
 * this is the real gate before a browser demo or the pilot. Run it against a real `next build` and
 * `next start` (this config runs `next dev`; point a copy of the config at the production server).
 * The API is stubbed per test so no mock registration is needed.
 */
const TOKEN = 'e2e-invitation-token-0123456789abcdef';
const PHONE_TOKEN = 'e2e-phone-link-token-0123456789abcdef';

async function stubLink(page: Page): Promise<void> {
  await page.route('**/v1/candidate/session/link', (route) =>
    route.fulfill({
      json: {
        state: 'OTP_REQUIRED',
        orgName: 'Acme Hiring',
        declineContact: null,
        retryAfterSeconds: null,
        windowStart: '2026-10-05T09:00:00.000Z',
        windowEnd: '2026-10-12T09:00:00.000Z',
      },
    }),
  );
}

async function expectNoToken(page: Page, token: string): Promise<void> {
  const state = await page.evaluate(() => JSON.stringify(history.state));
  expect(page.url()).not.toContain(token);
  expect(state).not.toContain(token);
}

test.describe('candidate link hand-off (FU-FEB-23)', () => {
  test('/t/<token> ends at /t/link with no token anywhere', async ({ page }) => {
    await stubLink(page);
    await page.goto(`/t/${TOKEN}`);
    await expect(page).toHaveURL(/\/t\/link$/);
    await expect(page.getByRole('heading', { level: 1, name: /welcome/i })).toBeVisible();
    await expectNoToken(page, TOKEN);
    await page.evaluate(() => history.back());
    await expect(page).not.toHaveURL(new RegExp(TOKEN));
  });

  test('/t/start#<token> ends at /t/link with no token anywhere', async ({ page }) => {
    await stubLink(page);
    await page.goto(`/t/start#${TOKEN}`);
    await expect(page).toHaveURL(/\/t\/link$/);
    await expect(page.getByRole('heading', { level: 1, name: /welcome/i })).toBeVisible();
    await expectNoToken(page, TOKEN);
  });

  test('a hand-typed /t/link#<token> is refused and sends no API request', async ({ page }) => {
    const calls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/v1/candidate/')) calls.push(r.url());
    });
    await page.goto(`/t/link#${TOKEN}`);
    await expect(
      page.getByRole('heading', { level: 1, name: /could not open this link/i }),
    ).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  test('the phone link /t/phone/enter#<token> ends at /t/phone with no token anywhere', async ({
    page,
  }) => {
    await page.goto(`/t/phone/enter#${PHONE_TOKEN}`);
    await expect(page).toHaveURL(/\/t\/phone$/);
    await expect(
      page.getByRole('button', { name: /turn on the camera and connect/i }),
    ).toBeVisible();
    await expectNoToken(page, PHONE_TOKEN);
  });
});
