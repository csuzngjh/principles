import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ESM 环境下 __dirname 不可用（package.json 有 "type": "module"），需手动构造
const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Playwright 1.61 顶层 testDir 只接受 string,不接受数组。
  // 用父目录 ./tests + testMatch 限定到 e2e specs + bdd steps,
  // 保持原 testDir: './tests/e2e' 的范围不变,新增 bdd/*.steps.ts。
  testDir: './tests',
  testMatch: ['e2e/**/*.spec.ts', 'bdd/**/*.steps.ts'],
  fullyParallel: false, // 单服务器实例 + SQLite 文件锁，串行避免竞争
  workers: 1, // 单 worker：所有 E2E 测试共享同一 workspace + 服务器实例，跨文件状态依赖（如 intent flag toggle）需要严格串行
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
  ],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node scripts/e2e-start.mjs',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    cwd: __dirname,
  },
});
