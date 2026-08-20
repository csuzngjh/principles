/* eslint-disable */
// E2E 流程测试：Control Center 代理开关切换 — 验证开关真实影响 .pd/config.yaml 持久化
// 和 UI 状态。这是 PR #1086 的功能验证测试，确保开关不是"装饰按钮"而是真实
// 调用 PATCH /api/v1/config/agents/:name/binding，后端写入 config.yaml，
// resolveAgentRuntimeBinding 在运行时读取该字段决定代理是否执行。
//
// 链路核实（PR #1086 评审）：
//   UI toggle → onBindingChange → PATCH /api/v1/config/agents/:name/binding
//   → pd-config-store.updateAgentBinding → 写 .pd/config.yaml
//   → resolveAgentRuntimeBinding(effective, name).readiness === 'disabled' when enabled=false
//   → runtime-internalization-run-rulehost.ts 检查 binding，artificer/evaluator
//     关闭时 capability.enabled=false，整个 rulehost 管道降级
//
// 测试策略：
//   1. 页面结构：4 依赖分组 + 9 代理 + WorkflowDiagram + CompactStatusBar
//   2. 核心代理开关（scribe）：内联确认 → PATCH → 持久化 → 状态栏反映
//   3. 非核心代理开关（philosopher）：无确认 → PATCH → 持久化
//
// 状态隔离：workers=1 + serial 模式；afterAll 通过 API 恢复 philosopher 为默认 disabled

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://127.0.0.1:${process.env.PD_CONSOLE_E2E_PORT ?? '3101'}`;

// ── API 辅助 ─────────────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(`${BASE_URL}${path}`);
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

async function apiPatch(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => null);
  return { status: resp.status, body: data };
}

/** 从 GET /summary 提取指定 agent 的 enabled 状态 */
async function getAgentEnabled(agentName: string): Promise<boolean> {
  const resp = await apiGet('/api/v1/config/summary');
  expect(resp.status).toBe(200);
  const body = resp.body as {
    success: boolean;
    data: { agents: Array<{ name: string; enabled: boolean }> };
  };
  expect(body.success).toBe(true);
  const agent = body.data.agents.find((a) => a.name === agentName);
  expect(agent, `agent '${agentName}' should exist in summary`).toBeTruthy();
  return agent!.enabled;
}

/** 通过 API 设置 agent 的 enabled 状态（用于测试 setup/teardown） */
async function setAgentEnabled(agentName: string, enabled: boolean): Promise<void> {
  const resp = await apiPatch(`/api/v1/config/agents/${agentName}/binding`, {
    runtimeProfile: 'openclaw.default',
    enabled,
  });
  expect(resp.status).toBe(200);
}

// ── UI 辅助 ──────────────────────────────────────────────────────────────────

/** 收集页面 5xx 和未捕获异常 */
function attachErrorCollectors(page: Page): string[] {
  const errors: string[] = [];
  page.on('response', (resp) => {
    if (resp.url().includes('/api/') && resp.status() >= 500) {
      errors.push(`5xx: ${resp.status()} ${resp.url()}`);
    }
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

test.describe('Control Center 代理开关切换', () => {
  test.describe.configure({ mode: 'serial' });

  test('页面结构：4 依赖分组 + 9 代理 + WorkflowDiagram + CompactStatusBar', async ({ page }) => {
    const errors = attachErrorCollectors(page);

    await page.goto('/#/control-center');
    await page.waitForLoadState('networkidle');

    // 无 5xx 或 pageerror
    expect(errors, `ControlCenter had errors:\n${errors.join('\n')}`).toEqual([]);

    const bodyText = await page.locator('body').innerText();
    expect(bodyText.length).toBeGreaterThan(100);

    // ── 4 依赖分组标题 ──
    const expectedGroups = ['核心三件套', '代码实现链', '质量打磨', '侧链服务'];
    for (const groupName of expectedGroups) {
      expect(bodyText, `group '${groupName}' should render`).toContain(groupName);
    }

    // ── 9 代理 name（camelCase，出现在 L1 头部 mono span）──
    const expectedAgents = [
      'diagnostician',
      'dreamer',
      'scribe',
      'artificer',
      'evaluator',
      'philosopher',
      'rolloutReviewer',
      'correctionObserver',
      'empathyObserver',
    ];
    for (const agentName of expectedAgents) {
      expect(bodyText, `agent '${agentName}' should render`).toContain(agentName);
    }

    // ── WorkflowDiagram：4 个 phase 编号 ──
    const phaseNumbers = ['01', '02', '03', '04'];
    for (const num of phaseNumbers) {
      expect(bodyText, `workflow phase '${num}' should render`).toContain(num);
    }

    // ── CompactStatusBar：核心管道 label ──
    expect(bodyText, `CompactStatusBar 'corePipeline' label should render`).toContain('核心管道');
  });

  test('核心代理 scribe 关闭需内联确认 → PATCH 持久化 → 状态栏显示瘫痪', async ({ page }) => {
    // ── Setup: 确保 scribe 初始为 enabled ──
    await setAgentEnabled('scribe', true);
    expect(await getAgentEnabled('scribe')).toBe(true);

    const errors = attachErrorCollectors(page);

    await page.goto('/#/control-center');
    await page.waitForLoadState('networkidle');

    // ── 找到 scribe 的 AgentCard 和开关按钮 ──
    // 用 data-agent-card 精确定位卡片（避免 text=scribe 匹配到祖先 div 导致
    // 错误定位到其他代理的 toggle 按钮）
    const scribeCard = page.locator('[data-agent-card="scribe"]');
    await expect(scribeCard).toBeVisible();

    const scribeToggle = scribeCard.locator('[data-agent-toggle]');
    await expect(scribeToggle).toBeVisible();
    await expect(scribeToggle).toHaveText('开');

    // ── 点击关闭 scribe ──
    await scribeToggle.click();

    // ── 核心代理：应出现内联确认条（data-confirm-bar）──
    const confirmBar = page.locator('[data-confirm-bar]').first();
    await expect(confirmBar, 'core agent disable should show inline confirm bar').toBeVisible({ timeout: 3000 });

    // 确认条内应有 "确认关闭" 按钮
    const confirmButton = confirmBar.locator('button', { hasText: '确认关闭' });
    await expect(confirmButton).toBeVisible();

    // ── 点击确认关闭 ──
    await confirmButton.click();

    // 等待 PATCH 请求完成
    await page.waitForLoadState('networkidle');

    // ── 验证 UI：scribe 开关文本变为 "关" ──
    await expect(scribeToggle).toHaveText('关');

    // ── 验证 API：GET /summary 中 scribe.enabled=false ──
    const scribeEnabledAfter = await getAgentEnabled('scribe');
    expect(scribeEnabledAfter, 'scribe should be disabled after confirm').toBe(false);

    // ── 验证 CompactStatusBar：核心管道显示 "瘫痪" ──
    // core_trio 中 scribe disabled → paralyzed
    const statusBarText = await page.locator('body').innerText();
    expect(statusBarText, 'CompactStatusBar should show paralyzed when core_trio agent disabled').toContain('瘫痪');

    // 无 5xx 或 pageerror
    expect(errors, `test had errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('核心代理 scribe 重新开启：无确认 → PATCH 持久化 → 状态栏恢复', async ({ page }) => {
    // ── 前置：scribe 应为 disabled（上一个测试的副作用）──
    expect(await getAgentEnabled('scribe')).toBe(false);

    const errors = attachErrorCollectors(page);

    await page.goto('/#/control-center');
    await page.waitForLoadState('networkidle');

    // ── 找到 scribe 开关按钮（文本 "关"）──
    const scribeCard = page.locator('[data-agent-card="scribe"]');
    await expect(scribeCard).toBeVisible();

    const scribeToggle = scribeCard.locator('[data-agent-toggle]');
    await expect(scribeToggle).toBeVisible();
    await expect(scribeToggle).toHaveText('关');

    // ── 点击开启（turning on 永远不确认）──
    await scribeToggle.click();

    // ── 不应出现确认条 ──
    const confirmBar = page.locator('[data-confirm-bar]');
    await expect(confirmBar, 'turning on should NOT show confirm bar').toHaveCount(0);

    // 等待 PATCH 完成
    await page.waitForLoadState('networkidle');

    // ── 验证 UI：开关文本变为 "开" ──
    await expect(scribeToggle).toHaveText('开');

    // ── 验证 API：scribe.enabled=true ──
    expect(await getAgentEnabled('scribe')).toBe(true);

    // ── 验证 CompactStatusBar：不再显示 "瘫痪" ──
    const statusBarText = await page.locator('body').innerText();
    expect(statusBarText, 'CompactStatusBar should not show paralyzed when core_trio restored').not.toContain('瘫痪');

    // 无 5xx 或 pageerror
    expect(errors, `test had errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('非核心代理 philosopher 关闭：无确认 → PATCH 持久化', async ({ page }) => {
    // ── Setup: 通过 API 先开启 philosopher（默认 disabled）──
    await setAgentEnabled('philosopher', true);
    expect(await getAgentEnabled('philosopher')).toBe(true);

    const errors = attachErrorCollectors(page);

    await page.goto('/#/control-center');
    await page.waitForLoadState('networkidle');

    // ── 找到 philosopher 开关按钮（文本 "开"）──
    const philosopherCard = page.locator('[data-agent-card="philosopher"]');
    await expect(philosopherCard).toBeVisible();

    const philosopherToggle = philosopherCard.locator('[data-agent-toggle]');
    await expect(philosopherToggle).toBeVisible();
    await expect(philosopherToggle).toHaveText('开');

    // ── 点击关闭 ──
    await philosopherToggle.click();

    // ── 非核心代理：不应出现确认条 ──
    const confirmBar = page.locator('[data-confirm-bar]');
    await expect(confirmBar, 'non-core agent disable should NOT show confirm bar').toHaveCount(0);

    // 等待 PATCH 完成
    await page.waitForLoadState('networkidle');

    // ── 验证 UI：开关文本变为 "关" ──
    await expect(philosopherToggle).toHaveText('关');

    // ── 验证 API：philosopher.enabled=false ──
    expect(await getAgentEnabled('philosopher')).toBe(false);

    // 无 5xx 或 pageerror
    expect(errors, `test had errors:\n${errors.join('\n')}`).toEqual([]);
  });

  // ── Cleanup: 恢复 philosopher 为默认 disabled 状态 ──
  test.afterAll(async () => {
    // philosopher 默认 disabled，恢复以避免影响后续 spec
    try {
      await setAgentEnabled('philosopher', false);
    } catch {
      // best-effort cleanup — 不阻塞测试退出
    }
  });
});
