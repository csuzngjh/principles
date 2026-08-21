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
});
