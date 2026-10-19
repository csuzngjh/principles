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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  judgeReleaseWatch,
  readActiveRelease,
  type ActiveReleaseRead,
  type ReleaseIdentity,
  type ReleaseWatchDecision,
} from '../../src/lib/release-watch.js';
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';

const registry = createStepRegistry();

/**
 * Release labels used in the feature. `releaseId` is an opaque sha256 digest
 * over the release identity inputs (`release-identity.ts` in the installer), so
 * the fixture uses fixed 64-hex digests and never derives one from a version
 * string — a watchdog that read parts of it would break on the first digest
 * change. Two labels can share a product version while still being different
 * releases, which is precisely the case the old component-version comparison
 * was blind to.
 */
const RELEASES: Record<'A' | 'B', { releaseId: string; productVersion: string }> = {
  A: { releaseId: 'a'.repeat(64), productVersion: '2.3.7' },
  B: { releaseId: 'b'.repeat(64), productVersion: '2.3.8' },
};

function release(label: 'A' | 'B', generation: number, productVersionOverride?: string): ReleaseIdentity {
  const { releaseId } = RELEASES[label];
  return { releaseId, generation, productVersion: productVersionOverride ?? RELEASES[label].productVersion };
}

const recordShape = {
  schemaVersion: 1,
  generation: 47,
  releaseId: RELEASES.A.releaseId,
  productVersion: RELEASES.A.productVersion,
};

/**
 * Produce an authority read failure the way production does: write a REAL
 * `active.json` (or leave it missing) and run it through `readActiveRelease`.
 * A scenario that merely stated a reason string would keep passing even if the
 * reader stopped producing it, so unknown reasons are refused here rather than
 * faked (rc-9).
 */
function readAuthorityFailure(reason: string): ActiveReleaseRead {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-release-watch-bdd-'));
  const file = path.join(dir, 'active.json');
  const write = (content: string): ActiveReleaseRead => {
    fs.writeFileSync(file, content, 'utf8');
    return readActiveRelease(file, fs);
  };
  switch (reason) {
    case 'active_record_absent':
      return readActiveRelease(file, fs);
    case 'active_record_json_invalid':
      return write('{"schemaVersion":1,"gener');
    case 'active_record_not_object':
      return write('[]');
    case 'active_record_schema_version_unsupported':
      return write(JSON.stringify({ ...recordShape, schemaVersion: 2 }));
    default:
      throw new Error(`场景声明的失败原因没有对应的真实记录可读: ${reason}`);
  }
}

interface Fixture {
  read: ActiveReleaseRead;
  started: ReleaseIdentity | undefined;
  mode: 'managed' | 'attached';
  /** The identity `read` currently holds, kept so a step can assert the target. */
  authority: ReleaseIdentity | undefined;
  /**
   * The plugin's component version before/after, when a scenario bothers to
   * state it. `judgeReleaseWatch` never receives it — a scenario that changes
   * only this and still gets `no_change` is the proof that the retired axis lost
   * its say (PRI-1016 acceptance 1, reverse direction).
   */
  marker: { from: string; to: string } | undefined;
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
    marker: undefined,
    decision: { action: 'no_change' },
  } satisfies Fixture;
});

// ── When: 两发布身份 + 归属，或权威读取失败 ─────────────────────────────────────

const RELEASE_TOKEN = String.raw`([AB]) 第 (\d+) 代`;

registry.when(
  new RegExp(
    String.raw`^运行中的发布是 ${RELEASE_TOKEN},安装权威是 ${RELEASE_TOKEN}` +
      String.raw`(?:,产品版本号两边都是 (\d+\.\d+\.\d+))?` +
      String.raw`(?:,插件组件号从 (\d+\.\d+\.\d+) 变成 (\d+\.\d+\.\d+))?` +
      String.raw`,实例(?:由|是) ?(Companion 托管|附着的外部控制台)$`,
  ),
  (ctx, startedLabel, startedGen, authorityLabel, authorityGen, versionOverride, markerFrom, markerTo, ownerText) => {
    const f = fixture(ctx);
    const override = versionOverride === '' ? undefined : String(versionOverride);
    f.started = release(startedLabel as 'A' | 'B', Number(startedGen), override);
    f.authority = release(authorityLabel as 'A' | 'B', Number(authorityGen), override);
    f.read = { ok: true, identity: f.authority };
    f.marker = markerFrom === '' || markerTo === ''
      ? undefined
      : { from: String(markerFrom), to: String(markerTo) };
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
    f.read = readAuthorityFailure(String(reason));
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
  expect(f.decision.to.releaseId).toBe(RELEASES[label as 'A' | 'B'].releaseId);
});

registry.then('看门狗判定为只报告不动手', (ctx) => {
  expect(fixture(ctx).decision.action).toBe('attached_no_action');
});

registry.then('看门狗判定为无变化', (ctx) => {
  expect(fixture(ctx).decision.action).toBe('no_change');
});

// The scenario's premise, asserted rather than assumed: the retired predicate
// compared this field, so a case where it moves and the release identity does
// not is exactly where the old axis fired for no reason (ERR-148, reverse).
registry.then('组件号这一轴确实动了,旧判据在这里会交接', (ctx) => {
  const { marker } = fixture(ctx);
  if (marker === undefined) throw new Error('场景没有给出插件组件号的前后值');
  expect(marker.from !== marker.to).toBe(true);
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

const featureText = fs.readFileSync(
  resolveFeaturePath('docs/specs/features/companion/release-watch.feature'),
  'utf8',
);
defineFeature(featureText, registry);
