/* eslint-disable */
// E2E 流程测试：PainPage evidence-chain + intent decision 流程
// 验证 PD 痛信号到 Owner 决策的完整链路：pain_events → evidence-chain → intent decision

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3100';

async function apiGet(path: string): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(`${BASE_URL}${path}`);
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

async function apiPost(path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  return { status: resp.status, body: data };
}

test.describe('PainPage evidence-chain + intent 流程', () => {
  test('evidence-chain 加载 → 验证 pain_event 出现 → intent 端点可用', async ({ page }) => {
    // ── 步骤 1：验证 evidence-chain API 返回 seed 的 pain_event ──────────────
    const evidenceResp = await apiGet('/api/v1/evidence-chain');
    expect(evidenceResp.status).toBe(200);
    // 注意：evidence-chain 端点返回 data.records（不是 data.items）
    // 每条 record 用 id（格式 pain_<rowid>）和 canonicalPainId（如 pain-e2e-1）
    const evidenceBody = evidenceResp.body as {
      success: boolean;
      data: {
        records?: Array<{
          id: string;
          sourceKind?: string;
          canonicalPainId?: string;
          summary?: string;
          state?: string;
        }>;
      };
    };
    expect(evidenceBody.success).toBe(true);
    // seed 数据应有 1 条 pain_event
    expect(evidenceBody.data.records?.length ?? 0).toBeGreaterThanOrEqual(1);

    const firstPain = evidenceBody.data.records![0];
    expect(firstPain.id).toBeTruthy();
    expect(firstPain.sourceKind).toBeTruthy();

    // ── 步骤 2：进入 PainPage，验证 UI 渲染了 evidence-chain ─────────────────
    const errors: string[] = [];
    page.on('response', (resp) => {
      if (resp.url().includes('/api/') && resp.status() >= 500) {
        errors.push(`5xx: ${resp.status()} ${resp.url()}`);
      }
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto('/#/pain');
    await page.waitForLoadState('networkidle');

    // PainPage 应无 5xx 错误
    expect(errors, `PainPage had errors:\n${errors.join('\n')}`).toEqual([]);

    // 页面主体应已渲染
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.length).toBeGreaterThan(100);
  });

  test('intent summary 端点：返回 intent 概览', async () => {
    const resp = await apiGet('/api/v1/intent');
    // intent 端点受 feature flag 控制，可能返回 200 或 404（flag 关闭）
    if (resp.status === 200) {
      const body = resp.body as { success: boolean; data: unknown };
      expect(body.success).toBe(true);
    } else if (resp.status === 404) {
      // feature flag 关闭时返回 404，这是预期行为
      expect(resp.status).toBe(404);
    } else {
      // 不应有 5xx
      expect(resp.status).toBeLessThan(500);
    }
  });

  test('intent-decisions summary 端点：返回决策汇总或 flag-disabled 降级', async () => {
    // intent-decisions 受 intent_engineering feature flag 控制：
    // - flag 开启：返回 200 + 决策汇总
    // - flag 关闭：返回 403 + reason/nextAction（ERR-002：不静默）
    const resp = await apiGet('/api/v1/intent-decisions/summary');
    if (resp.status === 200) {
      const body = resp.body as {
        success: boolean;
        data: { totalDecisions?: number; recentDecisions?: unknown[] };
      };
      expect(body.success).toBe(true);
    } else if (resp.status === 403) {
      // flag-disabled 路径：必须有 reason + nextAction（Runtime Contract Rule 9）
      const body = resp.body as {
        success: boolean;
        reason?: string;
        nextAction?: string;
      };
      expect(body.success).toBe(false);
      expect(body.reason).toBeTruthy();
      expect(body.nextAction).toBeTruthy();
    } else {
      throw new Error(`unexpected status ${resp.status}: ${JSON.stringify(resp.body)}`);
    }
  });

  test('intent-decisions 按 painId 查询：空结果或 flag-disabled 不报错', async () => {
    // 用 seed 的 pain-e2e-1 查询
    const resp = await apiGet('/api/v1/intent-decisions?painId=pain-e2e-1');
    if (resp.status === 200) {
      const body = resp.body as {
        success: boolean;
        data: { decisions?: unknown[] };
      };
      expect(body.success).toBe(true);
      // seed 数据没有预置 intent decision，应为空数组或 null
      expect(body.data.decisions ?? []).toEqual([]);
    } else if (resp.status === 403) {
      // flag-disabled：验证 reason 存在（ERR-002）
      const body = resp.body as { success: boolean; reason?: string };
      expect(body.success).toBe(false);
      expect(body.reason).toBeTruthy();
    } else {
      throw new Error(`unexpected status ${resp.status}: ${JSON.stringify(resp.body)}`);
    }
  });

  test('intent-decisions 创建：验证 201/200（flag 开启）或 403 降级（flag 关闭）', async () => {
    // 创建一个 intent decision
    const createResp = await apiPost('/api/v1/intent-decisions', {
      painId: 'pain-e2e-1',
      taskId: 'task-diag-1',
      source: 'owner',
      evidenceStrength: 'strong',
      ownerAction: 'acknowledge',
      ownerNote: 'E2E test: acknowledge the pain signal',
    });

    if (createResp.status === 200 || createResp.status === 201) {
      // flag 开启路径：201 = 新建成功，200 = 幂等重放
      const createBody = createResp.body as {
        success: boolean;
        data: { id?: string; painId?: string; ownerAction?: string };
      };
      expect(createBody.success).toBe(true);

      // 验证创建后能查询到
      if (createBody.data.id) {
        const queryResp = await apiGet('/api/v1/intent-decisions?painId=pain-e2e-1');
        const queryBody = queryResp.body as {
          success: boolean;
          data: { decisions?: Array<{ id: string; painId: string }> };
        };
        const found = queryBody.data.decisions?.find(d => d.id === createBody.data.id);
        expect(found, 'created intent decision not found in query').toBeTruthy();
      }
    } else if (createResp.status === 403) {
      // flag-disabled：验证 reason + nextAction（ERR-002）
      const body = createResp.body as {
        success: boolean;
        reason?: string;
        nextAction?: string;
      };
      expect(body.success).toBe(false);
      expect(body.reason).toBeTruthy();
      expect(body.nextAction).toBeTruthy();
    } else {
      throw new Error(`unexpected status ${createResp.status}: ${JSON.stringify(createResp.body)}`);
    }
  });
});
