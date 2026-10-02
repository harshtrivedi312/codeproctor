import type { FullConfig } from '@playwright/test';

/** Warms the server so the first test does not pay for cold route loading. */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  for (const path of ['/t/demo/test', '/mockServiceWorker.js']) {
    await fetch(new URL(path, baseURL)).catch(() => undefined);
  }
}
