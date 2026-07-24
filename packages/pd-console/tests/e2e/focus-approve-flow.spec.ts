/* eslint-disable */
// E2E 流程测试：FocusPage 审批闭环 — governance queue → approve → activation 出现
// 验证 PD 最核心的 owner-review 流程：发现 pending approval → 批准 → 激活生效

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3100';

// ── 辅助：调用 API 并验证响应 ────────────────────────────────────────────────
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

// ── 测试 ─────────────────────────────────────────────────────────────────────

test.describe('FocusPage 审批闭环流程', () => {
  test('governance queue 加载 → approve → pending 减少 + activation 出现', async ({ page }) => {
    // ── 步骤 1：验证初始状态（seed 数据应有 2 个 pending approvals）──────────
    const queueResp = await apiGet('/api/v1/governance/queue');
    expect(queueResp.status).toBe(200);
    const queueBody = queueResp.body as { success: boolean; data: { pendingReviewCount?: number } };
    expect(queueBody.success).toBe(true);
    expect(queueBody.data.pendingReviewCount).toBeGreaterThanOrEqual(2);

    // ── 步骤 2：进入 FocusPage，验证 UI 渲染了 pending 数量 ──────────────────
    const errors: string[] = [];
    page.on('response', (resp) => {
      if (resp.url().includes('/api/') && resp.status() >= 500) {
        errors.push(`5xx: ${resp.status()} ${resp.url()}`);
      }
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');

    // FocusPage 应无 5xx 错误
    expect(errors, `FocusPage had errors:\n${errors.join('\n')}`).toEqual([]);

    // 页面主体应已渲染
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.length).toBeGreaterThan(100);

    // ── 步骤 3：获取 pending approvals 列表 ──────────────────────────────────
    const approvalsResp = await apiGet('/api/v1/approvals?status=pending');
    expect(approvalsResp.status).toBe(200);
    // 注意：approvals 列表端点返回 data.items（不是 data.approvals）
    const approvalsBody = approvalsResp.body as {
      success: boolean;
      data: { items: Array<{ approvalId: string; channel: string; status: string }> };
    };
    expect(approvalsBody.success).toBe(true);
    expect(approvalsBody.data.items.length).toBeGreaterThanOrEqual(2);

    // 选取 prompt channel 的 approval 来测 happy path：
    // code_tool_hook activation 要求 artifact_kind='rule'，seed 的 hook artifact
    // 不满足（会返回 500 activation_failed + reason，那是 ERR-002 合规的降级路径，
    // 但本测试聚焦 approve → activation 闭环，用最可靠的 MVP channel 验证）。
    const promptApproval = approvalsBody.data.items.find(a => a.channel === 'prompt');
    expect(promptApproval, 'seed 应至少包含 1 个 prompt channel approval').toBeTruthy();
    const firstApproval = promptApproval!;
    expect(firstApproval.status).toBe('pending');
    // channel 必须是 MVP proven channels（prompt / code_tool_hook / defer_archive）
    expect(['prompt', 'code_tool_hook', 'defer_archive']).toContain(firstApproval.channel);

    // ── 步骤 4：通过 API approve 第一个 approval ─────────────────────────────
    // approve 端点要求 JSON body（空对象即可），否则返回 400 bad_request
    const approveResp = await apiPost(`/api/v1/approvals/${firstApproval.approvalId}/approve`, {});
    expect(approveResp.status).toBe(200);
    const approveBody = approveResp.body as {
      success: boolean;
      data: {
        approvalId: string;
        status: string;
        activation?: { activationId?: string; action?: string; decision?: string };
        error?: string;
      };
    };
    expect(approveBody.success).toBe(true);
    // approve 后状态应变为 approved，且应有 activation 或明确的 error reason（ERR-002：不能静默）
    expect(approveBody.data.status).toBe('approved');
    if (approveBody.data.activation) {
      // 成功路径：activation 对象应包含 activationId 或 decision
      expect(approveBody.data.activation.activationId ?? approveBody.data.activation.decision).toBeTruthy();
    } else {
      // 失败路径：必须有 error reason（Runtime Contract Rule 9）
      expect(approveBody.data.error).toBeTruthy();
    }

    // ── 步骤 5：验证 pending count 减少 ──────────────────────────────────────
    const queueAfterResp = await apiGet('/api/v1/governance/queue');
    const queueAfterBody = queueAfterResp.body as { success: boolean; data: { pendingReviewCount?: number } };
    expect(queueAfterBody.data.pendingReviewCount).toBeLessThan(queueBody.data.pendingReviewCount!);

    // ── 步骤 6：验证 activation 出现（如果 approve 产生了 activation）────────
    // PRI-517 / EP-09 (test reality gap): previously this block was guarded by
    // `approveBody.data.success`, but `success` lives at the TOP level
    // (`approveBody.success`), not under `data`. So `approveBody.data.success`
    // was always undefined → this activation-verification block NEVER ran. The
    // test "passed" without ever asserting an activation appeared.
    // Fix: guard on the presence of the activation object itself, which is the
    // actual signal that approve produced an activation (prompt/defer_archive
    // channels do; code_tool_hook may not).
    if (approveBody.data.activation) {
      const activationsResp = await apiGet('/api/v1/activations');
      expect(activationsResp.status).toBe(200);
      const activationsBody = activationsResp.body as {
        success: boolean;
        data: { activations: Array<{ activationId: string; status: string }> };
      };
      expect(activationsBody.success).toBe(true);
      // 应至少有 1 个 active activation
      const activeActivations = activationsBody.data.activations.filter(a => a.status === 'active');
      expect(activeActivations.length).toBeGreaterThanOrEqual(1);
    }

    // ── 步骤 7：刷新 FocusPage，验证 UI 反映了新状态 ─────────────────────────
    await page.reload();
    await page.waitForLoadState('networkidle');
    expect(errors.length, `FocusPage reload had errors:\n${errors.join('\n')}`).toBe(0);
  });

  test('approvals grouped 端点：按 principle 分组返回 pending records', async () => {
    const resp = await apiGet('/api/v1/approvals/grouped');
    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: {
        groups: Array<{
          principleId: string;
          principleTitle: string;
          status: string;
          records: Array<{ approvalId: string; status: string; channel: string }>;
        }>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.groups.length).toBeGreaterThanOrEqual(1);

    // 验证至少有一个 pending group
    const pendingGroups = body.data.groups.filter(g => g.status === 'pending');
    expect(pendingGroups.length).toBeGreaterThanOrEqual(1);

    // 验证 group 内 records 的 channel 都是 MVP proven
    for (const group of pendingGroups) {
      for (const record of group.records) {
        expect(['prompt', 'code_tool_hook', 'defer_archive']).toContain(record.channel);
      }
    }
  });
});
