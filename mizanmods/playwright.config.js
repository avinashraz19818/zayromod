import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/browser.spec.js', workers: 1,
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:3000',
    headless: true,
    launchOptions: process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] } : {}
  }
});
