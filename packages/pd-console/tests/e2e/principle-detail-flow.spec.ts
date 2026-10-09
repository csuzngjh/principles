/* eslint-disable */
// E2E 流程测试：PrincipleDetailPage 4 源拼接 + approve 闭环
// 验证 PD 最复杂的页面：principle detail + approvals grouped + lifecycle + trajectory

import { test, expect } from '@playwright/test';

const BASE_URL = `http://127.0.0.1:${process.env.PD_CONSOLE_E2E_PORT ?? '3101'}`;

async function apiGet(path: string): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(`${BASE_URL}${path}`);
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

test.describe('PrincipleDetailPage 4 源拼接流程', () => {
  test('principle detail + approvals grouped + lifecycle + trajectory 全部加载', async ({ page }) => {
    // ── 步骤 1：获取 principle id（seed 数据应有 p-001）─────────────────────
    const principlesResp = await apiGet('/api/principles?filter=all');
    expect(principlesResp.status).toBe(200);
    const principlesBody = principlesResp.body as {
      success: boolean;
      data: { principles: Array<{ id: string; status: string; text: string }> };
    };
    expect(principlesBody.success).toBe(true);
    expect(principlesBody.data.principles.length).toBeGreaterThanOrEqual(1);

    const principle = principlesBody.data.principles[0];
    expect(principle.id).toBeTruthy();
    expect(principle.text).toBeTruthy();

    // ── 步骤 2：进入 PrincipleDetailPage，收集所有 API 调用 ─────────────────
    const apiCalls: Array<{ url: string; status: number }> = [];
    const errors: string[] = [];
    page.on('response', (resp) => {
      if (resp.url().includes('/api/')) {
        apiCalls.push({ url: resp.url(), status: resp.status() });
        if (resp.status() >= 500) {
          errors.push(`5xx: ${resp.status()} ${resp.url()}`);
        }
      }
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    // PrincipleDetailPage 的 4 源 Promise.all：
    // 1. /api/principles/:id
    // 2. /api/v1/approvals/grouped
    // 3. /api/v1/lifecycle/principles/:id
    // 4. /api/principles/:id/trajectory
    await page.goto(`/#/principles/${encodeURIComponent(principle.id)}`);
    await page.waitForLoadState('networkidle');

    // ── 步骤 3：验证无 5xx 和 pageerror ──────────────────────────────────────
    expect(errors, `PrincipleDetailPage had errors:\n${errors.join('\n')}`).toEqual([]);

    // ── 步骤 4：验证页面主体已渲染（不是空白或 error 兜底）──────────────────
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.length).toBeGreaterThan(100);
    // 页面应包含 principle text（验证 detail 数据已加载）
    expect(bodyText).toContain(principle.text);

    // ── 步骤 5：验证 4 个 API 端点都被调用 ──────────────────────────────────
    const principleDetailCalled = apiCalls.some(c =>
      c.url.includes(`/api/principles/${encodeURIComponent(principle.id)}`) && !c.url.includes('trajectory'),
    );
    const approvalsGroupedCalled = apiCalls.some(c => c.url.includes('/api/v1/approvals/grouped'));
    const lifecycleCalled = apiCalls.some(c =>
      c.url.includes(`/api/v1/lifecycle/principles/${encodeURIComponent(principle.id)}`),
    );
    const trajectoryCalled = apiCalls.some(c =>
      c.url.includes(`/api/principles/${encodeURIComponent(principle.id)}/trajectory`),
    );

    expect(principleDetailCalled, 'principle detail API not called').toBe(true);
    expect(approvalsGroupedCalled, 'approvals grouped API not called').toBe(true);
    expect(lifecycleCalled, 'lifecycle API not called').toBe(true);
    expect(trajectoryCalled, 'trajectory API not called').toBe(true);
  });

  test('principle detail API 直接调用：返回完整结构', async () => {
    // 获取 principle id
    const listResp = await apiGet('/api/principles?filter=all');
    const listBody = listResp.body as {
      success: boolean;
      data: { principles: Array<{ id: string }> };
    };
    const principleId = listBody.data.principles[0].id;

    // 调用 detail API
    const detailResp = await apiGet(`/api/principles/${encodeURIComponent(principleId)}`);
    expect(detailResp.status).toBe(200);
    // 注意：detail 端点返回 data.principle（嵌套在 principle 字段下，不是平铺在 data 上）
    const detailBody = detailResp.body as {
      success: boolean;
      data: { principle: { id: string; text: string; status: string } };
    };
    expect(detailBody.success).toBe(true);
    expect(detailBody.data.principle.id).toBe(principleId);
    expect(detailBody.data.principle.text).toBeTruthy();
    expect(detailBody.data.principle.status).toBeTruthy();
  });

  test('lifecycle API 直接调用：返回 principle 生命周期指标', async () => {
    const listResp = await apiGet('/api/principles?filter=all');
    const listBody = listResp.body as {
      success: boolean;
      data: { principles: Array<{ id: string }> };
    };
    const principleId = listBody.data.principles[0].id;

    const lifecycleResp = await apiGet(`/api/v1/lifecycle/principles/${encodeURIComponent(principleId)}`);
    // lifecycle 端点可能返回 200 或 degraded（如果无数据），但不应 5xx
    expect(lifecycleResp.status).toBe(200);
    const lifecycleBody = lifecycleResp.body as {
      success: boolean;
      data: { principleId?: string; hasRules?: boolean };
    };
    expect(lifecycleBody.success).toBe(true);
  });

  test('trajectory API 直接调用：返回 principle 轨迹', async () => {
    const listResp = await apiGet('/api/principles?filter=all');
    const listBody = listResp.body as {
      success: boolean;
      data: { principles: Array<{ id: string }> };
    };
    const principleId = listBody.data.principles[0].id;

    const trajectoryResp = await apiGet(`/api/principles/${encodeURIComponent(principleId)}/trajectory`);
    expect(trajectoryResp.status).toBe(200);
    const trajectoryBody = trajectoryResp.body as {
      success: boolean;
      data: unknown;
    };
    expect(trajectoryBody.success).toBe(true);
  });

  // PRI-947 回归：「批准」是两步确认，第一步只负责把确认面板展开在 Owner 眼前。
  // 曾经面板渲染在整页最后一个节点，Owner 点完看不到任何变化，误判为审批链路故障。
  // 必须断言视口相交 —— toBeVisible 只校验 CSS 可见性，测不出"渲染在屏幕外"。
  test('点「批准」就地展开二次确认面板：面板落进视口，且第一步不产生任何写入', async ({ page }) => {
    // ── 钉住 seed 里唯一带完整 Scribe 素材、后端判定「可批准」的那条 ──────────
    // 不扫描"第一条可批准的"：e2e 是 workers:1 串行共享同一 workspace，扫描会把
    // 断言对象交给运行时数据顺序，本测试可能在错误的 subject 上通过。
    // 这里的 owner-decision-view 调用只负责把 fixture 失效变成明确报错，不负责挑选。
    const principleId = 'e2e00000-0000-4000-8000-000000000008';
    const viewResp = await apiGet(`/api/v1/principles/${encodeURIComponent(principleId)}/owner-decision-view`);
    expect(viewResp.status, `seed fixture ${principleId} 的 owner-decision-view 返回 ${viewResp.status}`).toBe(200);
    const viewBody = viewResp.body as {
      data?: { availableActions?: Array<{ semantic?: string }> };
    };
    expect(
      viewBody.data?.availableActions?.some((action) => action.semantic === 'approve'),
      `seed fixture ${principleId} 已不再提供 approve 动作（决策素材缺失或审批门 blocked）`,
    ).toBe(true);

    // ── 记录任何非 GET 请求：第一步点击绝不允许提交 ──────────────────────────
    const writes: string[] = [];
    page.on('request', (req) => {
      if (req.method() !== 'GET') writes.push(`${req.method()} ${req.url()}`);
    });

    await page.goto(`/#/principles/${encodeURIComponent(principleId)}`);
    await page.waitForLoadState('networkidle');

    const approveButton = page.locator('[data-action-semantic="approve"]').first();
    await expect(approveButton, '决策区没有渲染「批准」按钮').toBeVisible();

    // 把按钮顶到视口上沿：这是"页面根节点最后一块"旧布局下最苛刻的偏移——面板离视口
    // 最远，同时让面板落点变成确定量而非滚动位置的随机结果。
    await approveButton.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await approveButton.click();

    const panel = page.locator('[data-testid="owner-decision-actions"] [data-testid="owner-decision-confirm"]');
    // 契约本体：第二步必须落在 Owner 正在操作的决策区内，而不是整页末尾的孤立节点。
    await expect(panel, '点「批准」后确认面板没有展开在决策区内').toHaveCount(1);
    await expect(panel).toBeVisible();

    // PRI-948：契约声明的可选批准备注必须出现在面板里并可输入——否则
    // decision_note 恒空，Owner 的裁决理由永远没有存档。
    const noteField = panel.locator('[data-testid="owner-decision-note"]');
    await expect(noteField, '确认面板没有渲染契约声明的批准备注输入框').toBeVisible();
    await expect(noteField).toBeEditable();

    // 面板不是"出现即合格"：Owner 抱怨的是读不到后果，所以必须断言 seed 里那条
    // intentContract.targetBehavior 真的走完了 view model → 面板这一段渲染链。
    await expect(panel).toContainText('【拟议行为】提交确认面板前，Owner 能在决策区读到本条后果说明。');

    const geometry = await panel.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const confirm = Array.from(el.querySelectorAll('button'))
        .find((btn) => btn.textContent?.trim() === '确认')
        ?.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        confirmTop: confirm === undefined ? null : Math.round(confirm.top),
        confirmBottom: confirm === undefined ? null : Math.round(confirm.bottom),
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
      };
    });
    const outside = `（面板 top=${geometry.top} bottom=${geometry.bottom}，「确认」top=${geometry.confirmTop} bottom=${geometry.confirmBottom}，视口高=${geometry.viewportHeight}，整页高=${geometry.documentHeight}）`;

    // 视口相交（下沿）：Owner 不滚动就能看见面板开始的地方，否则等同"点了没反应"。
    expect(geometry.top, `确认面板落在视口下方${outside}`).toBeLessThan(geometry.viewportHeight);
    // 视口相交（上沿）：SPEC 范围 2 要求包围盒"在视口内"，只断言下沿测不出面板翻到头顶之上。
    expect(geometry.bottom, `确认面板落在视口上方${outside}`).toBeGreaterThan(0);
    // Owner 必须真正够得到的那一步：第二步的「确认」按钮本身完整落在视口内。
    expect(geometry.confirmTop, `决策区里没有「确认」按钮${outside}`).not.toBeNull();
    expect(geometry.confirmTop!, `「确认」按钮顶出视口上沿${outside}`).toBeGreaterThanOrEqual(0);
    expect(geometry.confirmBottom!, `「确认」按钮落在视口下方，Owner 须滚动才能提交${outside}`).toBeLessThanOrEqual(geometry.viewportHeight);

    expect(writes, `第一步点击不应触发写入，实际发生：${writes.join(', ')}`).toEqual([]);

    // ── 取消：面板收起，仍然没有任何写入 ─────────────────────────────────────
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(writes, '取消同样不得产生写入').toEqual([]);
  });
});
