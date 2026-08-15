/**
 * BDD steps for companion notification dedup + update-notify-once (PRI-526).
 * Exercises the pure poller decision logic — no Electron, no HTTP.
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { diffPendingApprovals, parseApprovalsResponse, parseUpdateCheckResponse, shouldNotifyUpdate } from '../../src/lib/poller.js';
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';

const registry = createStepRegistry();

interface Fixture {
  knownIds: Set<string>;
  hasBaseline: boolean;
  notifiedVersions: string[];
  diff: { baselineIds?: string[]; notifyIds: string[] } | undefined;
  snapshot: ReturnType<typeof parseApprovalsResponse>;
  updateInfo: ReturnType<typeof parseUpdateCheckResponse>;
  shouldNotify: boolean | undefined;
}

function fixture(ctx: { state: Record<string, unknown> }): Fixture {
  return ctx.state.fixture as Fixture;
}

registry.given('companion 的持久化去重状态 notifiedApprovalIds', (ctx) => {
  ctx.state.fixture = {
    knownIds: new Set<string>(),
    hasBaseline: false,
    notifiedVersions: [],
    diff: undefined,
    snapshot: undefined,
    updateInfo: undefined,
    shouldNotify: undefined,
  } satisfies Fixture;
});

registry.given(/已通知过的版本列表为 \[(.*)\]/, (ctx, listText) => {
  fixture(ctx).notifiedVersions = listText.trim().length === 0
    ? []
    : listText.split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
});

registry.when('已知基线尚未记录', (ctx) => {
  const f = fixture(ctx);
  f.hasBaseline = false;
});

registry.when(/已知基线已记录且已知审批为 \[(.*)\]/, (ctx, listText) => {
  const f = fixture(ctx);
  f.hasBaseline = true;
  const ids = listText.trim().length === 0 ? [] : listText.split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
  f.knownIds = new Set(ids);
});

registry.when(/当前快照包含审批 "(.+)" 与 "(.+)"/, (ctx, first, second) => {
  const f = fixture(ctx);
  f.diff = diffPendingApprovals({ hasBaseline: f.hasBaseline, knownIds: f.knownIds, snapshotIds: [String(first), String(second)] });
});

registry.when(/当前快照仍包含审批 "(.+)"/, (ctx, id) => {
  const f = fixture(ctx);
  f.diff = diffPendingApprovals({ hasBaseline: f.hasBaseline, knownIds: f.knownIds, snapshotIds: [String(id)] });
});

registry.when('审批接口返回 success 为 false 的响应', (ctx) => {
  fixture(ctx).snapshot = parseApprovalsResponse({ success: false, data: { items: [] } });
});

registry.when(/更新检查返回 hasUpdate=(true|false) 且 latestVersion 为 "(.+)"/, (ctx, hasUpdate, version) => {
  const f = fixture(ctx);
  f.updateInfo = parseUpdateCheckResponse({ success: true, data: { hasUpdate: hasUpdate === 'true', latestVersion: String(version) } });
  f.shouldNotify = shouldNotifyUpdate(f.notifiedVersions, f.updateInfo ?? { hasUpdate: false });
});

registry.then('通知列表为空', (ctx) => {
  expect(fixture(ctx).diff?.notifyIds).toEqual([]);
});

registry.then(/基线记录为 \[(.+)\]/, (ctx, listText) => {
  const expected = listText.split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
  expect(fixture(ctx).diff?.baselineIds).toEqual(expected);
});

registry.then(/通知列表为 \[(.+)\]/, (ctx, listText) => {
  const expected = listText.split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
  expect(fixture(ctx).diff?.notifyIds).toEqual(expected);
});

registry.then('快照解析结果为 undefined', (ctx) => {
  expect(fixture(ctx).snapshot).toBeUndefined();
});

registry.then('应通知', (ctx) => {
  expect(fixture(ctx).shouldNotify).toBe(true);
});

registry.then('不应通知', (ctx) => {
  expect(fixture(ctx).shouldNotify).toBe(false);
});

// ── Load and register feature ──────────────────────────────────────────────────

const featureText = readFileSync(
  resolveFeaturePath('docs/specs/features/companion/notification-dedup.feature'),
  'utf8',
);
defineFeature(featureText, registry);
