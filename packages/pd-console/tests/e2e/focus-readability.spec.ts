/**
 * SPEC-PD-CONSOLE-READABILITY-002 切片1 — Focus 长文阅读分层（真实浏览器）。
 *
 * 真实服务（隔离临时 workspace + seed）+ 真实构建前端（dist/web）。
 * 验证（AC-R1/R2/R3/R5/R6 展示面）：
 * - 长规则候选：标题只承载短预览，逐字全文由正文块渲染（whitespace-pre-wrap）；
 * - 换行/空行/编号/特殊字符（中文引号、emoji）按文本展示；
 * - 审批数量标签称「审批记录」而非「证据」；
 * - 旧「编辑」按钮显示「替换待审版本」；
 * - 320px 窄视口无横向溢出（重排代理验证；200%/400% 真缩放属 Q4，另行人工）。
 */
import { expect, test, type Page } from '@playwright/test';

const READABILITY_PRINCIPLE = 'e2e00000-0000-4000-8000-00000000000b';

async function openReadability(page: Page) {
  const item = page.getByTestId('owner-work-item').and(page.locator('[data-item-key="approval:apr-readability-long"]'));
  await expect(item).toBeVisible();
  await item.click();
  const reading = page.getByTestId('owner-work-reading');
  const disclosure = reading.locator('details').filter({ has: page.locator('summary', { hasText: '展开完整正文' }) }).first();
  await disclosure.locator(':scope > summary').click();
  const body = disclosure.locator(':scope > div');
  await expect(body).toBeVisible();
  return { body, reading };
}

test.describe('SPEC-PD-CONSOLE-READABILITY-002 切片1 — Focus 长文阅读分层', () => {
  test('长规则候选：短标题预览 + 逐字全文正文块（换行保留）', async ({ page }) => {
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');

    const { body } = await openReadability(page);
    await expect(body).toBeVisible();

    // R1/R2：正文逐字保留（scribe 分支 title — statement，无替换字符注入）
    const bodyText = (await body.textContent()) ?? '';
    expect(bodyText).not.toContain('\uFFFD');
    expect(bodyText).toContain('“共享状态”的删除与整体重写必须先说明影响范围 \u{1F600}');
    expect(bodyText).toContain('1. 列出将被修改或删除的内容；');
    expect(bodyText).toContain('2. 说明不可逆后果与恢复方式；');
    expect(bodyText).toContain('3. 按已有确认规则取得 Owner 同意后再执行。');
    // 空行仍在原文中（pre-wrap 下视觉保留；textContent 含连续换行）
    expect(bodyText).toMatch(/影响范围[\s\S]*\n\s*\n/);

    // R3：正文容器保留换行 + 安全换行；正文不小于 15px
    const whiteSpace = await body.evaluate((el) => getComputedStyle(el).whiteSpace);
    expect(whiteSpace).toBe('pre-wrap');
    const fontSize = await body.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(15);
    // 正文为普通字重（不加粗）
    const fontWeight = await body.evaluate((el) => getComputedStyle(el).fontWeight);
    expect(Number(fontWeight)).toBeLessThan(600);

    // R2：标题只承载短预览（码点 ≤ 25，含省略号），不承载整段正文
    const title = page.getByTestId('owner-work-reading').getByRole('heading', { level: 2 });
    await expect(title).toBeVisible();
    const titleText = (await title.textContent()) ?? '';
    expect(Array.from(titleText).length).toBeLessThanOrEqual(25);
    expect(titleText).not.toContain('列出将被修改或删除的内容');
  });

  test('审批数量标签与操作名称（R5/R6）', async ({ page }) => {
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');

    // 004 changes the count to selected work items, never behavior evidence.
    const count = await page.getByTestId('owner-work-item').count();
    expect(count).toBeGreaterThan(0);
    const list = page.getByTestId('owner-workbench').locator('nav');
    await expect(list).toContainText(`${count} 项`);
    await expect(list.locator('h2')).not.toContainText('证据');
    await openReadability(page);
    // R6：旧「编辑」按钮现为「替换待审版本」
    const editBtn = page.getByTestId(`edit-btn-${READABILITY_PRINCIPLE}`);
    await expect(editBtn).toContainText(/替换待审版本|Replace pending version/);
  });

  test('320px 窄视口：长文卡无横向溢出（重排代理验证）', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');

    const { body } = await openReadability(page);
    await expect(body).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test('原则详情页：h1 短标题 + 结论区全文一次渲染（R2/R7）', async ({ page }) => {
    await page.goto(`/#/principles/${READABILITY_PRINCIPLE}`);
    await page.waitForLoadState('networkidle');

    const h1 = page.getByTestId('principle-detail-title');
    await expect(h1).toBeVisible();
    const h1Text = (await h1.textContent()) ?? '';
    // h1 不再整段承载规则正文（长文时为截断预览，不含正文尾段 marker）
    expect(Array.from(h1Text).length).toBeLessThanOrEqual(25);
    const marker = '按已有确认规则取得 Owner 同意后再执行';
    expect(h1Text).not.toContain(marker);

    // 结论区正文块承载逐字全文（unknown 路径 detail-body / known 路径 learned 块）
    const bodyHost = page.getByTestId('principle-detail-body');
    const learnedHost = page.getByTestId('owner-decision-learned');
    const bodyText = await bodyHost.count().then(async (n) =>
      n > 0 ? ((await bodyHost.textContent()) ?? '') : ((await learnedHost.textContent()) ?? ''));
    expect(bodyText).toContain(marker);
    // 换行保留：正文容器为 pre-wrap（文本中的空行在 DOM textContent 中仍在）
    expect(bodyText).toMatch(/影响范围[\s\S]*\n\s*\n/);
  });

  test('截图存档（交付证据，非断言）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');
    await openReadability(page);
    await page.screenshot({ path: '../../.tmp/console-readable/screenshots/focus-1440.png', fullPage: true });

    await page.setViewportSize({ width: 320, height: 700 });
    await page.screenshot({ path: '../../.tmp/console-readable/screenshots/focus-320.png', fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#/principles/${READABILITY_PRINCIPLE}`);
    await page.getByTestId('principle-detail-title').waitFor();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: '../../.tmp/console-readable/screenshots/principle-detail-390.png', fullPage: true });
  });
});
