/**
 * QA-01 end-to-end checks on the mocked candidate test screen (/t/demo/test, FE-01).
 * Test titles start with the TC ID from /docs/test-cases.md. Real-API versions of these cases
 * replace the mocks when the backend steps merge (see /docs/test-matrix.md).
 */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const DEMO_URL = '/t/demo/test';

async function startWithoutFullscreen(page: Page): Promise<void> {
  await page.goto(DEMO_URL);
  await page.getByRole('button', { name: /continue without fullscreen/i }).click();
}

test.describe('candidate test screen (mocked)', () => {
  test('TC-041 three Run clicks within two seconds send one run request', async ({ page }) => {
    let runs = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/questions\/[^/]+\/run$/.test(req.url())) runs++;
    });
    await startWithoutFullscreen(page);
    const run = page.getByRole('button', { name: /run/i }).first();
    await run.click();
    await page.getByRole('button', { name: /run/i }).first().click({ force: true });
    await page.getByRole('button', { name: /run/i }).first().click({ force: true });
    await expect(page.getByText(/sample tests passed/)).toBeVisible();
    expect(runs).toBe(1);
  });

  test('TC-050 fullscreen exit locks the editor and shows the overlay', async ({ page }) => {
    await startWithoutFullscreen(page);
    await page.getByRole('button', { name: /simulate fullscreen exit/i }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByTestId('editor-region')).toHaveAttribute('data-readonly', 'true');
    await expect(page.getByTestId('warning-pill')).toContainText('Warnings: 1');
  });

  test('TC-092 start gate has no WCAG 2.1 AA violations', async ({ page }) => {
    await page.goto(DEMO_URL);
    await expect(page.getByText('Enter fullscreen to begin')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('TC-092 running test screen has no WCAG 2.1 AA violations', async ({ page }) => {
    await startWithoutFullscreen(page);
    await expect(page.getByTestId('editor-region')).toBeVisible();
    // Monaco applies its dark theme after the editor region is visible. Axe run earlier saw the
    // light-theme colours and reported color-contrast on the textarea and `.view-line .mtk1`
    // (flaky, 2 of 5 runs). Wait for the real theme, then two animation frames; the check itself
    // is unchanged.
    await expect(page.locator('.monaco-editor.vs-dark .view-lines')).toBeVisible();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    // Ids only, so a failure names the rule instead of dumping the page.
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
