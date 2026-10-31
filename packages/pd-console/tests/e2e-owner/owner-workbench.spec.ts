import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const shots = resolve('.tmp/owner-workbench');
mkdirSync(shots, { recursive: true });
async function login(page: Page) {
  await page.goto('/#/focus');
  await page.getByLabel('访问令牌').fill('owner-e2e-token');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.waitForURL(/#\/(focus|welcome)$/);
  await page.goto('/#/focus');
  await expect(page.getByTestId('owner-workbench')).toBeVisible({ timeout: 15000 });
}

test('Owner chooses one exact item, reads it, returns and keeps runtime records secondary', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await expect(page.getByRole('heading', { name: '需要你处理', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始处理', exact: true })).toBeVisible();
  const records = page.getByTestId('focus-runtime-records');
  await expect(records).not.toHaveAttribute('open');
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(shots, '01-workbench-wide.png'), fullPage: false });
  const item = page.locator('[data-item-key="approval:apr-readability-long"]');
  await item.click();
  await expect(page).toHaveURL(/review=approval/);
  await expect(page.getByTestId('owner-work-reading')).toContainText('PD 建议怎样改变');
  await expect(page.getByTestId('owner-work-reading')).toContainText('本件材料到这里结束');
  const url = page.url();
  await page.reload();
  await expect(page.getByTestId('owner-workbench')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('owner-work-reading')).toContainText('PD 建议怎样改变');
  expect(page.url()).toBe(url);
  await page.getByRole('button', { name: '返回事项列表', exact: true }).click();
  await expect(page).not.toHaveURL(/review=/);
  await expect(page.getByRole('button', { name: '开始处理', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('owner-work-reading')).toContainText('PD 建议怎样改变');
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(shots, '02-reading-wide.png'), fullPage: false });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: resolve(shots, '04-reading-1280.png'), fullPage: false });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 1024 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const decision = page.getByTestId('owner-work-reading').getByRole('button', { name: '批准这个版本', exact: true });
    await decision.scrollIntoViewIfNeeded();
    await expect(decision).toBeInViewport();
    await page.getByRole('button', { name: '返回事项列表', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(shots, `reading-${viewport.width}x${viewport.height}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '返回事项列表', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(shots, '03-reading-narrow.png'), fullPage: false });
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(shots, '05-reading-320.png'), fullPage: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '切换暗色模式', exact: true }).click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(shots, '06-reading-dark.png'), fullPage: false });
});

test('A failed governance summary preserves readable items and does not unlock unknown permissions', async ({ page }) => {
  await page.route('**/api/v1/governance/experience', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'snapshot_unavailable' }) }));
  await login(page);
  await expect(page.getByTestId('owner-work-item').first()).toBeVisible();
  await expect(page.getByText('部分资料暂未读取，当前列表可能不完整。').first()).toBeVisible();
});

test('Work item types identify their real decision and remain clear without relying on color', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await login(page);
  const promotion = page.getByTestId('owner-work-item').filter({ hasText: 'RuleCode 影子规则待决' }).first();
  await expect(promotion.getByTestId('owner-work-type')).toHaveAttribute('data-kind', 'promotion');
  await expect(promotion.getByTestId('owner-work-type')).toHaveText('规则上线审查');
  const prompt = page.locator('[data-item-key="approval:apr-readability-long"]');
  await expect(prompt.getByTestId('owner-work-type')).toHaveAttribute('data-kind', 'prompt');
  await expect(prompt.getByTestId('owner-work-type')).toHaveText('提示原则审查');
  const rule = page.locator('[data-item-key="approval:apr-hook-1"]');
  await expect(rule.getByTestId('owner-work-type')).toHaveAttribute('data-kind', 'rule');
  await expect(rule.getByTestId('owner-work-type')).toHaveText('执行方案审查');
  await expect(page.locator('[data-item-key^="binding:"]').first().getByTestId('owner-work-type')).toHaveAttribute('data-kind', 'binding');
  await expect(prompt.getByTestId('owner-work-type').locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await prompt.click();
  await expect(page.getByTestId('owner-work-reading').getByTestId('owner-work-type')).toHaveAttribute('data-kind', 'prompt');
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(shots, 'item-types-light.png'), fullPage: false });
  await page.getByRole('button', { name: '切换暗色模式', exact: true }).click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(shots, 'item-types-dark.png'), fullPage: false });
});

test('The task scrollbar follows both themes and daily thoughts remain visible outside runtime history', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await login(page);
  await expect(page.getByTestId('owner-work-item').first()).toBeVisible();
  const list = page.getByRole('navigation', { name: '待处理事项', exact: true });
  const thought = page.getByRole('article', { name: '今日思考', exact: true });
  await expect(thought).toBeVisible();
  await expect(page.getByTestId('focus-runtime-records')).not.toHaveAttribute('open');
  const originalQuote = await thought.locator('p').first().innerText();
  await thought.getByRole('button', { name: '换一句', exact: true }).click();
  await expect(thought.locator('p').first()).not.toHaveText(originalQuote);
  const lightThumb = await list.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor);
  const scrollbarWidth = await list.evaluate(element => parseFloat(getComputedStyle(element, '::-webkit-scrollbar').width));
  expect(scrollbarWidth).toBeGreaterThan(0);
  expect(scrollbarWidth).toBeLessThanOrEqual(8);
  await page.getByRole('button', { name: '切换暗色模式', exact: true }).click();
  const darkThumb = await list.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor);
  expect(darkThumb).not.toBe(lightThumb);
  expect(await list.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await list.focus();
  await page.keyboard.press('End');
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.waitForTimeout(450);
  await list.screenshot({ path: resolve(shots, 'scrollbar-dark.png') });
  await page.getByRole('button', { name: '切换亮色模式', exact: true }).click();
  await page.waitForTimeout(450);
  await list.screenshot({ path: resolve(shots, 'scrollbar-light.png') });
});


test('A hanging runtime source does not hide known approvals or claim all clear', async ({ page }) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
  await page.route('**/api/v1/activations?*', async route => { await held; await route.abort(); });
  await page.route('**/api/v1/activations', async route => { await held; await route.abort(); });
  try {
    await login(page);
    await expect(page.getByTestId('owner-work-item').first()).toBeVisible();
    await expect(page.getByTestId('focus-conclusion-badge')).not.toContainText('一切正常');
    await page.locator('[data-item-key="approval:apr-readability-long"]').click();
    await expect(page.getByTestId('owner-work-reading')).toContainText('PD 建议怎样改变');
    await expect(page.getByTestId('owner-work-reading')).toContainText('正文预览');
  } finally { release?.(); }
});

test('Narrow layout opens the final item at its reading start and returns to its list position', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const last = page.getByTestId('owner-work-item').last();
  const key = await last.getAttribute('data-item-key');
  const item = page.locator(`[data-item-key="${key}"]`);
  await item.click();
  const back = page.getByRole('button', { name: '返回事项列表', exact: true });
  await expect(back).toBeInViewport();
  await back.click();
  await expect(page.locator(`[data-item-key="${key}"]`)).toBeFocused();
  await expect(page.locator(`[data-item-key="${key}"]`)).toBeInViewport();
});


test('A comparison for older bytes cannot confirm a same-ID changed revision', async ({ page }) => {
  function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  await page.route('**/api/v1/approvals/grouped*', async route => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!record(body) || !record(body.data) || !Array.isArray(body.data.groups)) throw new Error('Invalid grouped fixture');
    for (const group of body.data.groups) {
      if (!record(group) || !Array.isArray(group.records) || !group.records.some(row => record(row) && row.id === 'apr-readability-long')) continue;
      group.revisionReview = { artifactId: 'artifact-readability-long', artifactDigest: 'sha256:' + '0'.repeat(64), oldStatement: 'Old bytes', newStatement: 'Changed bytes', intentFields: { ownerIntent: 'Keep intent' } };
    }
    await route.fulfill({ response, json: body });
  });
  await login(page);
  await page.locator('[data-item-key="approval:apr-readability-long"]').click();
  await expect(page.getByTestId('owner-work-reading')).toContainText('待审版本已变化');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('owner-work-reading').getByRole('button', { name: '批准这个版本', exact: true })).toBeDisabled();
});
