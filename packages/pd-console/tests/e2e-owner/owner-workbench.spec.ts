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
  await login(page);
  await expect(page.getByRole('heading', { name: '需要你处理', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始处理', exact: true })).toBeVisible();
  const records = page.getByTestId('focus-runtime-records');
  await expect(records).not.toHaveAttribute('open');
  await page.screenshot({ path: resolve(shots, '01-workbench-wide.png'), fullPage: false });
  const item = page.getByTestId('owner-work-item').filter({ hasText: '提示原则审查' }).first();
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
  await page.screenshot({ path: resolve(shots, '02-reading-wide.png'), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '返回事项列表', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(shots, '03-reading-narrow.png'), fullPage: false });
});

test('A failed governance summary preserves readable items and does not unlock unknown permissions', async ({ page }) => {
  await page.route('**/api/v1/governance/experience', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'snapshot_unavailable' }) }));
  await login(page);
  await expect(page.getByTestId('owner-work-item').first()).toBeVisible();
  await expect(page.getByText('部分资料暂未读取，当前列表可能不完整。').first()).toBeVisible();
});
