import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against `next dev` with the MSW mocks on (no backend exists yet). Once the
// API merges, point baseURL at the real stack and drop NEXT_PUBLIC_API_MOCKING.
const PORT = 3217;

export default defineConfig({
  testDir: './e2e',
  outputDir: './node_modules/.cache/playwright-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/admin/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_API_MOCKING: 'enabled' },
  },
});
