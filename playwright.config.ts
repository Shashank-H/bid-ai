import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,

  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],

  use: {
    baseURL: process.env.WEB_BASE_URL ?? 'http://web',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
