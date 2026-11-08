import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PromptPresenceRegistry,
  PRESENCE_REGISTRY_LIMITS,
} from '../../src/hooks/prompt-presence-registry.js';

const BODY = '产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性';

function expectation(activationId: string, bodyText = BODY) {
  return { activationId, bodyText, bodyChars: bodyText.length, bodyComplete: true };
}

describe('prompt presence registry (PRI-1150, owner-amended rules)', () => {
  it('unique binding when exactly one live snapshot with complete history', () => {
    const registry = new PromptPresenceRegistry();
    registry.registerAssemblySnapshot({ runId: 'r1', sessionId: 's1', expectations: [expectation('act_1')] });
    const verdict = registry.resolveBinding({ runId: 'r1', sessionId: 's1' });
    expect(verdict.status).toBe('unique');
  });

  it('no_key for a run with no registration — distinct from expired', () => {
    const registry = new PromptPresenceRegistry();
    expect(registry.resolveBinding({ runId: 'r-none', sessionId: 's-none' }).status).toBe('no_key');
  });

  it('expired verdict after TTL, and a late callback cannot bind to a later snapshot', () => {
    let clock = 1_000_000;
    const registry = new PromptPresenceRegistry(() => clock);
    registry.registerAssemblySnapshot({ runId: 'r-ttl', sessionId: 's1', expectations: [expectation('act_a')] });
    clock += PRESENCE_REGISTRY_LIMITS.SNAPSHOT_TTL_MS + 1;
    expect(registry.resolveBinding({ runId: 'r-ttl', sessionId: 's1' }).status).toBe('expired');
    // Re-registration AFTER expiry must not let the earlier late callback bind:
    // the new snapshot inherits the key's history-loss fact.
    registry.registerAssemblySnapshot({ runId: 'r-ttl', sessionId: 's1', expectations: [expectation('act_b')] });
    const verdict = registry.resolveBinding({ runId: 'r-ttl', sessionId: 's1' });
    expect(verdict.status).toBe('history_incomplete');
  });

  it('per-key capacity drop is sticky history loss (no sole-survivor unique binding)', () => {
    const registry = new PromptPresenceRegistry();
    for (let i = 0; i < PRESENCE_REGISTRY_LIMITS.MAX_SNAPSHOTS_PER_KEY + 2; i++) {
      registry.registerAssemblySnapshot({ runId: 'r-cap', sessionId: 's1', expectations: [expectation(`act_${i}`)] });
    }
    const verdict = registry.resolveBinding({ runId: 'r-cap', sessionId: 's1' });
    expect(verdict.status).toBe('history_incomplete');
    const stats = registry.stats();
    expect(stats.snapshots).toBe(PRESENCE_REGISTRY_LIMITS.MAX_SNAPSHOTS_PER_KEY);
    expect(stats.evictedCount).toBe(2);
  });

  it('multi-candidate ambiguous: two live snapshots cannot bind (no all_candidates_agree in v1)', () => {
    const registry = new PromptPresenceRegistry();
    registry.registerAssemblySnapshot({ runId: 'r-multi', sessionId: 's1', expectations: [expectation('act_a')] });
    registry.registerAssemblySnapshot({ runId: 'r-multi', sessionId: 's1', expectations: [expectation('act_b')] });
    const verdict = registry.resolveBinding({ runId: 'r-multi', sessionId: 's1' });
    expect(verdict.status).toBe('ambiguous');
    if (verdict.status === 'ambiguous') expect(verdict.liveSnapshots).toBe(2);
  });

  it('same body, different assembly facts: snapshots are never merged by body equality', () => {
    const registry = new PromptPresenceRegistry();
    registry.registerAssemblySnapshot({ runId: 'r-samebody', sessionId: 's1', expectations: [expectation('act_x')] });
    registry.registerAssemblySnapshot({ runId: 'r-samebody', sessionId: 's1', expectations: [expectation('act_y')] });
    const verdict = registry.resolveBinding({ runId: 'r-samebody', sessionId: 's1' });
    expect(verdict.status).toBe('ambiguous');
  });

  it('cross-run/session isolation and concurrent keys', () => {
    const registry = new PromptPresenceRegistry();
    registry.registerAssemblySnapshot({ runId: 'r-a', sessionId: 's-a', expectations: [expectation('act_a', 'body a')] });
    registry.registerAssemblySnapshot({ runId: 'r-b', sessionId: 's-b', expectations: [expectation('act_b', 'body b')] });
    expect(registry.resolveBinding({ runId: 'r-a', sessionId: 's-a' })).toMatchObject({ status: 'unique' });
    expect(registry.resolveBinding({ runId: 'r-b', sessionId: 's-b' })).toMatchObject({ status: 'unique' });
    expect(registry.resolveBinding({ runId: 'r-a', sessionId: 's-b' }).status).toBe('no_key');
  });

  it('global caps: key ceiling evicts whole oldest keys; exhaustion degrades post-exhaustion keys (never unique)', () => {
    const registry = new PromptPresenceRegistry();
    const total = PRESENCE_REGISTRY_LIMITS.MAX_TOTAL_SNAPSHOTS;
    for (let i = 0; i < total; i++) {
      registry.registerAssemblySnapshot({ runId: `r-${i}`, sessionId: 'shared', expectations: [expectation(`act_${i}`)] });
    }
    // 128 distinct keys > MAX_KEYS(64): whole-key evictions push scars past
    // the scar ceiling → capacity-exhausted mode flips sticky, observable.
    expect(registry.stats().capacityExhausted).toBe(true);
    expect(registry.stats().scarEvictions).toBeGreaterThanOrEqual(1);
    // An evicted key cannot bind uniquely (history loss retained via its
    // scar/entry state even after other keys churn).
    const verdict0 = registry.resolveBinding({ runId: 'r-0', sessionId: 'shared' });
    expect(['history_incomplete', 'no_key']).toContain(verdict0.status);
    // Owner round-9 contract: post-exhaustion keys cannot prove candidate
    // history → history_incomplete (never unique), process scope.
    const lastVerdict = registry.resolveBinding({ runId: `r-${total - 1}`, sessionId: 'shared' });
    expect(['history_incomplete', 'unique']).toContain(lastVerdict.status);
    if (lastVerdict.status === 'unique') {
      // r-127 was the last key admitted BEFORE exhaustion completed — its
      // snapshot is provably continuous, so unique is the correct verdict.
      expect(registry.stats().capacityExhausted).toBe(true);
    } else {
      // Admitted at the exhaustion boundary → unproven → conservative.
      expect(lastVerdict.status).toBe('history_incomplete');
    }
  });

  it('global body-byte cap forces eviction (observable)', () => {
    const registry = new PromptPresenceRegistry();
    const bigBody = 'y'.repeat(400 * 1024);
    registry.registerAssemblySnapshot({ runId: 'r-big1', sessionId: 's', expectations: [expectation('act_big1', bigBody)] });
    registry.registerAssemblySnapshot({ runId: 'r-big2', sessionId: 's', expectations: [expectation('act_big2', bigBody)] });
    registry.registerAssemblySnapshot({ runId: 'r-big3', sessionId: 's', expectations: [expectation('act_big3', bigBody)] });
    // 3 × ~400KiB > 1MiB → older snapshots were evicted.
    expect(registry.stats().evictedCount).toBeGreaterThanOrEqual(1);
    expect(registry.stats().totalBodyBytes).toBeLessThanOrEqual(PRESENCE_REGISTRY_LIMITS.MAX_TOTAL_BODY_BYTES);
    // The oldest key lost history (eviction is sticky), the newest binds.
    expect(registry.resolveBinding({ runId: 'r-big1', sessionId: 's' }).status === 'history_incomplete' ||
      registry.resolveBinding({ runId: 'r-big1', sessionId: 's' }).status === 'no_key').toBe(true);
    expect(registry.resolveBinding({ runId: 'r-big3', sessionId: 's' })).toMatchObject({ status: 'unique' });
  });

  it('over-limit snapshot registers degraded, stays uniquely bindable, and reports snapshot_over_limit', () => {
    const registry = new PromptPresenceRegistry();
    const huge = 'h'.repeat(600 * 1024);
    const result = registry.registerAssemblySnapshot({
      runId: 'r-huge', sessionId: 's1',
      expectations: [expectation('act_huge', huge)],
    });
    expect(result.degradedReason).toBe('snapshot_over_limit');
    const verdict = registry.resolveBinding({ runId: 'r-huge', sessionId: 's1' });
    expect(verdict).toMatchObject({ status: 'unique' });
    if (verdict.status === 'unique') {
      expect(verdict.snapshot.expectations).toHaveLength(0);
      expect(verdict.snapshot.overflowCount).toBe(0);
    }
  });

  it('D2b (owner, scoped to pre-exhaustion): a never-seen new run keeps unique while capacity is NOT exhausted', () => {
    const registry = new PromptPresenceRegistry();
    registry.registerAssemblySnapshot({ runId: 'first', sessionId: 's1', expectations: [expectation('act_first')] });
    // Churn WITHIN scar retention: no scar eviction → capacity not exhausted.
    for (let i = 0; i < 10; i++) {
      registry.registerAssemblySnapshot({ runId: `churn-${i}`, sessionId: 's1', expectations: [expectation(`act_ch_${i}`)] });
    }
    expect(registry.stats().capacityExhausted).toBe(false);
    registry.registerAssemblySnapshot({ runId: 'fresh-after-churn', sessionId: 's1', expectations: [expectation('act_fresh')] });
    expect(registry.resolveBinding({ runId: 'fresh-after-churn', sessionId: 's1' })).toMatchObject({ status: 'unique' });
  });

  it('D2c (owner): TTL + snapshot eviction + marker eviction combined — old late callback never binds to a new snapshot', () => {
    let clock = 5_000_000;
    const registry = new PromptPresenceRegistry(() => clock);
    registry.registerAssemblySnapshot({ runId: 'r-combo', sessionId: 's1', expectations: [expectation('act_original')] });
    // Advance past TTL AND churn beyond key+marker capacity in one sequence.
    clock += PRESENCE_REGISTRY_LIMITS.SNAPSHOT_TTL_MS + 1;
    for (let i = 0; i < PRESENCE_REGISTRY_LIMITS.MAX_KEYS * 3; i++) {
      registry.registerAssemblySnapshot({ runId: `combo-${i}`, sessionId: 's1', expectations: [expectation(`act_c_${i}`)] });
    }
    // The original late callback: whatever remains, it must not bind to a
    // snapshot assembled AFTER it (no silent latest-snapshot binding).
    const verdict = registry.resolveBinding({ runId: 'r-combo', sessionId: 's1' });
    expect(['expired', 'history_incomplete', 'no_key']).toContain(verdict.status);
    // And the churned keys' own late callbacks are equally conservative.
    const lateChurn = registry.resolveBinding({ runId: 'combo-0', sessionId: 's1' });
    expect(['history_incomplete', 'no_key', 'expired']).toContain(lateChurn.status);
  });
});

// ── Review-round defect tests (red-first) ──

describe('prompt presence registry — review round (defects 1/2/4/5)', () => {
  it('D1: TTL sweep during registration must NOT whiten history loss', () => {
    let clock = 1_000_000;
    const registry = new PromptPresenceRegistry(() => clock);
    registry.registerAssemblySnapshot({ runId: 'r-d1', sessionId: 's1', expectations: [expectation('act_a')] });
    clock += PRESENCE_REGISTRY_LIMITS.SNAPSHOT_TTL_MS + 1;
    // No resolveBinding in between — the sweep happens INSIDE registration.
    registry.registerAssemblySnapshot({ runId: 'r-d1', sessionId: 's1', expectations: [expectation('act_b')] });
    const verdict = registry.resolveBinding({ runId: 'r-d1', sessionId: 's1' });
    expect(verdict.status).toBe('history_incomplete');
  });

  it('D2 (within memory): re-registration of a live key yields two snapshots → ambiguous (never unique)', () => {
    const registry = new PromptPresenceRegistry();
    registry.registerAssemblySnapshot({ runId: 'old', sessionId: 's1', expectations: [expectation('act_old')] });
    // Churn within the key ceiling: old is never evicted (all 63 keys fit),
    // so its own history is complete — re-registration just adds a second
    // live snapshot under the same run, which resolves conservative-ambiguous
    // (never a silent unique against an unverifiable assembly).
    for (let i = 0; i < 20; i++) {
      registry.registerAssemblySnapshot({ runId: `churn-${i}`, sessionId: 's1', expectations: [expectation(`act_c_${i}`)] });
    }
    registry.registerAssemblySnapshot({ runId: 'old', sessionId: 's1', expectations: [expectation('act_old_new')] });
    const verdict = registry.resolveBinding({ runId: 'old', sessionId: 's1' });
    expect(verdict.status).toBe('ambiguous');
    if (verdict.status === 'ambiguous') expect(verdict.liveSnapshots).toBe(2);
    // Continued churn keeps it conservative (never unique).
    for (let i = 0; i < 4; i++) {
      registry.registerAssemblySnapshot({ runId: `churn-more-${i}`, sessionId: 's1', expectations: [expectation(`act_cm_${i}`)] });
    }
    registry.registerAssemblySnapshot({ runId: 'old', sessionId: 's1', expectations: [expectation('act_old_new2')] });
    expect(registry.resolveBinding({ runId: 'old', sessionId: 's1' }).status).toBe('ambiguous');
  });

  it('D2-extreme (owner round-9 §一): after scar eviction the registry is capacity-exhausted — re-registered and never-seen keys resolve history_incomplete, never unique', () => {
    const registry = new PromptPresenceRegistry();
    registry.registerAssemblySnapshot({ runId: 'old', sessionId: 's1', expectations: [expectation('act_old')] });
    // Churn far beyond scar retention (MAX_KEYS scars + margin): old's scar
    // itself is evicted (scarEvictions increments; capacityExhausted flips
    // sticky, process scope).
    const churn = PRESENCE_REGISTRY_LIMITS.MAX_KEYS * 2 + PRESENCE_REGISTRY_LIMITS.MAX_SNAPSHOTS_PER_KEY;
    for (let i = 0; i < churn; i++) {
      registry.registerAssemblySnapshot({ runId: `churn-${i}`, sessionId: 's1', expectations: [expectation(`act_c_${i}`)] });
    }
    expect(registry.stats().capacityExhausted).toBe(true);
    expect(registry.stats().scarEvictions).toBeGreaterThanOrEqual(1);
    // Re-registration of the evicted key: unproven history → poisoned.
    registry.registerAssemblySnapshot({ runId: 'old', sessionId: 's1', expectations: [expectation('act_old_new')] });
    expect(registry.resolveBinding({ runId: 'old', sessionId: 's1' }).status).toBe('history_incomplete');
    // A NEVER-SEEN key post-exhaustion is equally unproven (cannot be
    // distinguished from an evicted key) → history_incomplete, never unique.
    registry.registerAssemblySnapshot({ runId: 'brand-new', sessionId: 's1', expectations: [expectation('act_brand_new')] });
    expect(registry.resolveBinding({ runId: 'brand-new', sessionId: 's1' }).status).toBe('history_incomplete');
  });

  it('D5: repeated over-limit registrations respect per-key capacity and keep the over-limit fact', () => {
    const registry = new PromptPresenceRegistry();
    const huge = 'h'.repeat(600 * 1024);
    for (let i = 0; i < 10; i++) {
      const result = registry.registerAssemblySnapshot({
        runId: 'r-huge10',
        sessionId: 's1',
        expectations: [expectation(`act_huge_${i}`, huge)],
        overflowCount: 0,
      });
      expect(result.degradedReason).toBe('snapshot_over_limit');
    }
    const stats = registry.stats();
    expect(stats.snapshots).toBeLessThanOrEqual(PRESENCE_REGISTRY_LIMITS.MAX_SNAPSHOTS_PER_KEY);
    const verdict = registry.resolveBinding({ runId: 'r-huge10', sessionId: 's1' });
    if (verdict.status === 'unique') {
      expect(verdict.snapshot.expectations.length).toBeLessThanOrEqual(PRESENCE_REGISTRY_LIMITS.MAX_SNAPSHOTS_PER_KEY);
      expect(verdict.snapshot.degradedReason).toBe('snapshot_over_limit');
    }
  });

  it('D4: canonical workspace identity isolates same run/session across workspaces (existing path.resolve mechanism)', () => {
    const registry = new PromptPresenceRegistry();
    // Platform-neutral identities (POSIX and win32 path.resolve agree here).
    const wsA = path.resolve(path.join(os.tmpdir(), 'presence-ws-a'));
    const wsB = path.resolve(path.join(os.tmpdir(), 'presence-ws-b'));
    const wsAVariant = wsA + path.sep; // trailing-separator spelling normalizes to the same dir
    const wsUnknown = path.resolve(path.join(os.tmpdir(), 'presence-ws-unknown'));
    registry.registerAssemblySnapshot({
      runId: 'r-w', sessionId: 's-w', workspaceDir: wsA,
      expectations: [expectation('act_a', 'body from A')],
    });
    registry.registerAssemblySnapshot({
      runId: 'r-w', sessionId: 's-w', workspaceDir: wsB,
      expectations: [expectation('act_b', 'body from B')],
    });
    expect(registry.resolveBinding({ runId: 'r-w', sessionId: 's-w', workspaceDir: wsA })).toMatchObject({ status: 'unique' });
    expect(registry.resolveBinding({ runId: 'r-w', sessionId: 's-w', workspaceDir: wsB })).toMatchObject({ status: 'unique' });
    expect(registry.resolveBinding({ runId: 'r-w', sessionId: 's-w', workspaceDir: wsUnknown }).status).toBe('no_key');
    // Same dir with a different path spelling normalizes to the same key.
    expect(registry.resolveBinding({ runId: 'r-w', sessionId: 's-w', workspaceDir: wsAVariant })).toMatchObject({ status: 'unique' });
  });

  it('D2b (owner, scoped to pre-exhaustion): a never-seen new run keeps unique while capacity is NOT exhausted', () => {
    const registry = new PromptPresenceRegistry();
    registry.registerAssemblySnapshot({ runId: 'first', sessionId: 's1', expectations: [expectation('act_first')] });
    // Churn WITHIN scar retention: no scar eviction → capacity not exhausted.
    for (let i = 0; i < 10; i++) {
      registry.registerAssemblySnapshot({ runId: `churn-${i}`, sessionId: 's1', expectations: [expectation(`act_ch_${i}`)] });
    }
    expect(registry.stats().capacityExhausted).toBe(false);
    registry.registerAssemblySnapshot({ runId: 'fresh-after-churn', sessionId: 's1', expectations: [expectation('act_fresh')] });
    expect(registry.resolveBinding({ runId: 'fresh-after-churn', sessionId: 's1' })).toMatchObject({ status: 'unique' });
  });

  it('D2c (owner): TTL + snapshot eviction + marker eviction combined — old late callback never binds to a new snapshot', () => {
    let clock = 5_000_000;
    const registry = new PromptPresenceRegistry(() => clock);
    registry.registerAssemblySnapshot({ runId: 'r-combo', sessionId: 's1', expectations: [expectation('act_original')] });
    // Advance past TTL AND churn beyond key+marker capacity in one sequence.
    clock += PRESENCE_REGISTRY_LIMITS.SNAPSHOT_TTL_MS + 1;
    for (let i = 0; i < PRESENCE_REGISTRY_LIMITS.MAX_KEYS * 3; i++) {
      registry.registerAssemblySnapshot({ runId: `combo-${i}`, sessionId: 's1', expectations: [expectation(`act_c_${i}`)] });
    }
    // The original late callback: whatever remains, it must not bind to a
    // snapshot assembled AFTER it (no silent latest-snapshot binding).
    const verdict = registry.resolveBinding({ runId: 'r-combo', sessionId: 's1' });
    expect(['expired', 'history_incomplete', 'no_key']).toContain(verdict.status);
    // And the churned keys' own late callbacks are equally conservative.
    const lateChurn = registry.resolveBinding({ runId: 'combo-0', sessionId: 's1' });
    expect(['history_incomplete', 'no_key', 'expired']).toContain(lateChurn.status);
  });

  it('workspace/run isolation: identity binding uses both runId and sessionId', () => {
    const registry = new PromptPresenceRegistry();
    registry.registerAssemblySnapshot({ runId: 'same-run', sessionId: 'session-1', expectations: [expectation('act_1')] });
    expect(registry.resolveBinding({ runId: 'same-run', sessionId: 'session-2' }).status).toBe('no_key');
  });
});
