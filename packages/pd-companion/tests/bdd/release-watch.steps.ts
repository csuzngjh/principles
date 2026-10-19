/**
 * BDD steps for the Companion release watch (PRI-1016).
 *
 * Drives the pure `judgeReleaseWatch` decision with a release-identity fixture —
 * no Electron, no child processes, no real `~/.pd`. The point these scenarios
 * lock is the *trigger source*: hand-over is decided by the installation
 * authority's release identity, so a release that changes no component version
 * still gets handed over, and an unreadable authority never silently falls back
 * to the component marker.
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  judgeReleaseWatch,
  type ActiveReleaseRead,
  type ReleaseIdentity,
  type ReleaseWatchDecision,
} from '../../src/lib/release-watch.js';
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';

const registry = createStepRegistry();

/**
 * Release labels used in the feature. A release identity is
 * `productVersion + sourceCommit` (the real formula), so two labels can share a
 * product version while still being different releases — which is precisely the
 * case the old component-version comparison was blind to.
 */
const RELEASES: Record<'A' | 'B', { productVersion: string; sourceCommit: string }> = {
  A: { productVersion: '2.3.7', sourceCommit: 'a'.repeat(40) },
  B: { productVersion: '2.3.8', sourceCommit: 'b'.repeat(40) },
};

function release(label: 'A' | 'B', generation: number, productVersionOverride?: string): ReleaseIdentity {
  const { sourceCommit } = RELEASES[label];
  const productVersion = productVersionOverride ?? RELEASES[label].productVersion;
  return { releaseId: `${productVersion}+${sourceCommit}`, generation, productVersion };
}

interface Fixture {
  read: ActiveReleaseRead;
  started: ReleaseIdentity | undefined;
  mode: 'managed' | 'attached';
  /** The identity `read` currently holds, kept so a step can assert the target. */
  authority: ReleaseIdentity | undefined;
  decision: ReleaseWatchDecision;
}

function fixture(ctx: { state: Record<string, unknown> }): Fixture {
  return ctx.state.fixture as Fixture;
}

function decide(f: Fixture): void {
  f.decision = judgeReleaseWatch({ read: f.read, started: f.started, mode: f.mode });
}

registry.given('一个已启动的 Companion 看门狗夹具', (ctx) => {
  ctx.state.fixture = {
    read: { ok: false, reason: 'not_configured' },
    started: undefined,
    mode: 'managed',
    authority: undefined,
    decision: { action: 'no_change' },
  } satisfies Fixture;
});

// ── When: 两发布身份 + 归属，或权威读取失败 ─────────────────────────────────────

const RELEASE_TOKEN = String.raw`([AB]) 第 (\d+) 代`;

registry.when(
  new RegExp(
    String.raw`^运行中的发布是 ${RELEASE_TOKEN},安装权威是 ${RELEASE_TOKEN}` +
      String.raw`(?:,产品版本号两边都是 (\d+\.\d+\.\d+))?` +
      String.raw`,实例(?:由|是) ?(Companion 托管|附着的外部控制台)$`,
  ),
  (ctx, startedLabel, startedGen, authorityLabel, authorityGen, versionOverride, ownerText) => {
    const f = fixture(ctx);
    const override = versionOverride === '' ? undefined : String(versionOverride);
    f.started = release(startedLabel as 'A' | 'B', Number(startedGen), override);
    f.authority = release(authorityLabel as 'A' | 'B', Number(authorityGen), override);
    f.read = { ok: true, identity: f.authority };
    f.mode = String(ownerText).trim() === 'Companion 托管' ? 'managed' : 'attached';
    decide(f);
  },
);

registry.when(
  new RegExp(String.raw`^运行中的发布是 ${RELEASE_TOKEN},安装权威读取失败 reason 是 ([a-z_]+),实例由 Companion 托管$`),
  (ctx, startedLabel, startedGen, reason) => {
    const f = fixture(ctx);
    f.started = release(startedLabel as 'A' | 'B', Number(startedGen));
    f.authority = undefined;
    f.read = { ok: false, reason: String(reason) };
    f.mode = 'managed';
    decide(f);
  },
);

registry.when(
  new RegExp(String.raw`^运行中的发布未知,安装权威是 ${RELEASE_TOKEN},实例由 Companion 托管$`),
  (ctx, authorityLabel, authorityGen) => {
    const f = fixture(ctx);
    f.started = undefined;
    f.authority = release(authorityLabel as 'A' | 'B', Number(authorityGen));
    f.read = { ok: true, identity: f.authority };
    f.mode = 'managed';
    decide(f);
  },
);

// ── Then ──────────────────────────────────────────────────────────────────────

registry.then('看门狗判定为交接', (ctx) => {
  expect(fixture(ctx).decision.action).toBe('restart');
});

registry.then(/^交接目标是发布 ([AB])$/, (ctx, label) => {
  const f = fixture(ctx);
  if (f.decision.action !== 'restart') {
    throw new Error(`期望交接，实际判定为 ${f.decision.action}`);
  }
  // The target must be the authority's own identity, not any component marker.
  expect(f.decision.to).toBe(f.authority);
  expect(f.decision.to.releaseId).toContain(RELEASES[label as 'A' | 'B'].sourceCommit);
});

registry.then('看门狗判定为只报告不动手', (ctx) => {
  expect(fixture(ctx).decision.action).toBe('attached_no_action');
});

registry.then('看门狗判定为不交接', (ctx) => {
  const action = fixture(ctx).decision.action;
  expect(['authority_unavailable', 'no_baseline']).toContain(action);
});

registry.then(/^不交接的原因就是 ([a-z_]+)$/, (ctx, reason) => {
  const { decision } = fixture(ctx);
  if (decision.action !== 'authority_unavailable' && decision.action !== 'no_baseline') {
    throw new Error(`期望不交接，实际判定为 ${decision.action}`);
  }
  const actual = decision.action === 'authority_unavailable' ? decision.reason : 'no_baseline';
  expect(actual.startsWith(String(reason))).toBe(true);
});

// ── Load and register feature ──────────────────────────────────────────────────

const featureText = readFileSync(
  resolveFeaturePath('docs/specs/features/companion/release-watch.feature'),
  'utf8',
);
defineFeature(featureText, registry);
