// BDD step definitions for owner-approve-prompt-ui.feature
// 前端切面:Owner 在 FocusPage 审批原则 → pending 减少 → ActivationPage 出现激活项
//
// 实现说明:本 step 定义镜像现有 e2e 测试 focus-approve-flow.spec.ts 的实际机制。
// e2e 测试通过 API(而非 UI 按钮点击)执行 approve,因为 UI 无稳定按钮选择器。
// 本 BDD 场景沿用相同 API 端点与断言,确保行为契约与 e2e 一致。
// .feature 中的 "点击第一条审批通过按钮" 是 Owner 可读的用户旅程描述,
// step 实现通过 API 完成 approve(focus-approve-flow.spec.ts 的成熟做法)。

import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createPlaywrightStepRegistry, defineFeature } from './support/playwright-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';

const registry = createPlaywrightStepRegistry();

// ── Background:验证服务已启动 + FocusPage 渲染正常 ──────────────────────────
// 对应 e2e 测试步骤 2(navigate to /#/focus + 验证无 5xx + body 渲染)
registry.given('pd-console 服务已启动在 http://127.0.0.1:3100', async (ctx, page) => {
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
});

// ── Background:governance queue 至少 2 条 pending ────────────────────────────
// 对应 e2e 测试步骤 1(GET /api/v1/governance/queue + 验证 pendingReviewCount >= 2)
registry.given('governance queue 有 2 条待审批项', async (ctx, page, api) => {
  const resp = await api.get('/api/v1/governance/queue');
  expect(resp.ok()).toBeTruthy();
  const body = (await resp.json()) as {
    success: boolean;
    data: { pendingReviewCount?: number };
  };
  expect(body.success).toBe(true);
  expect(body.data.pendingReviewCount).toBeGreaterThanOrEqual(2);
  ctx.state.initialPendingCount = body.data.pendingReviewCount;
});

// ── When:获取 pending approvals + approve 第一条 prompt channel ───────────────
// 对应 e2e 测试步骤 3-4(GET /api/v1/approvals?status=pending + POST /approve)
// 选取 prompt channel:e2e 测试证实这是最可靠的 happy path
// (code_tool_hook 要求 artifact_kind='rule',seed 数据不满足)
registry.when('owner 在 FocusPage 点击第一条审批通过按钮', async (ctx, page, api) => {
  // 获取 pending approvals 列表
  const approvalsResp = await api.get('/api/v1/approvals?status=pending');
  expect(approvalsResp.ok()).toBeTruthy();
  const approvalsBody = (await approvalsResp.json()) as {
    success: boolean;
    data: {
      items: Array<{ approvalId: string; channel: string; status: string }>;
    };
  };
  expect(approvalsBody.success).toBe(true);
  expect(approvalsBody.data.items.length).toBeGreaterThanOrEqual(2);

  // 使用 BDD 专属 seed,避免与既有 E2E 流程争用同一条可变 approval。
  const promptApproval = approvalsBody.data.items.find(
    (a) => a.approvalId === 'apr-prompt-bdd',
  );
  expect(
    promptApproval,
    'seed 应至少包含 1 个 prompt channel approval',
  ).toBeTruthy();
  const firstApproval = promptApproval!;
  expect(firstApproval.status).toBe('pending');
  expect(['prompt', 'code_tool_hook', 'defer_archive']).toContain(firstApproval.channel);

  // approve 端点要求 JSON body(空对象即可),否则返回 400 bad_request
  const approveResp = await api.post(
    `/api/v1/approvals/${firstApproval.approvalId}/approve`,
    { data: {} },
  );
  expect(approveResp.ok()).toBeTruthy();
  const approveBody = (await approveResp.json()) as {
    success: boolean;
    data: {
      approvalId: string;
      status: string;
      activation?: {
        activationId?: string;
        action?: string;
        decision?: string;
      };
      error?: string;
    };
  };
  expect(approveBody.success).toBe(true);
  // approve 后状态应变为 approved
  expect(approveBody.data.status).toBe('approved');
  // 本 scenario 明确要求出现新激活项,降级路径必须失败并带出原因。
  expect(
    approveBody.data.activation,
    `approval did not activate: ${approveBody.data.error ?? 'missing error reason'}`,
  ).toBeDefined();
  expect(approveBody.data.activation?.activationId).toBeTruthy();

  ctx.state.approvalId = firstApproval.approvalId;
  ctx.state.activationId = approveBody.data.activation?.activationId;
});

// ── Then:pending count 减少 1 ────────────────────────────────────────────────
// 对应 e2e 测试步骤 5(GET /api/v1/governance/queue + 验证 count 减少)
registry.then('governance queue 的 pending 数量减少 1', async (ctx, page, api) => {
  const resp = await api.get('/api/v1/governance/queue');
  expect(resp.ok()).toBeTruthy();
  const body = (await resp.json()) as {
    success: boolean;
    data: { pendingReviewCount?: number };
  };
  const initialCount = ctx.state.initialPendingCount as number;
  // 串行执行(workers:1),approve 一条 → pending 恰好减 1
  expect(body.data.pendingReviewCount).toBe(initialCount - 1);
});

// ── And:ActivationPage 出现新的激活项 ────────────────────────────────────────
// 对应 e2e 测试步骤 6(GET /api/v1/activations + 验证至少 1 个 active)
registry.then('ActivationPage 出现新的激活项', async (ctx, page, api) => {
  const resp = await api.get('/api/v1/activations');
  expect(resp.ok()).toBeTruthy();
  const body = (await resp.json()) as {
    success: boolean;
    data: {
      activations: Array<{ id: string; status: string }>;
    };
  };
  expect(body.success).toBe(true);
  const activationId = ctx.state.activationId;
  expect(typeof activationId).toBe('string');
  const activation = body.data.activations.find((a) => a.id === activationId);
  expect(activation, `activation ${String(activationId)} not found`).toBeDefined();
  expect(activation?.status).toBe('active');
});

// ── 加载并注册 feature ───────────────────────────────────────────────────────
const featureText = readFileSync(
  resolveFeaturePath('docs/specs/features/story-a/owner-approve-prompt-ui.feature'),
  'utf8',
);
defineFeature(featureText, registry);
