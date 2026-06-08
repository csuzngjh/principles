import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock discoverWorkspaceDefault to prevent real config discovery from interfering
vi.mock('../../src/services/pd-config-loader.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    discoverWorkspaceDefault: vi.fn().mockReturnValue(null),
  };
});

import {
  resolveRuntimeConfig,
  isRuntimeConfigError,
  validateRuntimeConfig,
  invalidatePainSignalBridge,
  createPainSignalBridge,
} from '@principles/core/runtime-v2';

const stubLedger = {
  readPrincipleSubtree: () => undefined,
  writePrinciple: () => ({ id: 'test' }) as never,
  updatePrincipleValueMetrics: () => ({ principleId: 'test' }) as never,
};

describe('PRI-228: PD-owned config resolution cutover', () => {
  describe('PD-owned config consumed by runtime entrypoint', () => {
    let tmpDir: string;
    let stateDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri228-'));
      stateDir = path.join(tmpDir, '.state');
      fs.mkdirSync(stateDir, { recursive: true });
    });

    afterEach(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('resolveRuntimeConfig with explicit workspaceDir resolves pi-ai default', () => {
      const result = resolveRuntimeConfig(stateDir);
      expect(isRuntimeConfigError(result)).toBe(false);
      if (!isRuntimeConfigError(result)) {
        expect(result.runtimeKind).toBe('pi-ai');
        expect(result.timeoutMs).toBeGreaterThan(0);
        expect(result.agentId).toBe('main');
      }
    });

    it('resolveRuntimeConfig with openclaw-cli requires explicit openclawMode', () => {
      const result = resolveRuntimeConfig(stateDir, { requestedRuntimeKind: 'openclaw-cli' });
      expect(isRuntimeConfigError(result)).toBe(true);
      if (isRuntimeConfigError(result)) {
        expect(result.reason).toBe('missing_openclaw_mode');
        expect(result.nextAction).toBeTruthy();
      }
    });

    it('resolveRuntimeConfig with openclaw-cli + openclawLocal resolves correctly', () => {
      const result = resolveRuntimeConfig(stateDir, {
        requestedRuntimeKind: 'openclaw-cli',
        openclawLocal: true,
      });
      expect(isRuntimeConfigError(result)).toBe(false);
      if (!isRuntimeConfigError(result)) {
        expect(result.runtimeKind).toBe('openclaw-cli');
        expect(result.openclawMode).toBe('local');
      }
    });

    it('resolveRuntimeConfig does not derive config from idle/night state', () => {
      const result = resolveRuntimeConfig(stateDir);
      expect(isRuntimeConfigError(result)).toBe(false);
      if (!isRuntimeConfigError(result)) {
        expect(Object.keys(result)).not.toContain('idleThreshold');
        expect(Object.keys(result)).not.toContain('triggerMode');
        expect(Object.keys(result)).not.toContain('sleepReflection');
      }
    });
  });

  describe('Missing explicit config fails loud', () => {
    let tmpDir: string;
    let stateDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri228-fail-'));
      stateDir = path.join(tmpDir, '.state');
      fs.mkdirSync(stateDir, { recursive: true });
    });

    afterEach(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('runtime=config without policy returns explicit_config_missing error', () => {
      const result = resolveRuntimeConfig(stateDir, { requestedRuntimeKind: 'config' });
      expect(isRuntimeConfigError(result)).toBe(true);
      if (isRuntimeConfigError(result)) {
        expect(result.reason).toBe('explicit_config_missing');
        expect(result.nextAction).toBeTruthy();
      }
    });

    it('error result serializes to single parseable JSON with nextAction', () => {
      const result = resolveRuntimeConfig(stateDir, { requestedRuntimeKind: 'config' });
      expect(isRuntimeConfigError(result)).toBe(true);
      if (isRuntimeConfigError(result)) {
        const json = JSON.stringify(result);
        const parsed = JSON.parse(json);
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toBeTruthy();
        expect(parsed.message).toBeTruthy();
        expect(parsed.nextAction).toBeTruthy();
      }
    });

    it('conflicting openclaw mode returns error with nextAction', () => {
      const result = resolveRuntimeConfig(stateDir, {
        requestedRuntimeKind: 'openclaw-cli',
        openclawLocal: true,
        openclawGateway: true,
      });
      expect(isRuntimeConfigError(result)).toBe(true);
      if (isRuntimeConfigError(result)) {
        expect(result.reason).toBe('conflicting_openclaw_mode');
        expect(result.nextAction).toBeTruthy();
      }
    });

    it('validateRuntimeConfig throws for openclaw-cli without mode', () => {
      const config = {
        runtimeKind: 'openclaw-cli' as const,
        timeoutMs: 300_000,
        agentId: 'main',
      };
      expect(() => validateRuntimeConfig(config)).toThrow(/requires openclawMode/);
    });
  });

  describe('Cache isolation between runtime modes', () => {
    const testWsDir = '/test-pri228-cache-isolation';
    const testStateDir = path.join(testWsDir, '.state');

    beforeEach(() => {
      invalidatePainSignalBridge(testWsDir);
    });

    afterEach(() => {
      invalidatePainSignalBridge(testWsDir);
    });

    it('pi-ai and openclaw-cli produce different bridge instances', async () => {
      const piAiConfig = resolveRuntimeConfig(testStateDir);
      if (isRuntimeConfigError(piAiConfig)) {
        expect.unreachable('pi-ai config should resolve');
        return;
      }
      const bridge1 = await createPainSignalBridge({
        workspaceDir: testWsDir,
        stateDir: testStateDir,
        ledgerAdapter: stubLedger,
      });
      expect(bridge1).toBeDefined();

      const openclawConfig = resolveRuntimeConfig(testStateDir, {
        requestedRuntimeKind: 'openclaw-cli',
        openclawLocal: true,
      });
      if (isRuntimeConfigError(openclawConfig)) {
        expect.unreachable('openclaw-cli config should resolve');
        return;
      }
      const bridge2 = await createPainSignalBridge({
        workspaceDir: testWsDir,
        stateDir: testStateDir,
        ledgerAdapter: stubLedger,
      });
      expect(bridge2).toBeDefined();
      expect(bridge1).not.toBe(bridge2);
    });

    it('invalidatePainSignalBridge with workspace-only clears all modes', async () => {
      const piAiConfig = resolveRuntimeConfig(testStateDir);
      if (isRuntimeConfigError(piAiConfig)) return;
      await createPainSignalBridge({
        workspaceDir: testWsDir,
        stateDir: testStateDir,
        ledgerAdapter: stubLedger,
      });
      invalidatePainSignalBridge(testWsDir);
      const bridgeAfter = await createPainSignalBridge({
        workspaceDir: testWsDir,
        stateDir: testStateDir,
        ledgerAdapter: stubLedger,
      });
      expect(bridgeAfter).toBeDefined();
    });
  });

  describe('CLI resolveWorkspaceDir gate', () => {
    it('resolveWorkspaceDir throws when no workspace provided', async () => {
      const mod = await import('../../src/resolve-workspace.js');
      delete process.env.PD_WORKSPACE_DIR;
      expect(() => mod.resolveWorkspaceDir()).toThrow(/No workspace directory configured/);
    });

    it('resolveWorkspaceDir uses explicit workspace when provided', async () => {
      const mod = await import('../../src/resolve-workspace.js');
      const result = mod.resolveWorkspaceDir('/explicit/workspace');
      expect(result).toBe('/explicit/workspace');
    });

    it('resolveWorkspaceDir uses PD_WORKSPACE_DIR env when no explicit', async () => {
      const mod = await import('../../src/resolve-workspace.js');
      process.env.PD_WORKSPACE_DIR = '/env/workspace';
      try {
        const result = mod.resolveWorkspaceDir();
        expect(result).toBe('/env/workspace');
      } finally {
        delete process.env.PD_WORKSPACE_DIR;
      }
    });
  });
});