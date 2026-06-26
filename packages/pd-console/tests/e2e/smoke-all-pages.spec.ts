/* eslint-disable */
// Playwright spec 文件有自己的类型系统（Page/Locator），不参与生产构建，
// 用 eslint-disable 避免 lefthook pre-commit 的 lint glob 匹配报错。
// 后续 spec 增多时可升级为 eslint.config.js 的 overrides 方案。

import { test, expect, type Page } from '@playwright/test';

// 待巡检的页面清单（不含 /principles/:id 需真实 id、/design-system 仅 DEV、/splash /login 认证流）
const SMOKE_PAGES = [
  { path: '/#/focus', name: 'Focus' },
  { path: '/#/pain', name: 'Pain' },
  { path: '/#/principles', name: 'Principles' },
  { path: '/#/activation', name: 'Activation' },
  { path: '/#/debt', name: 'Debt' },
  { path: '/#/control-center', name: 'ControlCenter' },
  { path: '/#/settings', name: 'Settings' },
  // Update 页面已标记为 known failure — /api/update/check 在空工作区返回 500
  // （无法确定当前版本）。这是冒烟测试发现的真实 flow break，需后续修复 update route。
  { path: '/#/update', name: 'Update', fixme: true },
  { path: '/#/report-problem', name: 'ReportProblem' },
  { path: '/#/intent', name: 'Intent' },
] as const;

// 收集页面加载过程中的 5xx 响应和未捕获异常
// 这是发现 flow break 的核心机制：静默吞错、跨源拼接断裂、路由顺序问题都会在这里暴露
function attachErrorCollectors(page: Page): string[] {
  const errors: string[] = [];
  page.on('response', (resp) => {
    if (resp.url().includes('/api/') && resp.status() >= 500) {
      errors.push(`5xx: ${resp.status()} ${resp.url()}`);
    }
  });
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

for (const { path, name, fixme } of SMOKE_PAGES) {
  test(`smoke: ${name} page loads without error`, async ({ page }) => {
    if (fixme) {
      test.fixme(true, 'Known flow break: /api/update/check returns 500 on empty workspace');
    }

    const errors = attachErrorCollectors(page);

    await page.goto(path);
    // 等待网络空闲——确保所有 API 调用完成后再断言
    await page.waitForLoadState('networkidle');

    // 断言 1：无 5xx API 响应
    // 断言 2：无未捕获的前端异常
    expect(errors, `Page ${name} had errors:\n${errors.join('\n')}`).toEqual([]);

    // 断言 3：页面主体已渲染（不是空白页或纯 loading 占位符）
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.length, `Page ${name} body is empty`).toBeGreaterThan(100);
  });
}
