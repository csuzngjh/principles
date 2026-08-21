import { expect, test } from '@playwright/test';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test.describe('RuleCode Owner live-decision safety journey', () => {
  test('shows bounded evidence and performs break-glass containment without CLI or host restart', async ({ page, request }) => {
    await page.goto('/#/focus');
    await expect(page.getByRole('heading', { name: /RuleCode Owner decisions|RuleCode 拥有者决策/ })).toBeVisible();
    await expect(page.getByText(/1 shadow rule|1 条 Shadow 规则/)).toBeVisible();

    await page.goto('/#/activation');
    const shadowCard = page.getByTestId('activation-card-act-rule-shadow-e2e');
    const liveCard = page.getByTestId('activation-card-act-rule-live-e2e');
    await expect(shadowCard).toBeVisible();
    await expect(liveCard).toBeVisible();

    const shadowReview = page.getByTestId('owner-review-act-rule-shadow-e2e');
    await expect(shadowReview).toBeVisible();
    await expect(shadowReview).toContainText('20');
    await expect(shadowReview).toContainText('host_liveness_composition: passed');
    await expect(shadowReview).toContainText('owner_identity_configuration: failed');
    await expect(shadowReview).toContainText(/Promotion controls are disabled|拥有者决策功能尚未开放/);

    const pauseResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/activations/emergency-pause'));
    await page.getByRole('button', { name: /Pause all Live RuleCode|暂停全部 Live RuleCode/ }).click();
    expect((await pauseResponse).status()).toBe(200);

    const pausedReview = await request.get('/api/v1/activations/act-rule-shadow-e2e/owner-review');
    expect(pausedReview.status()).toBe(200);
    const pausedBody: unknown = await pausedReview.json();
    expect(pausedBody).toMatchObject({
      success: true,
      data: { activation: { activationId: 'act-rule-shadow-e2e' }, globalPause: { status: 'paused' } },
    });

    const emergencyResponse = page.waitForResponse(response => response.url().endsWith('/act-rule-live-e2e/emergency-deactivate'));
    await liveCard.getByRole('button', { name: /Emergency deactivate|紧急停用/ }).click();
    expect((await emergencyResponse).status()).toBe(200);

    const activationResponse = await request.get('/api/v1/activations');
    const activationBody: unknown = await activationResponse.json();
    expect(activationResponse.status(), JSON.stringify(activationBody)).toBe(200);
    if (!isRecord(activationBody) || activationBody.success !== true || !isRecord(activationBody.data)
      || !Array.isArray(activationBody.data.activations)) throw new Error('Activation response shape is invalid');
    const deactivated = activationBody.data.activations.find(item => isRecord(item) && item.activationId === 'act-rule-live-e2e');
    expect(deactivated).toMatchObject({ activationId: 'act-rule-live-e2e', status: 'deactivated' });
  });
});
