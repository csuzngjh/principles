/**
 * PRI-393: Runtime config unification tests
 *
 * Validates that all MVP mainline execution paths (probe, run-once, diagnose,
 * pain-retry) read from .pd/config.yaml, NOT from .state/workflows.yaml.
 *
 * ERR refs:
 * - EP-02: production path wiring — tests exercise real production entry points
 * - EP-03: fail loud — no silent fallback
 * - EP-07: runtime state source alignment — doctor/probe/run-once agree
 * - EP-09: test reality gap — production schema fixtures
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import {
  assertMainlineContract,
  type MainlineSnapshot,
} from '@principles/core/runtime-v2';

// ── Helpers ────────────────────────────────────────────────────────────────

function mkTmpDir(prefix = 'pri-393-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeConfigYaml(workspaceDir: string, content: object): void {
  const pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  fs.writeFileSync(
    path.join(pdDir, 'config.yaml'),
    yaml.dump(content, { lineWidth: -1 }),
    'utf8',
  );
}

function writeLegacyWorkflowsYaml(workspaceDir: string, content: string): void {
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), content, 'utf8');
}

/** Minimal valid .pd/config.yaml with a pi-ai runtime profile for diagnostician. */
function makeValidConfigYaml(overrides?: { provider?: string; model?: string }): object {
  return {
    version: 1,
    features: {
      prompt: { enabled: true },
      correction_observer: { enabled: false },
    },
    runtimeProfiles: [
      {
        id: 'lmstudio',
        type: 'pi-ai',
        provider: overrides?.provider ?? 'lmstudio',
        model: overrides?.model ?? 'local-model',
        apiKeyEnv: 'LMSTUDIO_API_KEY',
        baseUrl: 'http://localhost:1234/v1',
      },
    ],
    internalAgents: {
      agents: [
        {
          name: 'diagnostician',
          enabled: true,
          runtimeProfile: 'lmstudio',
        },
      ],
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PRI-393: runtime config unification', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    rmTmpDir(tmpDir);
  });

  describe('Guard: legacy resolveRuntimeConfig not imported by production commands', () => {
    it('production command source files do NOT import legacy resolveRuntimeConfig', async () => {
      // Read the source of each production command and verify the import
      const commandFiles = [
        'packages/pd-cli/src/commands/runtime.ts',
        'packages/pd-cli/src/commands/runtime-internalization-run-once.ts',
        'packages/pd-cli/src/commands/diagnose.ts',
        'packages/pd-cli/src/commands/pain-retry.ts',
      ];

      for (const file of commandFiles) {
        const fullPath = path.resolve(file);
        if (!fs.existsSync(fullPath)) continue;
        const source = fs.readFileSync(fullPath, 'utf8');

        // Check that resolveRuntimeConfig is NOT imported from @principles/core/runtime-v2
        // (it may appear in comments or as resolveRuntimeConfigFromPdConfig)
        const importLines = source.split('\n').filter(
          (line) => line.includes('import') && line.includes('@principles/core/runtime-v2'),
        );
        for (const importLine of importLines) {
          // Allow resolveRuntimeConfigFromPdConfig but NOT bare resolveRuntimeConfig
          if (importLine.includes('resolveRuntimeConfig') && !importLine.includes('resolveRuntimeConfigFromPdConfig')) {
            // This is the legacy import — fail
            expect.fail(
              `${file} still imports legacy resolveRuntimeConfig from @principles/core/runtime-v2. ` +
              `Use resolveRuntimeFromPdConfig() from services/resolve-runtime-from-pd-config.ts instead.`,
            );
          }
        }
      }
    });
  });

  describe('Config source alignment via mainline contract', () => {
    function makeBaseSnapshot(readiness: Partial<MainlineSnapshot['readiness']>): MainlineSnapshot {
      return {
        readiness: {
          configDoctorProfile: null,
          runtimeProbeProfile: null,
          configSource: '.pd/config.yaml',
          probeConfigSource: '.pd/config.yaml',
          diagnosticianReady: true,
          ...readiness,
        },
        chain: {
          painId: null,
          diagnosisTask: null,
          diagnosticianArtifact: null,
          candidate: null,
          dreamerTask: null,
          dreamerContext: null,
          successor: null,
          principle: null,
        },
      };
    }

    it('violation: doctor and probe use different config sources (drift)', () => {
      const snapshot = makeBaseSnapshot({
        configDoctorProfile: 'pi-ai.lmstudio',
        runtimeProbeProfile: 'pi-ai.sensenova-cn',
        configSource: '.pd/config.yaml',
        probeConfigSource: '.state/workflows.yaml',
      });

      const verdict = assertMainlineContract(snapshot);
      const alignmentStage = verdict.stages.find((s) => s.stage === 'config_source_alignment');

      expect(alignmentStage).toBeDefined();
      expect(alignmentStage!.status).toBe('violation');
      expect(alignmentStage!.reason).toContain('drift');
      expect(alignmentStage!.nextAction).toContain('.pd/config.yaml');
    });

    it('violation: profiles match but probe reads from workflows.yaml (coincidental)', () => {
      const snapshot = makeBaseSnapshot({
        configDoctorProfile: 'pi-ai.lmstudio',
        runtimeProbeProfile: 'pi-ai.lmstudio',
        configSource: '.pd/config.yaml',
        probeConfigSource: '.state/workflows.yaml',
      });

      const verdict = assertMainlineContract(snapshot);
      const alignmentStage = verdict.stages.find((s) => s.stage === 'config_source_alignment');

      expect(alignmentStage).toBeDefined();
      expect(alignmentStage!.status).toBe('violation');
      expect(alignmentStage!.reason).toContain('coincidental');
    });

    it('ok: doctor and probe agree on same profile from .pd/config.yaml', () => {
      const snapshot = makeBaseSnapshot({
        configDoctorProfile: 'pi-ai.lmstudio',
        runtimeProbeProfile: 'pi-ai.lmstudio',
        configSource: '.pd/config.yaml',
        probeConfigSource: '.pd/config.yaml',
      });

      const verdict = assertMainlineContract(snapshot);
      const alignmentStage = verdict.stages.find((s) => s.stage === 'config_source_alignment');

      expect(alignmentStage).toBeDefined();
      expect(alignmentStage!.status).toBe('ok');
      expect(alignmentStage!.reason).toContain('.pd/config.yaml');
    });
  });

  describe('resolveRuntimeFromPdConfig reads .pd/config.yaml', () => {
    it('resolves pi-ai config from .pd/config.yaml', async () => {
      writeConfigYaml(tmpDir, makeValidConfigYaml());

      // Dynamically import to avoid module resolution issues
      const { resolveRuntimeFromPdConfig } = await import('../../src/services/resolve-runtime-from-pd-config.js');
      const resolved = resolveRuntimeFromPdConfig(tmpDir, () => 'test-key');

      expect(resolved.configSource).toBe('.pd/config.yaml');
      expect(resolved.result).toBeDefined();
      // Should not be an error when config is valid
      const { isRuntimeConfigError: isErr } = await import('@principles/core/runtime-v2');
      expect(isErr(resolved.result)).toBe(false);
    });

    it('ignores conflicting .state/workflows.yaml when .pd/config.yaml exists', async () => {
      // Write .pd/config.yaml with lmstudio
      writeConfigYaml(tmpDir, makeValidConfigYaml({ provider: 'lmstudio', model: 'local-model' }));

      // Write conflicting .state/workflows.yaml
      writeLegacyWorkflowsYaml(tmpDir, `version: '1'
funnels:
  - workflowId: pd-runtime-v2-diagnosis
    stages: []
    policy:
      runtimeKind: pi-ai
      provider: sensenova-cn
      model: deepseek-v4-flash
      apiKeyEnv: SENSENOVA_API_KEY
`);

      const { resolveRuntimeFromPdConfig } = await import('../../src/services/resolve-runtime-from-pd-config.js');
      const resolved = resolveRuntimeFromPdConfig(tmpDir, () => 'test-key');

      // Should have legacy warning
      expect(resolved.legacyWarnings.length).toBeGreaterThan(0);
      expect(resolved.legacyWarnings[0]).toContain('workflows.yaml');

      // Should resolve from .pd/config.yaml, NOT workflows.yaml
      const { isRuntimeConfigError: isErr } = await import('@principles/core/runtime-v2');
      if (!isErr(resolved.result)) {
        expect(resolved.result.provider).not.toBe('sensenova-cn');
      }
      expect(resolved.configSource).toBe('.pd/config.yaml');
    });

    it('fail loud when .pd/config.yaml is malformed', async () => {
      const pdDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(pdDir, { recursive: true });
      fs.writeFileSync(path.join(pdDir, 'config.yaml'), 'version: [unterminated', 'utf8');

      const { resolveRuntimeFromPdConfig } = await import('../../src/services/resolve-runtime-from-pd-config.js');
      const resolved = resolveRuntimeFromPdConfig(tmpDir, () => 'test-key');

      // Should still produce a result (with defaults) — the error is in configLoadResult
      expect(resolved.configLoadResult.ok).toBe(false);
      expect(resolved.configSource).toBe('.pd/config.yaml');
    });
  });

  describe('JSON output purity', () => {
    it('resolveRuntimeFromPdConfig result serializes to valid JSON', async () => {
      writeConfigYaml(tmpDir, makeValidConfigYaml());

      const { resolveRuntimeFromPdConfig } = await import('../../src/services/resolve-runtime-from-pd-config.js');
      const resolved = resolveRuntimeFromPdConfig(tmpDir, () => 'test-key');

      const jsonStr = JSON.stringify(resolved.result);
      const parsed = JSON.parse(jsonStr);
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe('object');
    });
  });
});
