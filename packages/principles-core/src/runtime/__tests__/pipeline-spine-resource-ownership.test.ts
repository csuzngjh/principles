/**
 * PRI-1292 round 2: constructBridge owns the StateManager it creates until
 * PainSignalBridge construction succeeds. Failure paths close it exactly once;
 * success transfers that duty to bridge disposal without double-close.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { bridgeConstructorFailure } = vi.hoisted(() => ({
  bridgeConstructorFailure: { value: false },
}));

vi.mock('../pain-signal-bridge.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.mock factory cannot use a static type-only import for its own module shape
  const actual = await importOriginal<typeof import('../pain-signal-bridge.js')>();
  class MaybeThrowingPainSignalBridge extends actual.PainSignalBridge {
    constructor(opts: ConstructorParameters<typeof actual.PainSignalBridge>[0]) {
      if (bridgeConstructorFailure.value) throw new Error('forced bridge constructor failure');
      super(opts);
    }
  }
  return { ...actual, PainSignalBridge: MaybeThrowingPainSignalBridge };
});

import {
  createPainSignalBridge,
  disposePainSignalBridgesForWorkspace,
  invalidatePainSignalBridge,
} from '../pain-signal-runtime-factory.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { computeEffectivePdConfig, getDefaultPdConfig } from '../config/index.js';

const INTENT = { readIntentDoc: () => ({ ok: false, found: false, flagEnabled: false, reason: 'flag_disabled' as const, nextAction: 'test-only disabled intent reader' }) };
const TRAJECTORY = { listUserTurnsForSession: () => [], listAssistantTurns: () => [] };
const AUTHORIZATION = { isHostSourceMaterialAuthorized: () => ({ authorized: false as const, reason: 'authorization_unavailable' as const }) };

function workspace(): { dir: string; stateDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pd-pri1292-construct-owner-'));
  return {
    dir: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function effectiveConfig(outputLanguage?: string) {
  const config = getDefaultPdConfig();
  config.runtimeProfiles['diag-profile'] = {
    type: 'pi-ai',
    provider: 'anthropic',
    model: 'claude-test',
    apiKeyEnv: 'PRI1292_OWNERSHIP_TEST_KEY',
  };
  config.internalAgents.defaultRuntime = 'diag-profile';
  config.internalAgents.agents.diagnostician = { enabled: true, runtimeProfile: 'diag-profile' };
  if (outputLanguage !== undefined) {
    (config.principles as { outputLanguage?: unknown }).outputLanguage = outputLanguage;
  }
  return computeEffectivePdConfig(config);
}

function bridgeOptions(dir: string, stateDir: string, config = effectiveConfig()) {
  return {
    workspaceDir: dir,
    stateDir,
    ledgerAdapter: {} as never,
    effectiveConfig: config,
    getEnvVar: (name: string) => (name === 'PRI1292_OWNERSHIP_TEST_KEY' ? 'test-key' : undefined),
    intentDocReader: INTENT,
    trajectoryTurnReader: TRAJECTORY,
    sourceMaterialAuthorization: AUTHORIZATION,
  };
}

describe('constructBridge StateManager ownership transfer', () => {
  afterEach(() => {
    bridgeConstructorFailure.value = false;
    vi.restoreAllMocks();
  });

  it('bundle construction failure after StateManager initialization closes the connection exactly once', async () => {
    const ws = workspace();
    const closeSpy = vi.spyOn(RuntimeStateManager.prototype, 'close');
    try {
      await expect(createPainSignalBridge({
        ...bridgeOptions(ws.dir, ws.stateDir, effectiveConfig('not-a-language')),
        telemetrySink: { emitTelemetry: () => { throw new Error('forced bundle construction failure'); } },
      })).rejects.toThrow('forced bundle construction failure');
      expect(closeSpy).toHaveBeenCalledTimes(1);
      // A fresh manager can open the same workspace: no leaked handle.
      const probe = new RuntimeStateManager({ workspaceDir: ws.dir });
      await probe.initialize();
      await probe.close();
    } finally {
      await disposePainSignalBridgesForWorkspace(ws.dir).catch(() => undefined);
      ws.cleanup();
    }
  });

  it('PainSignalBridge constructor failure closes the connection exactly once', async () => {
    const ws = workspace();
    bridgeConstructorFailure.value = true;
    const closeSpy = vi.spyOn(RuntimeStateManager.prototype, 'close');
    try {
      await expect(createPainSignalBridge(bridgeOptions(ws.dir, ws.stateDir))).rejects.toThrow('forced bridge constructor failure');
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      bridgeConstructorFailure.value = false;
      await disposePainSignalBridgesForWorkspace(ws.dir).catch(() => undefined);
      ws.cleanup();
    }
  });

  it('successful construction does not close early; workspace disposal closes once and repeated disposal does not double-close', async () => {
    const ws = workspace();
    const closeSpy = vi.spyOn(RuntimeStateManager.prototype, 'close');
    try {
      await createPainSignalBridge(bridgeOptions(ws.dir, ws.stateDir));
      expect(closeSpy).not.toHaveBeenCalled();
      await disposePainSignalBridgesForWorkspace(ws.dir);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      await disposePainSignalBridgesForWorkspace(ws.dir);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      invalidatePainSignalBridge(ws.dir);
    } finally {
      ws.cleanup();
    }
  });
});
