import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createPlaywrightStepRegistry, defineFeature } from './support/playwright-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';

const registry = createPlaywrightStepRegistry();

function isPrinciplesEnvelope(value: unknown): value is { data: { principles: Array<{ id: string; text: string }> } } {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'data')) return false;
  const data = Object.getOwnPropertyDescriptor(value, 'data')?.value;
  if (typeof data !== 'object' || data === null || !Object.hasOwn(data, 'principles')) return false;
  const principles = Object.getOwnPropertyDescriptor(data, 'principles')?.value;
  return Array.isArray(principles) && principles.every(item => typeof item === 'object' && item !== null
    && Object.hasOwn(item, 'id') && typeof Object.getOwnPropertyDescriptor(item, 'id')?.value === 'string'
    && Object.hasOwn(item, 'text') && typeof Object.getOwnPropertyDescriptor(item, 'text')?.value === 'string');
}

registry.given('pd-console governance projection BDD 服务可用', async (ctx, page) => {
  await page.goto('/');
  expect(await page.locator('body').innerText()).not.toHaveLength(0);
  await expect(page).toHaveURL(/#\/focus$/);
});

registry.given('workspace 中存在可查看的原则', async (ctx, page, api) => {
  const response = await api.get('/api/principles?filter=all');
  expect(response.ok()).toBeTruthy();
  const body: unknown = await response.json();
  expect(isPrinciplesEnvelope(body)).toBe(true);
  if (!isPrinciplesEnvelope(body)) throw new Error('principles_fixture_invalid');
  expect(body.data.principles.length).toBeGreaterThan(0);
  ctx.state.principleId = body.data.principles[0]?.id;
  ctx.state.principleText = body.data.principles[0]?.text;
});

registry.given('该原则的治理投影需要 Owner 决策', async (ctx, page) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const principleId = String(ctx.state.principleId);
  await page.route(`**/api/v1/principles/${encodeURIComponent(principleId)}/governance`, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {
      schemaVersion: '1', principleId, asOf: '2026-08-20T10:00:00.000Z',
      summary: { headlineCode: 'governance.headline.owner_decision', reasonCode: 'governance.reason.approval_pending', nextActionCode: 'governance.next.review', ownerActionRequired: true, sourceRefs: [{ type: 'approval', id: 'approval-bdd' }] },
      principleState: { value: 'candidate', sourceRefs: [{ type: 'principle', id: principleId }] },
      process: { stage: 'approval', sourceRefs: [{ type: 'approval', id: 'approval-bdd' }] },
      automation: { state: 'idle', sourceRefs: [] },
      attention: { primary: 'owner_required', items: [{ kind: 'owner_decision', reasonCode: 'approval_pending', sourceRef: { type: 'approval', id: 'approval-bdd' } }] },
      activationSummary: { state: 'none', channels: [], observedChannels: [], sourceRefs: [] },
      timeline: [{ code: 'review_started', occurredAt: '2026-08-20T09:00:00.000Z', recordedAt: '2026-08-20T09:00:00.000Z', summaryCode: 'governance.timeline.review_started', sourceRef: { type: 'task', id: 'task-bdd' }, lineageConfidence: 'strong' }],
      sourceRefs: [{ type: 'approval', id: 'approval-bdd' }, { type: 'principle', id: principleId }],
      dataQuality: { degraded: false, issues: [] },
    } }) });
  });
});

registry.given('该原则的治理投影功能已关闭', async (ctx, page) => {
  const principleId = String(ctx.state.principleId);
  await page.route(`**/api/v1/principles/${encodeURIComponent(principleId)}/governance`, async route => {
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'feature_disabled', message: 'disabled', reason: 'feature_disabled', nextAction: 'Enable the flag.' }) });
  });
});

registry.given('该原则正在自动修订且证据不完整', async (ctx, page) => {
  const principleId = String(ctx.state.principleId);
  await page.route(`**/api/v1/principles/${encodeURIComponent(principleId)}/governance`, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {
      schemaVersion: '1', principleId, asOf: '2026-08-20T10:00:00.000Z',
      summary: { headlineCode: 'governance.headline.revision', reasonCode: 'governance.reason.automatic_revision', nextActionCode: 'governance.next.wait', ownerActionRequired: false, sourceRefs: [{ type: 'task', id: 'task-bdd-degraded' }] },
      principleState: { value: 'candidate', sourceRefs: [{ type: 'principle', id: principleId }] },
      process: { stage: 'revising', currentTaskKind: 'artificer', sourceRefs: [{ type: 'task', id: 'task-bdd-degraded' }] },
      automation: { state: 'retry_scheduled', sourceRefs: [{ type: 'task', id: 'task-bdd-degraded' }] },
      attention: { primary: 'none', items: [] },
      activationSummary: { state: 'none', channels: [], observedChannels: [], sourceRefs: [] },
      timeline: [{ code: 'revision_requested', occurredAt: '2026-08-20T09:00:00.000Z', recordedAt: '2026-08-20T09:00:00.000Z', summaryCode: 'governance.timeline.revision_requested', sourceRef: { type: 'task', id: 'task-bdd-degraded' }, lineageConfidence: 'weak' }],
      sourceRefs: [{ type: 'principle', id: principleId }, { type: 'task', id: 'task-bdd-degraded' }],
      dataQuality: { degraded: true, issues: [{ source: 'lineage', reasonCode: 'lineage_not_available', nextActionCode: 'wait_for_durable_lineage' }] },
    } }) });
  });
});

registry.when('Owner 打开该原则详情页', async (ctx, page) => {
  await page.goto(`/#/principles/${encodeURIComponent(String(ctx.state.principleId))}`);
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/#\/principles\//);
});

registry.then('Owner 能看到治理状态、来源可信度和下一步安全动作', async (ctx, page) => {
  const summary = page.getByTestId('governance-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/decision|决策/i);
  await expect(summary).toContainText(/Source-backed|有来源支撑/i);
  await expect(page.getByTestId('governance-next-action')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

registry.then('默认视图不暴露技术证据标识', async (ctx, page) => {
  await expect(page.locator('body')).not.toContainText(/approval-bdd|task-bdd/);
});

registry.then('Owner 能看到修订状态和证据不确定性', async (ctx, page) => {
  await expect(page.getByTestId('governance-summary')).toContainText(/revis|修订/i);
  await expect(page.getByTestId('governance-data-quality')).toBeVisible();
  await expect(page.getByTestId('governance-summary')).toContainText(/Incomplete evidence|证据不完整/i);
  await expect(page.getByRole('button', { name: /批准原则|Approve principle/i })).toHaveCount(0);
});

registry.then('原有原则内容仍然显示', async (ctx, page) => {
  await expect(page.locator('body')).toContainText(String(ctx.state.principleText));
});

registry.then('治理投影卡片不显示', async (ctx, page) => {
  await expect(page.getByTestId('governance-summary')).toHaveCount(0);
  await expect(page.getByTestId('governance-data-quality')).toHaveCount(0);
});

defineFeature(readFileSync(resolveFeaturePath('docs/specs/features/story-a/principle-governance-projection.feature'), 'utf8'), registry);
