/* eslint-disable */
// E2E 回归测试：RuleHostWriter goldenTrace schema 验证 (PR #1079)
//
// 验证 owner 在 FocusPage 点击"批准"时，若 rule artifact 的 goldenTrace
// 含非法 expectedDecision (如 'requireApproval'，这是 RuleHostDecision
// 运行时枚举，不是 GoldenTraceDecision 测试期望值)，系统必须：
//   1. 在 schema 验证层拒绝 (而非进入 sandbox 后才失败)
//   2. 返回清晰的 'golden_trace_schema_invalid' reason (而非旧的
//      不透明的 'gate_decision_not_accepted_shadow:rejected_validation_failed')
//   3. 回滚 approval 到 pending (让 owner 可以修复 artifact 后重试)
//   4. FocusPage UI 不应泄露未捕获的 5xx 错误

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3100';

// ── 辅助：调用 API ───────────────────────────────────────────────────────────
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

test.describe('RuleHostWriter goldenTrace schema 验证 (PR #1079 回归)', () => {
  test('非法 expectedDecision (requireApproval) 必须在 schema 层被拒绝，返回 golden_trace_schema_invalid', async () => {
    // ── 步骤 1：确认 seed 的 bad-trace approval 存在且为 pending ──────────
    const approvalsResp = await apiGet('/api/v1/approvals?status=pending&channel=code_tool_hook');
    expect(approvalsResp.status).toBe(200);
    const approvalsBody = approvalsResp.body as {
      success: boolean;
      data: { items: Array<{ approvalId: string; artifactId: string; channel: string; status: string }> };
    };
    expect(approvalsBody.success).toBe(true);

    const badTraceApproval = approvalsBody.data.items.find(a => a.approvalId === 'apr-hook-bad-trace');
    expect(badTraceApproval, 'seed 应包含 apr-hook-bad-trace 回归 approval').toBeTruthy();
    expect(badTraceApproval!.status).toBe('pending');
    expect(badTraceApproval!.channel).toBe('code_tool_hook');
    expect(badTraceApproval!.artifactId).toBe('artifact-rule-bad-trace');

    // ── 步骤 2：尝试 approve 该 approval ───────────────────────────────────
    // 期望：500 + activation_failed，reason 含 'golden_trace_schema_invalid'
    const approveResp = await apiPost(`/api/v1/approvals/${badTraceApproval!.approvalId}/approve`, {});
    expect(approveResp.status).toBe(500);

    const approveBody = approveResp.body as {
      success: boolean;
      error: string;
      message: string;
      nextAction?: string;
    };
    expect(approveBody.success).toBe(false);
    expect(approveBody.error).toBe('activation_failed');

    // 关键断言：reason 必须包含 'golden_trace_schema_invalid'（PR #1079 的修复）
    // 而不是旧的 'gate_decision_not_accepted_shadow:rejected_validation_failed'
    // （PR #1079 修复前的 bug 行为）
    expect(approveBody.message).toContain('golden_trace_schema_invalid');
    expect(approveBody.message).not.toContain('gate_decision_not_accepted_shadow');

    // reason 应该指向违规字段 expectedDecision，让 owner 知道如何修复
    // 合法值 allow|block|propose_correction 应在错误详情中
    expect(approveBody.message).toMatch(/expectedDecision|requireApproval|allow.*block.*propose_correction/);

    // nextAction 应该给出可执行的下一步（rc-9：不能静默失败）
    expect(approveBody.nextAction).toBeTruthy();
    expect(typeof approveBody.nextAction).toBe('string');
  });

  test('approve 失败后 approval 必须回滚到 pending，允许 owner 修复后重试', async () => {
    // ── 步骤 1：获取当前 bad-trace approval 状态 ───────────────────────────
    const beforeResp = await apiGet('/api/v1/approvals/apr-hook-bad-trace');
    expect(beforeResp.status).toBe(200);
    const beforeBody = beforeResp.body as {
      success: boolean;
      data: { approvalId: string; status: string };
    };
    expect(beforeBody.data.approvalId).toBe('apr-hook-bad-trace');

    // 如果上一个测试已经把它从 pending 改成了别的状态再回滚到 pending，
    // 这里应该是 pending。如果还没跑过 approve，也是 pending。
    // 我们再 approve 一次，验证即使重复 approve 也能稳定回滚到 pending。
    const initialStatus = beforeBody.data.status;
    if (initialStatus === 'approved') {
      // 已被 approve 但 activation 失败时，模型层会自动回滚到 pending。
      // 如果上一个测试已批准且已回滚，这里应为 pending。
      expect(initialStatus, '前一次 approve 失败应已回滚到 pending').toBe('pending');
    }

    // ── 步骤 2：再次 approve，验证回滚行为 ─────────────────────────────────
    const approveResp = await apiPost('/api/v1/approvals/apr-hook-bad-trace/approve', {});
    expect(approveResp.status).toBe(500);

    // ── 步骤 3：验证 approval 已回滚到 pending ─────────────────────────────
    const afterResp = await apiGet('/api/v1/approvals/apr-hook-bad-trace');
    expect(afterResp.status).toBe(200);
    const afterBody = afterResp.body as {
      success: boolean;
      data: { approvalId: string; status: string };
    };
    expect(afterBody.data.status).toBe('pending');
  });

  test('FocusPage 加载含 bad-trace approval 时不应有未捕获的 5xx 错误', async ({ page }) => {
    // ── 监听页面错误 ──────────────────────────────────────────────────────
    const errors: string[] = [];
    page.on('response', (resp) => {
      // 列表/详情 GET 接口 5xx 是问题；approve 5xx 是预期回归路径
      if (resp.url().includes('/api/') && resp.status() >= 500) {
        // approve 接口的 5xx 是预期回归断言路径，不计入页面加载错误
        if (!resp.url().includes('/approve')) {
          errors.push(`5xx: ${resp.status()} ${resp.url()}`);
        }
      }
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    // ── 进入 FocusPage ─────────────────────────────────────────────────────
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');

    // FocusPage 加载本身不应有 5xx 错误（列表/详情接口应正常处理 bad-trace approval）
    expect(errors, `FocusPage had errors:\n${errors.join('\n')}`).toEqual([]);

    // 页面主体应已渲染
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.length).toBeGreaterThan(100);
  });

  test('governance queue 包含 bad-trace approval，pending count >= 2', async () => {
    // ── 验证 governance queue 统计正确包含回归 approval ───────────────────
    // 注意：focus-approve-flow.spec.ts 按字母顺序先运行，已 approve
    // apr-prompt-1，所以 seed 的 3 个 pending 会减到 2（apr-hook-1 +
    // apr-hook-bad-trace）。本测试只验证 bad-trace approval 仍在队列中。
    const queueResp = await apiGet('/api/v1/governance/queue');
    expect(queueResp.status).toBe(200);
    const queueBody = queueResp.body as {
      success: boolean;
      data: { pendingReviewCount?: number };
    };
    expect(queueBody.success).toBe(true);
    // 至少 2 个 pending: apr-hook-1 + apr-hook-bad-trace
    expect(queueBody.data.pendingReviewCount).toBeGreaterThanOrEqual(2);

    // 关键：bad-trace approval 必须仍在 pending 列表（前两个测试的 approve
    // 都因 schema 校验失败而回滚到 pending）
    const approvalsResp = await apiGet('/api/v1/approvals?status=pending');
    expect(approvalsResp.status).toBe(200);
    const approvalsBody = approvalsResp.body as {
      success: boolean;
      data: { items: Array<{ approvalId: string; status: string }> };
    };
    const badTraceStill = approvalsBody.data.items.find(a => a.approvalId === 'apr-hook-bad-trace');
    expect(badTraceStill, 'apr-hook-bad-trace 应在前两次 approve 失败后仍为 pending').toBeTruthy();
    expect(badTraceStill!.status).toBe('pending');
  });
});
