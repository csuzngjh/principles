import { expect, test } from '@playwright/test';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('authenticated Owner promotes and rejects exact shadow activations without CLI', async ({ page, request }) => {
  await page.goto('/#/activation');
  await page.getByLabel('Bearer Token').fill('owner-e2e-token');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page).toHaveURL(/#\/(?:focus|welcome)$/);
  await page.goto('/#/activation');

  const promotionReview = page.getByTestId('owner-review-act-rule-shadow-e2e');
  await expect(promotionReview).toBeVisible();
  await expect(promotionReview).toContainText('ready');
  await expect(promotionReview).toContainText(/Owner Identity Configuration|拥有者身份配置/);
  await expect(promotionReview).toContainText(/Passed|已通过/);
  const promoteResponse = page.waitForResponse(response => response.url().endsWith('/act-rule-shadow-e2e/promote'));
  await promotionReview.getByRole('button', { name: /Confirm Live|确认上线/ }).click();
  expect((await promoteResponse).status()).toBe(200);

  const authorization = { Authorization: 'Bearer owner-e2e-token' };
  const promotedReviewResponse = await request.get('/api/v1/activations/act-rule-shadow-e2e/owner-review', {
    headers: authorization,
  });
  expect(promotedReviewResponse.status()).toBe(200);
  const promotedReview: unknown = await promotedReviewResponse.json();
  if (!isRecord(promotedReview) || !isRecord(promotedReview.data) || !Array.isArray(promotedReview.data.decisions)) {
    throw new Error('Promoted Owner review response shape is invalid');
  }
  const promotionDecision = promotedReview.data.decisions.find(decision => isRecord(decision) && decision.decision === 'promote_live');
  expect(promotionDecision).toMatchObject({
    decision: 'promote_live',
    principal: { kind: 'configured_owner', ownerId: 'owner-e2e' },
    authentication: { method: 'console_token', credentialId: 'credential-e2e' },
  });

  const rejectReview = page.getByTestId('owner-review-act-rule-reject-e2e');
  await expect(rejectReview).toBeVisible();
  const rejectResponse = page.waitForResponse(response => response.url().endsWith('/act-rule-reject-e2e/reject-after-shadow'));
  await rejectReview.getByRole('button', { name: /Reject and deactivate|拒绝并停用/ }).click();
  expect((await rejectResponse).status()).toBe(200);

  const activationsResponse = await request.get('/api/v1/activations', { headers: authorization });
  const activations: unknown = await activationsResponse.json();
  if (!isRecord(activations) || !isRecord(activations.data) || !Array.isArray(activations.data.activations)) {
    throw new Error('Activation list response shape is invalid');
  }
  const promoted = activations.data.activations.find(item => isRecord(item) && item.activationId === 'act-rule-shadow-e2e');
  const rejected = activations.data.activations.find(item => isRecord(item) && item.activationId === 'act-rule-reject-e2e');
  expect(promoted).toMatchObject({ action: 'code_tool_hook_live_activate', status: 'active' });
  expect(rejected).toMatchObject({ action: 'code_tool_hook_shadow_activate', status: 'deactivated' });
});
