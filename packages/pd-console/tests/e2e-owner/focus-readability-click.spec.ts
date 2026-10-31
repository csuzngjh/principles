/**
 * SPEC-PD-CONSOLE-READABILITY-002 切片1 — 真实 Focus 按钮点击 E2E（补 E19 缺口）。
 *
 * 既有 BDD「在 FocusPage 点击批准」实际直接 POST API（tests/bdd/focus-page.steps.ts
 * 自述）；本 spec 用真实浏览器在 owner-auth 模式（治理就绪门放行）点击 Focus 卡片
 * 的批准按钮，观察真实网络请求与最终服务端状态——不以 API 调用冒充 UI 点击。
 *
 * 切片1 只证明「真实点击路径存在且可用 + 操作名称正确」；分组多目标逐目标语义
 * 属切片2（Q1 待 Owner 裁决），不在本 spec 范围。
 */
import { expect, test } from '@playwright/test';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CLICK_APPROVE_PRINCIPLE = 'e2e00000-0000-4000-8000-000000000008';
const AUTHORIZATION = { Authorization: 'Bearer owner-e2e-token' };

async function ownerLogin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/#/activation');
  await page.getByLabel('访问令牌').fill('owner-e2e-token');
  await page.getByRole('button', { name: '连接' }).click();
  await expect(page).toHaveURL(/#\/(?:focus|welcome)$/);
}

test('authenticated Owner clicks the Focus card approve button — real UI click, real request, real state', async ({ page, request }) => {
  await ownerLogin(page);
  await page.goto('/#/focus?review=approval%3Aapr-click-approve');
  await page.waitForLoadState('networkidle');

  const approveBtn = page.getByTestId(`approve-btn-${CLICK_APPROVE_PRINCIPLE}`);
  await expect(approveBtn).toBeVisible({ timeout: 15000 });
  // 治理就绪门放行（owner-auth + 身份已配置）→ 按钮可点击
  await expect(approveBtn).toBeEnabled();

  // 同卡的「替换待审版本」按钮（原「编辑」）也存在且可点击（R6 称谓）
  const editBtn = page.getByTestId(`edit-btn-${CLICK_APPROVE_PRINCIPLE}`);
  await expect(editBtn).toBeEnabled();
  await expect(editBtn).toContainText(/替换待审版本|Replace pending version/);

  await page.getByTestId('owner-work-reading').locator('details > summary').filter({ hasText: '批准备注（可选）' }).click();
  await page.getByLabel('批准备注（可选）').fill('  看过这份确切草案后批准。  ');
  // 观察真实提交请求（UI 点击产生，而非测试直接 POST）
  const approveResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/approvals/apr-click-approve/approve') && response.request().method() === 'POST',
  );
  await approveBtn.click();
  const response = await approveResponse;
  expect(response.status()).toBe(200);
  const submitted: unknown = response.request().postDataJSON();
  expect(submitted).toMatchObject({ note: '看过这份确切草案后批准。', expectedReview: { schemaVersion: 'approval-review-v1', approvalId: 'apr-click-approve', artifactState: 'present' } });
  const responseBody: unknown = await response.json();
  const data = isRecord(responseBody) && isRecord(responseBody.data) ? responseBody.data : {};
  // 审批结果与激活结果分层断言：审批 approved，激活已派发成功
  expect(data.status).toBe('approved');
  expect(data.activation).toBeTruthy();

  // rc-9：操作结果必须可见——已处理事项退出待办，结果与下一步仍留在阅读区。
  await expect(page.getByRole('heading', { name: '处理结果', exact: true })).toBeVisible();
  await expect(page.getByTestId('owner-work-reading')).toContainText('已批准');

  // 服务端最终权威状态：审批列表含 approved 记录；激活列表含该激活且 active
  const approvalsResponse = await request.get('/api/v1/approvals?status=approved', { headers: AUTHORIZATION });
  expect(approvalsResponse.status()).toBe(200);
  const approvals: unknown = await approvalsResponse.json();
  const items = isRecord(approvals) && isRecord(approvals.data) && Array.isArray(approvals.data.items)
    ? approvals.data.items
    : [];
  const approvedRecord = items.find((item) => isRecord(item) && item.approvalId === 'apr-click-approve');
  expect(approvedRecord).toMatchObject({ status: 'approved' });

  const activationId = isRecord(data.activation) && typeof data.activation.activationId === 'string'
    ? data.activation.activationId
    : undefined;
  expect(activationId).toBeTruthy();
  const activationsResponse = await request.get('/api/v1/activations', { headers: AUTHORIZATION });
  expect(activationsResponse.status()).toBe(200);
  const activations: unknown = await activationsResponse.json();
  const activation = isRecord(activations) && isRecord(activations.data) && Array.isArray(activations.data.activations)
    ? activations.data.activations.find((item) => isRecord(item) && item.activationId === activationId)
    : undefined;
  expect(activation).toMatchObject({ status: 'active' });
});
