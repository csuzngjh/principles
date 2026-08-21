import { defineConfig, devices } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = dirname(fileURLToPath(import.meta.url));
const port = process.env.PD_CONSOLE_OWNER_E2E_PORT ?? '3102';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e-owner',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/e2e-start.mjs',
    url: `${baseURL}/api/health`,
    env: {
      PD_CONSOLE_E2E_PORT: port,
      PD_CONSOLE_E2E_OWNER_AUTH: '1',
      PD_CONSOLE_TOKEN: 'owner-e2e-token',
      PD_OWNER_ID: 'owner-e2e',
      PD_OWNER_CREDENTIAL_ID: 'credential-e2e',
    },
    reuseExistingServer: false,
    timeout: 60000,
    cwd: packageDir,
  },
});
