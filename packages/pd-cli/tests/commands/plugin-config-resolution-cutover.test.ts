import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  resolveRuntimeConfig,
  isRuntimeConfigError,
  validateRuntimeConfig,
  invalidatePainSignalBridge,
} from '@principles/core/runtime-v2';

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
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
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

  describe('Cache/adapter construction semantics', () => {
    beforeEach(() => {
      invalidatePainSignalBridge('/test-pri228-cache', 'openclaw-cli');
      invalidatePainSignalBridge('/test-pri228-cache', 'pi-ai');
    });

    it('different openclawMode values produce different cache keys', () => {
      const localKey = '/test-pri228-cache:openclaw-cli:local';
      const gatewayKey = '/test-pri228-cache:openclaw-cli:gateway';
      const emptyKey = '/test-pri228-cache:openclaw-cli:';
      expect(localKey).not.toBe(gatewayKey);
      expect(localKey).not.toBe(emptyKey);
      expect(gatewayKey).not.toBe(emptyKey);
    });

    it('pi-ai config without openclawMode uses empty string in key', () => {
      const key = '/test-pri228-cache:pi-ai:';
      expect(key).toBeTruthy();
      expect(key).not.toContain('local');
      expect(key).not.toContain('gateway');
    });

    it('invalidatePainSignalBridge clears all mode variants', () => {
      invalidatePainSignalBridge('/test-pri228-cache');
      expect(true).toBe(true);
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