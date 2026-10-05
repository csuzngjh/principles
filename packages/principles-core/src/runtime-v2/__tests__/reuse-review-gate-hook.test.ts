/**
 * PRI-917 v0.3.3 (OD-PRI917-05) — Reuse Review Gate recommendation-hook
 * builder: config plumbing decision table.
 *
 * The hook is the ONLY new moving part on the automatic intake path, so its
 * configuration contract is pinned here:
 * - disabled / absent effective config → NO hook (intake behaves exactly as
 *   before v0.3.3 — the T11 rollback switch);
 * - profile resolution failures, non-pi-ai profiles and unready environments
 *   all degrade to `{ status: 'unavailable' }` — never throw, never block
 *   learning (Rule 4);
 * - the happy path (a real LLM roundtrip) is covered by the R6 Reality
 *   Replay on a live workspace and the existing review-surface runner tests.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import type { LedgerAdapter } from '../candidate-intake.js';
import {
  createReuseRecommendationHook,
  createPainSignalBridge,
  disposePainSignalBridgesForWorkspace,
  invalidatePainSignalBridge,
  mapBridgeTelemetryToStoreEvent,
} from '../pain-signal-runtime-factory.js';

describe('PRI-917 v0.3.3 — reuse_gate_triggered telemetry passthrough', () => {
  it('the park observation passes through the store-emitter mapper verbatim', () => {
    const mapped = mapBridgeTelemetryToStoreEvent({
      eventType: 'reuse_gate_triggered',
      traceId: 'cand-1',
      timestamp: '2026-09-30T16:00:00.000Z',
      payload: { candidateId: 'cand-1', selectedPrincipleId: 'p-1', confidence: 0.93, recommendation: 'reuse' },
    });
    expect(mapped).not.toBeNull();
    expect(mapped?.eventType).toBe('reuse_gate_triggered');
    expect(mapped?.payload).toMatchObject({ candidateId: 'cand-1', selectedPrincipleId: 'p-1' });
  });

  it('non-allowlisted bridge events stay dropped (existing degradation-only contract)', () => {
    expect(
      mapBridgeTelemetryToStoreEvent({
        eventType: 'not_a_real_bridge_event',
        traceId: 'x',
        timestamp: '2026-09-30T16:00:00.000Z',
        payload: {},
      }),
    ).toBeNull();
  });
});

function workspace(): { dir: string; stateDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pri917-r6-hook-'));
  return { dir, stateDir: join(dir, '.state'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function configWith(overrides: {
  enabled?: boolean;
  runtimeProfile?: string;
  profileId?: string;
  profile?: Record<string, unknown>;
  defaultRuntime?: string;
}): EffectivePdConfig {
  const profileId = overrides.profileId ?? 'eval-profile';
  return {
    config: {
      reuseEvaluation: {
        enabled: overrides.enabled ?? true,
        ...(overrides.runtimeProfile !== undefined ? { runtimeProfile: overrides.runtimeProfile } : {}),
      },
      internalAgents: {
        defaultRuntime: overrides.defaultRuntime ?? profileId,
        agents: {},
      },
      runtimeProfiles: {
        [profileId]: overrides.profile ?? {
          type: 'pi-ai',
          provider: 'openrouter',
          model: 'test/eval-model',
          apiKeyEnv: 'PRI917_R6_TEST_KEY',
        },
      },
    },
  } as unknown as EffectivePdConfig;
}

const CLAIM = { text: '跨会话同步以源文件 mtime 为权威基准', triggerPattern: '', action: '' };
const PROPOSAL = {
  candidateId: randomUUID(),
  status: 'pending' as const,
  candidates: [{ principleId: randomUUID(), score: 0.4, reasons: ['shares terms'] }],
  eligibleCount: 1,
};

describe('PRI-917 v0.3.3 — createReuseRecommendationHook config decision table', () => {
  it('returns undefined when reuseEvaluation.enabled=false (T11 rollback switch)', () => {
    const ws = workspace();
    try {
      const hook = createReuseRecommendationHook({
        effectiveConfig: configWith({ enabled: false }),
        workspaceDir: ws.dir,
        stateDir: ws.stateDir,
      });
      expect(hook).toBeUndefined();
    } finally {
      ws.cleanup();
    }
  });

  it('returns undefined when no effective config was supplied', () => {
    const ws = workspace();
    try {
      expect(
        createReuseRecommendationHook({ workspaceDir: ws.dir, stateDir: ws.stateDir }),
      ).toBeUndefined();
    } finally {
      ws.cleanup();
    }
  });

  it('a missing runtime profile degrades to unavailable (never throws)', async () => {
    const ws = workspace();
    try {
      const hook = createReuseRecommendationHook({
        effectiveConfig: configWith({ runtimeProfile: 'no-such-profile' }),
        workspaceDir: ws.dir,
        stateDir: ws.stateDir,
      });
      expect(hook).toBeDefined();
      if (!hook) throw new Error('expected the hook to be created');
      const outcome = await hook(CLAIM, PROPOSAL);
      expect(outcome.status).toBe('unavailable');
      if (outcome.status === 'unavailable') {
        expect(outcome.reason).toContain('no-such-profile');
      }
    } finally {
      ws.cleanup();
    }
  });

  it('a non-pi-ai profile degrades to unavailable', async () => {
    const ws = workspace();
    try {
      const hook = createReuseRecommendationHook({
        effectiveConfig: configWith({
          profileId: 'oc-profile',
          profile: { type: 'openclaw', source: 'default' },
        }),
        workspaceDir: ws.dir,
        stateDir: ws.stateDir,
      });
      if (!hook) throw new Error('expected the hook to be created');
      const outcome = await hook(CLAIM, PROPOSAL);
      expect(outcome.status).toBe('unavailable');
      if (outcome.status === 'unavailable') {
        expect(outcome.reason).toContain('pi-ai');
      }
    } finally {
      ws.cleanup();
    }
  });

  it('an unready environment (missing API key env) degrades to unavailable', async () => {
    const ws = workspace();
    try {
      const hook = createReuseRecommendationHook({
        effectiveConfig: configWith({}),
        workspaceDir: ws.dir,
        stateDir: ws.stateDir,
        getEnvVar: () => undefined,
      });
      if (!hook) throw new Error('expected the hook to be created');
      const outcome = await hook(CLAIM, PROPOSAL);
      expect(outcome.status).toBe('unavailable');
    } finally {
      ws.cleanup();
    }
  });

  it('falls back to internalAgents.defaultRuntime when runtimeProfile is unset', async () => {
    const ws = workspace();
    try {
      const hook = createReuseRecommendationHook({
        effectiveConfig: configWith({ profileId: 'fallback-profile', defaultRuntime: 'fallback-profile' }),
        workspaceDir: ws.dir,
        stateDir: ws.stateDir,
        getEnvVar: () => undefined,
      });
      // Readiness fails on the missing env key, proving the FALLBACK profile
      // (not some other) was consulted: the unavailable reason names its env.
      if (!hook) throw new Error('expected the hook to be created');
      const outcome = await hook(CLAIM, PROPOSAL);
      expect(outcome.status).toBe('unavailable');
      if (outcome.status === 'unavailable') {
        expect(outcome.reason).toContain('PRI917_R6_TEST_KEY');
      }
    } finally {
      ws.cleanup();
    }
  });
});

// ── PRI-917 v0.3.3 review fix (P2-1) — bridge cache key vs the gate switch ───

/**
 * Full config for REAL bridge construction on a temp workspace: the
 * diagnostician capability must be enabled (resolveDiagnosticianCapability)
 * AND its runtime profile must be ready (resolveRuntimeConfigFromPdConfig),
 * otherwise createPainSignalBridge never reaches constructBridge.
 */
function bridgeConfig(reuseEnabled: boolean): EffectivePdConfig {
  return {
    config: {
      features: {},
      reuseEvaluation: { enabled: reuseEnabled, runtimeProfile: 'eval-profile' },
      internalAgents: {
        defaultRuntime: 'diag-profile',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'diag-profile' },
        },
      },
      runtimeProfiles: {
        'diag-profile': { type: 'pi-ai', provider: 'openrouter', model: 'test/diag-model', apiKeyEnv: 'PRI917_R6_TEST_KEY' },
        'eval-profile': { type: 'pi-ai', provider: 'openrouter', model: 'test/eval-model', apiKeyEnv: 'PRI917_R6_TEST_KEY' },
      },
    },
  } as unknown as EffectivePdConfig;
}

function stubLedgerAdapter(): LedgerAdapter {
  return {} as unknown as LedgerAdapter;
}

describe('PRI-917 v0.3.3 review fix (P2-1) — bridge cache key respects the reuse-gate switch', () => {
  it('a re-read config that toggles reuseEvaluation.enabled yields a FRESH bridge in BOTH directions', async () => {
    const ws = workspace();
    try {
      invalidatePainSignalBridge(ws.dir);
      const bridgeOpts = (effectiveConfig: EffectivePdConfig) => ({
        workspaceDir: ws.dir,
        stateDir: ws.stateDir,
        ledgerAdapter: stubLedgerAdapter(),
        effectiveConfig,
        getEnvVar: () => 'test-key',
      });

      // Gate on. A host re-reads config per pain event — the same content in a
      // FRESH config object must stay a cache hit (no bridge churn).
      const onA = await createPainSignalBridge(bridgeOpts(bridgeConfig(true)));
      const onB = await createPainSignalBridge(bridgeOpts(bridgeConfig(true)));
      expect(onB).toBe(onA);

      // Owner DISABLES the gate: a cached bridge whose hook captured the old
      // config would keep evaluating (T11 rollback would need a restart).
      const off = await createPainSignalBridge(bridgeOpts(bridgeConfig(false)));
      expect(off).not.toBe(onA);
      const offB = await createPainSignalBridge(bridgeOpts(bridgeConfig(false)));
      expect(offB).toBe(off);

      // Re-enabling must not resurrect the disabled bridge either — it returns
      // to the original gate-on cache entry (both entries coexist).
      const onC = await createPainSignalBridge(bridgeOpts(bridgeConfig(true)));
      expect(onC).not.toBe(off);
      expect(onC).toBe(onA);
    } finally {
      await disposePainSignalBridgesForWorkspace(ws.dir);
      ws.cleanup();
    }
  });

  it('invalidatePainSignalBridge clears the new cache-key component too', async () => {
    const ws = workspace();
    try {
      const bridgeOpts = {
        workspaceDir: ws.dir,
        stateDir: ws.stateDir,
        ledgerAdapter: stubLedgerAdapter(),
        effectiveConfig: bridgeConfig(true),
        getEnvVar: () => 'test-key',
      };
      const first = await createPainSignalBridge(bridgeOpts);
      invalidatePainSignalBridge(ws.dir);
      const second = await createPainSignalBridge(bridgeOpts);
      expect(second).not.toBe(first);
    } finally {
      await disposePainSignalBridgesForWorkspace(ws.dir);
      ws.cleanup();
    }
  });
});
