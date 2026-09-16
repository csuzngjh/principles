/**
 * PRI-818 (R-08) — factory wiring test: effectiveConfig must reach Stage C.
 *
 * R-08: pain-signal-runtime-factory passed `effectiveConfig` to the Stage A
 * (rootcause) and Stage B (distiller) runners but NOT to the Stage C
 * (router) runner, so `isDegradationEnabled()` was always false there and
 * the ADR-0019 rate-limit fast-fail degradation path could never fire for
 * Stage C.
 *
 * This test exercises the REAL factory construction path
 * (`createPainSignalBridge` → `constructBridge`) with the three diag runner
 * classes mocked to capture their constructor options, and asserts that the
 * exact effectiveConfig handed to the factory arrives in ALL THREE runner
 * options objects (cli-7-style: test the actual wiring, not a handler).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { ctorCaptures } = vi.hoisted(() => ({
  ctorCaptures: [] as { name: string; options: unknown }[],
}));

function makeMockRunnerClass(name: string) {
  return class {
    constructor(_deps: unknown, options: unknown) {
      ctorCaptures.push({ name, options });
    }
    // The factory wires these runners into a SplitDiagnosticianRunner; the
    // bridge under construction is never run in this test, so run() only
    // needs to exist for type shape.
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

import { createPainSignalBridge, disposePainSignalBridgesForWorkspace } from '../pain-signal-runtime-factory.js';
import { computeEffectivePdConfig } from '../config/pd-config-effective.js';

const OWNER = 'pri-818-wiring-test';

function makeWorkspace(): { workspaceDir: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pri-818-wiring-'));
  return { workspaceDir: join(root, 'workspace'), stateDir: join(root, 'state') };
}

describe('PRI-818 R-08: createPainSignalBridge wiring passes effectiveConfig to all three diag runners', () => {
  afterEach(async () => {
    ctorCaptures.length = 0;
  });

  it('router runner options include effectiveConfig (same object as handed to the factory)', async () => {
    const { workspaceDir, stateDir } = makeWorkspace();
    try {
      // Minimal Owner config: diagnostician enabled, bound to an openclaw
      // local profile (resolves to a runtime config that passes
      // validateRuntimeConfig without any external service).
      const effectiveConfig = computeEffectivePdConfig({
        features: {},
        runtimeProfiles: {
          'openclaw.default': { type: 'openclaw', source: 'default' },
          'diag-profile': { type: 'openclaw', provider: 'lmstudio', model: 'qwen3.6-27b-mtp' },
        },
        internalAgents: {
          defaultRuntime: 'openclaw.default',
          agents: {
            diagnostician: { enabled: true, runtimeProfile: 'diag-profile' },
          },
        },
      } as never) as Parameters<typeof createPainSignalBridge>[0]['effectiveConfig'];

      if (!effectiveConfig) throw new Error('computeEffectivePdConfig returned undefined');

      await createPainSignalBridge({
        workspaceDir,
        stateDir,
        ledgerAdapter: {} as never,
        owner: OWNER,
        effectiveConfig,
      });

      const routerCaptures = ctorCaptures.filter((c) => c.name === 'router');
      expect(routerCaptures).toHaveLength(1);
      expect(routerCaptures[0]?.options).toMatchObject({
        owner: OWNER,
        effectiveConfig,
      });

      // Guard: Stage A/B must keep receiving it too (regression net for the
      // original R-08 class of wiring drift).
      for (const name of ['rootcause', 'distiller']) {
        const sameStage = ctorCaptures.filter((x) => x.name === name);
        expect(sameStage).toHaveLength(1);
        expect(sameStage[0]?.options).toMatchObject({ effectiveConfig });
      }
    } finally {
      await disposePainSignalBridgesForWorkspace(workspaceDir).catch(() => undefined);
      rmSync(join(workspaceDir, '..'), { recursive: true, force: true });
    }
  });
});
