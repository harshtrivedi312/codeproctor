import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end and axe checks. By default the config serves the production build of apps/web with
 * mocked data. The build must be made with
 *   NEXT_PUBLIC_API_MOCKING=enabled ALLOW_MOCKING_IN_PRODUCTION_BUILD=staging-only pnpm --filter @codeproctor/web build
 * (once PR #94 lands the build refuses mocks without the second variable; its value is a label, not
 * a secret; use it for staging and test builds only, never for an image that is deployed). The guard
 * runs at build time only, so the `next start` below needs just NEXT_PUBLIC_API_MOCKING. Set
 * E2E_BASE_URL to run against a deployed environment instead (staging).
 */
const externalBaseUrl = process.env.E2E_BASE_URL;
const port = 3100;

export default defineConfig({
  testDir: './e2e',
  outputDir: 'pw-artifacts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/e2e.json' }]]
    : [['list']],
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      // The frontend's own staff specs (TC-001..004, TC-094, TC-098 browser side), run by the gate
      // against the same production build with mocks, so a failure there blocks a merge as well.
      name: 'web-staff',
      testDir: '../../apps/web/e2e',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: `pnpm --filter @codeproctor/web exec next start -p ${port}`,
        url: `http://localhost:${port}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { NEXT_PUBLIC_API_MOCKING: 'enabled' },
      },
});
