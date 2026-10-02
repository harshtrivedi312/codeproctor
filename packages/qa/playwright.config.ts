import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end and axe checks. By default the config serves the production build of apps/web with
 * mocked data (the build must have been made with NEXT_PUBLIC_API_MOCKING=enabled). Set
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
