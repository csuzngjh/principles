import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const shots = resolve('.tmp/owner-workbench');
mkdirSync(shots, { recursive: true });

test('Principle library scans compactly, expands context in place, and returns with its query intact', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/focus');
  await page.getByLabel('访问令牌').fill('owner-e2e-token');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.waitForURL(/#\/(focus|welcome)$/);
  await page.goto('/#/principles?mode=all&q=配置&status=all&sort=createdAt');
  const card = page.locator('article').first();
  await expect(card).toBeVisible({ timeout: 15000 });
  const url = page.url();
  await expect(page.getByTestId('principle-library-overview')).not.toHaveAttribute('open');
  const context = card.getByTestId('principle-context-disclosure');
  await expect(context).not.toHaveAttribute('open');
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(shots, '07-principles-wide.png'), fullPage: false });
  await context.locator(':scope > summary').click();
  expect(page.url()).toBe(url);
  await expect(context).toHaveAttribute('open');
  await card.getByRole('link', { name: '查看原则详情', exact: true }).click();
  await expect(page.getByTestId('principle-detail-title')).toBeVisible();
  await expect(page.getByTestId('principle-formation-disclosure')).not.toHaveAttribute('open');
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(shots, '08-principle-detail-wide.png'), fullPage: false });
  await page.getByRole('button', { name: /返回列表/ }).click();
  expect(page.url()).toBe(url);
  await expect(page.getByRole('textbox', { name: /搜索/ })).toHaveValue('配置');
  await expect(page.getByRole('combobox', { name: 'Sort order' })).toHaveValue('createdAt');
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('article').first()).toBeVisible();
  await expect(page.locator('article h3').first()).toBeInViewport();
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(shots, '09-principles-320.png'), fullPage: false });
});


test('Long learned text stays searchable while library titles remain short', async ({ page }) => {
  function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  const longText = '先核对影响范围，再处理共享状态。' + '保留触发条件与必要例外。'.repeat(100) + '独特检索尾句';
  await page.route('**/api/v1/principles/owner-decision-library', async route => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!record(body) || !record(body.data) || !record(body.data.entries)) throw new Error('Invalid library fixture');
    const entry = body.data.entries['e2e00000-0000-4000-8000-00000000000b'];
    if (!record(entry)) throw new Error('Missing library fixture entry');
    entry.learnedPrinciple = { status: 'known', text: longText, sourceTier: 'scribe' };
    await route.fulfill({ response, json: body });
  });
  await page.goto('/#/focus');
  await page.getByLabel('访问令牌').fill('owner-e2e-token');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.waitForURL(/#\/(focus|welcome)$/);
  await page.goto('/#/principles?mode=all&q=独特检索尾句');
  const title = page.locator('article h3').first();
  await expect(title).toBeVisible();
  expect((await title.innerText()).length).toBeLessThanOrEqual(49);
  expect(await title.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(100);
});

test('A late all-principles response cannot overwrite the newer actionable filter', async ({ page }) => {
  function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  let allCount = 0;
  await page.goto('/#/focus');
  await page.getByLabel('访问令牌').fill('owner-e2e-token');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.waitForURL(/#\/(focus|welcome)$/);
  let started: (() => void) | undefined;
  const requested = new Promise<void>(resolveRequested => { started = resolveRequested; });
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
  await page.route('**/api/principles?filter=all', async route => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!record(body) || !record(body.data) || !Array.isArray(body.data.principles)) throw new Error('Invalid all-principles fixture');
    allCount = body.data.principles.length;
    started?.(); await held; await route.fulfill({ response });
  });
  try {
    const lateResponse = page.waitForResponse(response => response.url().endsWith('/api/principles?filter=all'));
    await page.goto('/#/principles?mode=all');
    await requested;
    await page.evaluate(() => { window.location.hash = '/principles?mode=actionable'; });
    await expect(page.locator('article').first()).toBeVisible();
    const titles = await page.locator('article h3').allTextContents();
    expect(allCount).toBeGreaterThan(titles.length);
    release?.();
    await (await lateResponse).finished();
    await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
    await expect(page).toHaveURL(/mode=actionable/);
    await expect(page.locator('article h3')).toHaveText(titles);
  } finally { release?.(); }
});
