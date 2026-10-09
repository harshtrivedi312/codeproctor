import { expect, test, type Page } from '@playwright/test';

/**
 * Hand-off of the invitation token and the phone link token (FU-FEB-23): no token may remain in the
 * address bar, history state or router state. jsdom cannot show this, so this is the real-browser
 * gate. Run against a real `next build` and `next start` (packages/qa/playwright.config.ts, project
 * web-staff).
 *
 * The API is stubbed per test with page.route. The build may have MSW mocks on, and the MSW service
 * worker would answer requests inside the worker, where page.route cannot see them; so service
 * workers are blocked for these tests (the app then marks mocking ready after the failed start).
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
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(state).not.toContain(token);
}

test.describe('candidate link hand-off (FU-FEB-23)', () => {
  test.use({ serviceWorkers: 'block' });

  test('/t/<token> ends at /t/link with no token anywhere', async ({ page }) => {
    await stubLink(page);
    await page.goto(`/t/${TOKEN}`);
    await expect(page).toHaveURL(/\/t\/link$/);
    await expect(page.getByRole('heading', { level: 1, name: /welcome/i })).toBeVisible();
    await expectNoToken(page, TOKEN);
    // Back must not return to the token URL: the entry before the goto is about:blank.
    await page.goBack();
    expect(page.url()).toBe('about:blank');
  });

  test('/t/start#<token> ends at /t/link with no token anywhere', async ({ page }) => {
    await stubLink(page);
    await page.goto(`/t/start#${TOKEN}`);
    await expect(page).toHaveURL(/\/t\/link$/);
    await expect(page.getByRole('heading', { level: 1, name: /welcome/i })).toBeVisible();
    await expectNoToken(page, TOKEN);
    await page.goBack();
    expect(page.url()).toBe('about:blank');
  });

  test('/t#<token> (the email link, FR-407) ends at /t/link with no token anywhere', async ({
    page,
  }) => {
    await stubLink(page);
    const queries: string[] = [];
    page.on('request', (r) => {
      // Playwright may report a navigation URL with its fragment; compare what a server would see.
      if (r.url().split('#')[0]?.includes(TOKEN)) queries.push(r.url());
    });
    await page.goto(`/t#${TOKEN}`);
    await expect(page).toHaveURL(/\/t\/link$/);
    await expect(page.getByRole('heading', { level: 1, name: /welcome/i })).toBeVisible();
    await expectNoToken(page, TOKEN);
    // The token never appeared in any request URL (query string, path), fragment aside.
    expect(queries).toHaveLength(0);
    // The entry before the goto is about:blank: /t was replaced, not kept in history.
    await page.goBack();
    expect(page.url()).toBe('about:blank');
  });

  test('a bare /t shows the "could not open this link" state and sends no API request', async ({
    page,
  }) => {
    const calls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/v1/candidate/')) calls.push(r.url());
    });
    await page.goto('/t');
    await expect(
      page.getByRole('heading', { level: 1, name: /could not open this link/i }),
    ).toBeVisible();
    expect(calls).toHaveLength(0);
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
    await page.goBack();
    expect(page.url()).toBe('about:blank');
  });
});
