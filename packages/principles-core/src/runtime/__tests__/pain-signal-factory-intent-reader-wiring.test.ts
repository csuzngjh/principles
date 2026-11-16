/**
 * PRI-1229~1233 / SPEC-PD-INTENT-UNIFICATION-001 §9.2 — factory intent-reader
 * wiring and cache-key discipline.
 *
 * Two contracts:
 * 1. The `intentDocReader` handed to `createPainSignalBridge` reaches the
 *    Stage A (root-cause) runner's DEPS — not just the factory options.
 * 2. The intent flag participates in the bridge cache key: a long-lived host
 *    that toggles intent_engineering must never reuse a bridge built under
 *    the other flag state (same discipline as persistence/pipeline/reuse
 *    flags — see the cache-key comment in pain-signal-runtime-factory.ts).
 *
 * Runner classes are mocked to capture constructor args (same technique as
 * pain-signal-runtime-factory-effectiveconfig-wiring.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { ctorCaptures } = vi.hoisted(() => ({
  ctorCaptures: [] as { name: string; deps: unknown; options: unknown }[],
}));

function makeMockRunnerClass(name: string) {
  return class {
    constructor(deps: unknown, options: unknown) {
      ctorCaptures.push({ name, deps, options });
    }
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    run = async (taskId: string) => ({
      status: 'failed' as const,
      taskId,
      errorCategory: 'output_invalid' as const,
      failureReason: 'mock runner (wiring test)',
      attemptCount: 1,
    });
  };
}

vi.mock('../internalization/diag-router-runner.js', () => ({
  DiagRouterRunner: makeMockRunnerClass('router'),
}));
vi.mock('../internalization/diag-rootcause-runner.js', () => ({
  DiagRootCauseRunner: makeMockRunnerClass('rootcause'),
}));
vi.mock('../internalization/diag-distiller-runner.js', () => ({
  DiagDistillerRunner: makeMockRunnerClass('distiller'),
}));

import {
  createPainSignalBridge,
  disposePainSignalBridgesForWorkspace,
} from '../pain-signal-runtime-factory.js';
import { computeEffectivePdConfig } from '../config/pd-config-effective.js';
import { getDefaultPdConfig } from '../config/pd-config-defaults.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import type { IntentDocReader } from '../intent/intent-doc-reader-port.js';

const OWNER = 'pri-1229-wiring-test';
const ENV_KEY = 'PRI1229_WIRING_TEST_KEY';

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'pri-1229-wiring-'));
  return join(root, 'workspace');
}

function makeEffectiveConfig(intentEnabled: boolean): EffectivePdConfig {
  const defaults = getDefaultPdConfig();
  return computeEffectivePdConfig({
    ...defaults,
    features: {
      ...defaults.features,
      intent_engineering: { enabled: intentEnabled },
    },
    runtimeProfiles: {
      'diag-profile': {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: ENV_KEY,
      },
    },
    internalAgents: {
      defaultRuntime: 'diag-profile',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'diag-profile' },
      },
    },
  } as never);
}

function makeReader(mark: string): IntentDocReader {
  return {
    readIntentDoc: () => ({
      ok: false,
      found: false,
      flagEnabled: false,
      reason: 'flag_disabled' as const,
      nextAction: `wiring-test reader ${mark}`,
    }),
  };
}

function rootCauseCaptures() {
  return ctorCaptures.filter((c) => c.name === 'rootcause');
}

describe('PRI-1229: intentDocReader factory wiring + cache-key discipline', () => {
  afterEach(async () => {
    ctorCaptures.length = 0;
  });

  it('the reader handed to the factory arrives in the Stage A runner DEPS', async () => {
    const workspaceDir = makeWorkspace();
    try {
      const reader = makeReader('deps-check');
      await createPainSignalBridge({
        workspaceDir,
        stateDir: join(workspaceDir, '.state'),
        ledgerAdapter: {} as never,
        owner: OWNER,
        effectiveConfig: makeEffectiveConfig(true),
        getEnvVar: (name: string) => (name === ENV_KEY ? 'sentinel' : undefined),
        intentDocReader: reader,
      });

      const captures = rootCauseCaptures();
      expect(captures).toHaveLength(1);
      const deps = captures[0]?.deps as Record<string, unknown>;
      expect(deps?.intentDocReader).toBe(reader);
    } finally {
      await disposePainSignalBridgesForWorkspace(workspaceDir).catch(() => undefined);
      rmSync(join(workspaceDir, '..'), { recursive: true, force: true });
    }
  });

  it('no reader wired → Stage A runner deps carry undefined reader (legacy callers unchanged)', async () => {
    const workspaceDir = makeWorkspace();
    try {
      await createPainSignalBridge({
        workspaceDir,
        stateDir: join(workspaceDir, '.state'),
        ledgerAdapter: {} as never,
        owner: OWNER,
        effectiveConfig: makeEffectiveConfig(true),
        getEnvVar: (name: string) => (name === ENV_KEY ? 'sentinel' : undefined),
      });

      const captures = rootCauseCaptures();
      expect(captures).toHaveLength(1);
      const deps = captures[0]?.deps as Record<string, unknown>;
      expect(deps?.intentDocReader).toBeUndefined();
    } finally {
      await disposePainSignalBridgesForWorkspace(workspaceDir).catch(() => undefined);
      rmSync(join(workspaceDir, '..'), { recursive: true, force: true });
    }
  });

  it('intent flag toggle changes the bridge cache slot — the flag-off call never reuses the flag-on bridge', async () => {
    const workspaceDir = makeWorkspace();
    try {
      const readerOn = makeReader('flag-on');
      const first = await createPainSignalBridge({
        workspaceDir,
        stateDir: join(workspaceDir, '.state'),
        ledgerAdapter: {} as never,
        owner: OWNER,
        effectiveConfig: makeEffectiveConfig(true),
        getEnvVar: (name: string) => (name === ENV_KEY ? 'sentinel' : undefined),
        intentDocReader: readerOn,
      });
      expect(rootCauseCaptures()).toHaveLength(1);

      // Same workspace + same runtime profile, flag now OFF. If the cache key
      // ignored the intent flag, this would return `first` and construct no
      // new runner — leaving Stage A pinned to the flag-on reader forever.
      const readerOff = makeReader('flag-off');
      const second = await createPainSignalBridge({
        workspaceDir,
        stateDir: join(workspaceDir, '.state'),
        ledgerAdapter: {} as never,
        owner: OWNER,
        effectiveConfig: makeEffectiveConfig(false),
        getEnvVar: (name: string) => (name === ENV_KEY ? 'sentinel' : undefined),
        intentDocReader: readerOff,
      });

      expect(second).not.toBe(first);
      const captures = rootCauseCaptures();
      expect(captures).toHaveLength(2);
      const deps = captures[1]?.deps as Record<string, unknown>;
      expect(deps?.intentDocReader).toBe(readerOff);

      // Toggling back ON may legitimately reuse the warm flag-on slot (same
      // reader binding, same flag state) — but never the flag-off bridge, and
      // no additional runner construction happens.
      const third = await createPainSignalBridge({
        workspaceDir,
        stateDir: join(workspaceDir, '.state'),
        ledgerAdapter: {} as never,
        owner: OWNER,
        effectiveConfig: makeEffectiveConfig(true),
        getEnvVar: (name: string) => (name === ENV_KEY ? 'sentinel' : undefined),
        intentDocReader: readerOn,
      });
      expect(third).not.toBe(second);
      expect(rootCauseCaptures()).toHaveLength(2);
    } finally {
      await disposePainSignalBridgesForWorkspace(workspaceDir).catch(() => undefined);
      rmSync(join(workspaceDir, '..'), { recursive: true, force: true });
    }
  });

  it('same flag state reuses the cached bridge (no duplicate runner construction)', async () => {
    const workspaceDir = makeWorkspace();
    try {
      const reader = makeReader('cache-hit');
      const options = {
        workspaceDir,
        stateDir: join(workspaceDir, '.state'),
        ledgerAdapter: {} as never,
        owner: OWNER,
        effectiveConfig: makeEffectiveConfig(true),
        getEnvVar: (name: string) => (name === ENV_KEY ? 'sentinel' : undefined),
        intentDocReader: reader,
      };
      const first = await createPainSignalBridge(options);
      const second = await createPainSignalBridge(options);
      expect(second).toBe(first);
      expect(rootCauseCaptures()).toHaveLength(1);
    } finally {
      await disposePainSignalBridgesForWorkspace(workspaceDir).catch(() => undefined);
      rmSync(join(workspaceDir, '..'), { recursive: true, force: true });
    }
  });
});
