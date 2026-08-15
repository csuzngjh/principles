/**
 * BDD steps for companion degraded paths (rc-9 — every failure carries
 * reason + next action). Exercises the pure copy/mapping layer.
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeDegraded, buildDegradedPageHtml } from '../../src/lib/degraded.js';
import { mapLaunchFailureReason, type DegradedReasonKey } from '../../src/lib/supervisor.js';
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';

const registry = createStepRegistry();

interface Fixture {
  reason: DegradedReasonKey;
  detail: string | undefined;
  cliNextAction: string | undefined;
  mapped: DegradedReasonKey | undefined;
  page: string | undefined;
}

function fixture(ctx: { state: Record<string, unknown> }): Fixture {
  return ctx.state.fixture as Fixture;
}

registry.given('companion 的降级文案映射', (ctx) => {
  ctx.state.fixture = { reason: 'launch_failed', detail: undefined, cliNextAction: undefined, mapped: undefined, page: undefined } satisfies Fixture;
});

registry.when(/查询降级原因 "(.+)" 的文案/, (ctx, reasonText) => {
  fixture(ctx).reason = reasonText as DegradedReasonKey;
});

registry.when(/查询降级原因 "(.+)" 的文案且 detail 为 "(.+)"/, (ctx, reasonText, detail) => {
  const f = fixture(ctx);
  f.reason = reasonText as DegradedReasonKey;
  f.detail = String(detail);
});

registry.when('pd-cli 提供的 nextAction 为 "重新运行安装器"', (ctx) => {
  fixture(ctx).cliNextAction = '重新运行安装器';
});

registry.when(/映射 pd-cli 原因 "(.+)"/, (ctx, reasonText) => {
  fixture(ctx).mapped = mapLaunchFailureReason(String(reasonText));
});

registry.when(/用 detail "(.+)" 构建降级页面/, (ctx, detail) => {
  const f = fixture(ctx);
  f.detail = String(detail);
  f.page = buildDegradedPageHtml(describeDegraded(f.reason, f.detail, f.cliNextAction));
});

registry.then('文案包含非空 title 与非空 nextAction', (ctx) => {
  const f = fixture(ctx);
  const info = describeDegraded(f.reason, f.detail, f.cliNextAction);
  expect(info.title.length).toBeGreaterThan(0);
  expect(info.nextAction.length).toBeGreaterThan(0);
  expect(info.description.length).toBeGreaterThan(0);
});

registry.then('文案的 nextAction 为 "重新运行安装器"', (ctx) => {
  const f = fixture(ctx);
  const info = describeDegraded(f.reason, f.detail, f.cliNextAction);
  expect(info.nextAction).toBe('重新运行安装器');
});

registry.then(/降级原因为 (\S+)/, (ctx, expected) => {
  expect(fixture(ctx).mapped).toBe(String(expected));
});

registry.then('页面不包含原始的 "<img src=x"', (ctx) => {
  expect(fixture(ctx).page).toBeDefined();
  expect(fixture(ctx).page).not.toContain('<img src=x');
});

registry.then('页面包含转义后的 "&lt;img src=x"', (ctx) => {
  expect(fixture(ctx).page).toContain('&lt;img src=x');
});

// ── Load and register feature ──────────────────────────────────────────────────

const featureText = readFileSync(
  resolveFeaturePath('docs/specs/features/companion/degraded-paths.feature'),
  'utf8',
);
defineFeature(featureText, registry);
