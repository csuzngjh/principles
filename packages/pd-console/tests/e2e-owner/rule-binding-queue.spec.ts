/**
 * PRI-1048 — 治理焦点「规则的正式原则归属」队列 e2e（真实浏览器，Owner 认证模式）。
 *
 * 隔离 fixture workspace（e2e-seed，token 认证开启）证明：
 * - split 父子重复不再出现：唯一候选唯一卡片，计数区分候选数与反馈组数；
 * - 已关联受阻卡片直接回答三问（哪次反馈 / 卡在哪 / 要做什么），
 *   修订资格按真实后端判定展示，不摆不能执行的按钮；
 * - 允许的 bind 走到准确回执；stale 版本请求被权威拒绝（409）；
 * - 首屏 / 目标卡片 / 来源 / 窄屏 / 错误状态截图。
 */
import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.resolve(__dirname, '..', '..', '..', '..', '.tmp', 'pri1048-e2e');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const RULE_BINDING_PRINCIPLE_ID = 'e2e00000-0000-4000-8000-0000000000c1';
const OWNER_AUTH = { Authorization: 'Bearer owner-e2e-token' };

/** The governance binding routes require authenticated Owner identity (no bypass). */
async function loginAsOwner(page: Page): Promise<void> {
  await page.goto('/#/focus');
  await page.getByLabel('访问令牌').fill('owner-e2e-token');
  await page.getByRole('button', { name: '连接' }).click();
  await page.waitForURL(/#\/(?:focus|welcome)$/, { timeout: 15000 });
}

test.describe('PRI-1048 规则归属队列', () => {
  test('首屏计数与去重：唯一候选唯一卡片，候选数与反馈组数分开', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/#/focus');
    const panel = page.getByTestId('rule-binding-panel');
    await expect(panel).toBeVisible();

    const counts = page.getByTestId('rule-binding-counts');
    await expect(counts).toBeVisible();
    // 设计确认 pain（父+router 两条 distinct 候选）+ 回复 pain（1 条）= 3 候选 / 2 组。
    await expect(counts).toContainText('3');
    await expect(counts).toContainText('2');

    const groups = panel.locator('[data-testid="rule-binding-pain-group"]');
    await expect(groups).toHaveCount(2);
    // 每张卡片 testid 即候选 id：去重后 3 个不同 id，无重复。
    const cardIds = await panel.locator('[data-testid^="rule-binding-card-"]').evaluateAll(cards =>
      cards.map(card => card.getAttribute('data-testid')));
    expect(new Set(cardIds).size).toBe(cardIds.length);
    expect(cardIds.length).toBe(3);
    await page.screenshot({ path: path.join(SHOT_DIR, '01-first-screen.png'), fullPage: true });
  });

  test('已关联受阻卡片回答三问：哪次反馈 / 卡在哪 / 要做什么', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/#/focus');
    const panel = page.getByTestId('rule-binding-panel');
    await expect(panel).toBeVisible();

    // 组头：来源反馈原话（未折叠进 JSON）。
    const designGateGroup = panel.locator('[data-testid="rule-binding-pain-group"]', { hasText: '可审阅的SPEC' });
    await expect(designGateGroup).toHaveCount(1);

    // 受阻卡片：阶段徽章 + 受阻行（原因人话 + 无需拥有者批准）+ 下一步。
    const blockedCards = panel.locator('[data-testid^="rule-binding-card-"]', { hasText: '已关联 · 受阻' });
    await expect(blockedCards).toHaveCount(1);
    const blockedCard = blockedCards.first();
    await expect(blockedCard).toContainText('设计确认门禁');
    await expect(blockedCard).toContainText('草案引用核验未通过');
    await expect(blockedCard).toContainText('尚未生成新规则');
    await expect(blockedCard).toContainText('当前无需拥有者批准');
    await expect(blockedCard).toContainText('修订预算已用完');
    // 不摆不能执行的按钮：资格 refused 时无「修订并继续」。
    await expect(blockedCard.getByText('修订并继续')).toHaveCount(0);

    const nextLine = blockedCard.locator('[data-testid^="rule-binding-next-"]');
    await expect(nextLine).toContainText('下一步');
    await expect(nextLine).toContainText('不可恢复');

    // 技术详情默认折叠在「技术详情」<details> 中，不占首屏。
    await expect(blockedCard.locator('details > summary', { hasText: '技术详情' })).toBeVisible();

    // 展开卡片 → 关联原则正文 + 详情入口（不只给 UUID）。
    await blockedCard.getByRole('button', { name: '查看并处理' }).click();
    await expect(blockedCard).toContainText('设计确认门禁：非简单行为变更先交付SPEC并获批准后编码。');
    await expect(blockedCard.getByRole('link', { name: '查看原则详情' }).first())
      .toHaveAttribute('href', new RegExp(`/principles/${RULE_BINDING_PRINCIPLE_ID}`));
    await expect(blockedCard).toContainText('你新增LLM调用层时没先给我可审阅的SPEC');
    await page.screenshot({ path: path.join(SHOT_DIR, '02-target-card-expanded.png'), fullPage: true });
  });

  test('允许的关联走到准确回执；stale 版本被拒（409）', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/#/focus');
    const panel = page.getByTestId('rule-binding-panel');
    await expect(panel).toBeVisible();

    const replyCard = panel.locator('[data-testid^="rule-binding-card-"]', { hasText: '以一句可独立成立的结论开头' }).first();
    await expect(replyCard).toContainText('待选择原则');
    await replyCard.getByRole('button', { name: '查看并处理' }).click();
    await expect(replyCard).toContainText('选择这条规则要落实的原则');

    // 选择目标（真实 eligible target，来自 ledger + material 校验）。
    const target = replyCard.locator(`label:has(input[value="${RULE_BINDING_PRINCIPLE_ID}"])`);
    await expect(target).toHaveCount(1);
    await target.locator('input').check();
    await replyCard.locator('textarea').fill('e2e：这条回复结构规则是设计确认门禁原则的一种实现。');
    await replyCard.getByRole('button', { name: '关联并自动续跑一次' }).click();

    // 准确回执：关联保存 + 该候选无链，修订未开始（诚实降级，不算成功生成）。
    await expect(panel.getByText('关联已保存，但修订尚未开始', { exact: false })).toBeVisible({ timeout: 15000 });
    // 计数实时更新：2 已关联 · 1 待决定（design-gate 受阻 1 不变）。
    await expect(page.getByTestId('rule-binding-counts')).toContainText('2 已关联 · 1 待决定');

    // stale 拒绝：旧 expectedRevision 的 bind 请求被权威拒绝。
    const replyCandidateId = await replyCard.getAttribute('data-testid');
    expect(replyCandidateId).toBeTruthy();
    const stale = await page.request.post(`/api/v1/governance/rule-candidate-bindings/${replyCandidateId?.replace('rule-binding-card-', '')}`, {
      headers: OWNER_AUTH,
      data: {
        action: 'bind', principleId: RULE_BINDING_PRINCIPLE_ID, expectedRevision: 0,
        expectedCandidateDigest: `sha256:${'1'.repeat(64)}`, expectedPrincipleDigest: `sha256:${'2'.repeat(64)}`,
        reason: 'stale probe', requestId: `stale-${Date.now()}`, resumeOnce: true,
      },
    });
    expect(stale.status()).toBe(409);
    expect(((await stale.json()) as { error?: string }).error).toContain('stale_revision');
    await page.screenshot({ path: path.join(SHOT_DIR, '03-after-bind-receipt.png'), fullPage: true });
  });

  test('窄屏 320px 无横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await loginAsOwner(page);
    await page.goto('/#/focus');
    const panel = page.getByTestId('rule-binding-panel');
    await expect(panel).toBeVisible();
    const overflow = await panel.evaluate(element => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: path.join(SHOT_DIR, '04-narrow-320.png'), fullPage: true });
  });

  test('队列接口失败时显示可见错误，不渲染空待办', async ({ page }) => {
    await page.route('**/api/v1/governance/rule-candidate-bindings', route => route.abort());
    await page.goto('/#/focus');
    // 未登录先被导向登录；登录后队列请求被拦截 → 面板显示错误而非空白。
    await page.getByLabel('访问令牌').fill('owner-e2e-token');
    await page.getByRole('button', { name: '连接' }).click();
    await page.waitForURL(/#\/(?:focus|welcome)$/, { timeout: 15000 });
    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: path.join(SHOT_DIR, '05-queue-error.png'), fullPage: true });
  });
});
