import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

interface AxeResults {
  violations: { id: string; help: string; nodes: { target: unknown }[] }[];
}

/**
 * Runs axe-core (WCAG 2.0/2.1 A and AA rules) on the current page. The source is run with
 * page.evaluate, which the page's CSP does not apply to, so the CSP stays on during the test.
 */
export async function expectNoAxeViolations(page: Page): Promise<void> {
  // Next.js updates <title> a moment after a client-side navigation; wait for it.
  await expect(page).toHaveTitle(/.+/);
  await page.evaluate(axeSource);
  const results = await page.evaluate(() =>
    (
      globalThis as unknown as {
        axe: { run: (ctx: unknown, opts: unknown) => Promise<AxeResults> };
      }
    ).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    }),
  );
  expect(
    results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`),
    'axe violations',
  ).toEqual([]);
}
