import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // vitest 4: pool: 'forks' 默认启用隔离，每个测试文件在独立进程中运行
    pool: 'forks',
    // 确保测试完成后进程能正常退出
    teardownTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['tests/**'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    }
  }
});
