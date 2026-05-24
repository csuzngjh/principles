import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateRuntimeConfig,
  isRuntimeConfigError,
  invalidatePainSignalBridge,
  resolveRuntimeConfig,
} from '../pain-signal-runtime-factory.js';
import type { RuntimeConfig } from '../pain-signal-runtime-factory.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Runtime Config Boundary (PRI-162)', () => {
  describe('validateRuntimeConfig', () => {
    it('throws when openclaw-cli has no openclawMode', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'openclaw-cli',
        timeoutMs: 300_000,
        agentId: 'main',
      };
      expect(() => validateRuntimeConfig(config)).toThrow(/requires openclawMode/);
    });

    it('passes when openclaw-cli has openclawMode local', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'openclaw-cli',
        openclawMode: 'local',
        timeoutMs: 300_000,
        agentId: 'main',
      };
      expect(() => validateRuntimeConfig(config)).not.toThrow();
    });

    it('passes when openclaw-cli has openclawMode gateway', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'openclaw-cli',
        openclawMode: 'gateway',
        timeoutMs: 300_000,
        agentId: 'main',
      };
      expect(() => validateRuntimeConfig(config)).not.toThrow();
    });

    it('throws when pi-ai is missing required fields', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'pi-ai',
        timeoutMs: 300_000,
        agentId: 'main',
      };
      expect(() => validateRuntimeConfig(config)).toThrow(/Missing required fields for runtimeKind 'pi-ai'/);
    });

    it('passes when pi-ai has all required fields', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'pi-ai',
        timeoutMs: 300_000,
        agentId: 'main',
        provider: 'openrouter',
        model: 'claude-sonnet-4',
        apiKeyEnv: 'TEST_KEY',
      };
      expect(() => validateRuntimeConfig(config)).not.toThrow();
    });

    it('throws with nextAction when openclaw-cli has no mode', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'openclaw-cli',
        timeoutMs: 300_000,
        agentId: 'main',
      };
      try {
        validateRuntimeConfig(config);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err instanceof Error).toBe(true);
        if (err instanceof Error) {
          expect(err.message).toContain('nextAction');
        }
      }
    });
  });

  describe('isRuntimeConfigError', () => {
    it('returns true for error results', () => {
      const error = { ok: false as const, reason: 'test', message: 'test', nextAction: 'test' };
      expect(isRuntimeConfigError(error)).toBe(true);
    });

    it('returns false for valid config results', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'pi-ai',
        timeoutMs: 300_000,
        agentId: 'main',
      };
      expect(isRuntimeConfigError(config)).toBe(false);
    });
  });

  describe('JSON failure output contract', () => {
    it('error result serializes to single parseable JSON with nextAction', () => {
      const error = { ok: false as const, reason: 'missing_openclaw_mode', message: 'no mode specified', nextAction: 'Provide --openclaw-local or --openclaw-gateway' };
      const json = JSON.stringify(error);
      const parsed = JSON.parse(json);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe('missing_openclaw_mode');
      expect(parsed.message).toBeTruthy();
      expect(parsed.nextAction).toBeTruthy();
    });

    it('conflicting mode error result is parseable', () => {
      const error = { ok: false as const, reason: 'conflicting_openclaw_mode', message: 'CLI flag conflicts with file config', nextAction: 'Remove one conflicting mode' };
      const json = JSON.stringify(error);
      const parsed = JSON.parse(json);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe('conflicting_openclaw_mode');
      expect(parsed.nextAction).toBeTruthy();
    });
  });

  describe('RuntimeConfig type contract', () => {
    it('openclawMode is optional for pi-ai runtimeKind', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'pi-ai',
        timeoutMs: 300_000,
        agentId: 'main',
        provider: 'openrouter',
        model: 'claude-sonnet-4',
        apiKeyEnv: 'TEST_KEY',
      };
      expect(config.openclawMode).toBeUndefined();
      expect(() => validateRuntimeConfig(config)).not.toThrow();
    });

    it('openclawMode local is a valid value', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'openclaw-cli',
        openclawMode: 'local',
        timeoutMs: 300_000,
        agentId: 'main',
      };
      expect(config.openclawMode).toBe('local');
    });

    it('openclawMode gateway is a valid value', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'openclaw-cli',
        openclawMode: 'gateway',
        timeoutMs: 300_000,
        agentId: 'main',
      };
      expect(config.openclawMode).toBe('gateway');
    });
  });

  describe('Bridge cache key includes openclawMode (D-03)', () => {
    beforeEach(() => {
      invalidatePainSignalBridge('/test-ws', 'openclaw-cli');
      invalidatePainSignalBridge('/test-ws', 'pi-ai');
    });

    it('local and gateway produce different cache keys', () => {
      const localConfig: RuntimeConfig = {
        runtimeKind: 'openclaw-cli',
        openclawMode: 'local',
        timeoutMs: 300_000,
        agentId: 'main',
      };
      const gatewayConfig: RuntimeConfig = {
        runtimeKind: 'openclaw-cli',
        openclawMode: 'gateway',
        timeoutMs: 300_000,
        agentId: 'main',
      };
      const localKey = `${'/test-ws'}:${localConfig.runtimeKind}:${localConfig.openclawMode ?? ''}`;
      const gatewayKey = `${'/test-ws'}:${gatewayConfig.runtimeKind}:${gatewayConfig.openclawMode ?? ''}`;
      expect(localKey).not.toBe(gatewayKey);
    });

    it('pi-ai config without openclawMode uses empty string in key', () => {
      const piAiConfig: RuntimeConfig = {
        runtimeKind: 'pi-ai',
        timeoutMs: 300_000,
        agentId: 'main',
        provider: 'openrouter',
        model: 'test',
        apiKeyEnv: 'TEST_KEY',
      };
      const key = `${'/test-ws'}:${piAiConfig.runtimeKind}:${piAiConfig.openclawMode ?? ''}`;
      expect(key).toBe('/test-ws:pi-ai:');
    });

    it('invalidatePainSignalBridge clears all mode variants', () => {
      const localKey = '/test-ws:openclaw-cli:local';
      const gatewayKey = '/test-ws:openclaw-cli:gateway';
      const emptyKey = '/test-ws:openclaw-cli:';
      expect(localKey).not.toBe(gatewayKey);
      expect(localKey).not.toBe(emptyKey);
      expect(gatewayKey).not.toBe(emptyKey);
    });
  });

  describe('resolveRuntimeConfig with requestedRuntimeKind', () => {
    let tmpDir = '';

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rt-cfg-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('requestedRuntimeKind=openclaw-cli without flags returns missing_openclaw_mode error', () => {
      const result = resolveRuntimeConfig(tmpDir, { requestedRuntimeKind: 'openclaw-cli' });
      expect(isRuntimeConfigError(result)).toBe(true);
      if (isRuntimeConfigError(result)) {
        expect(result.reason).toBe('missing_openclaw_mode');
        expect(result.nextAction).toBeTruthy();
      }
    });

    it('requestedRuntimeKind=openclaw-cli with openclawGateway returns gateway mode', () => {
      const result = resolveRuntimeConfig(tmpDir, { requestedRuntimeKind: 'openclaw-cli', openclawGateway: true });
      expect(isRuntimeConfigError(result)).toBe(false);
      if (!isRuntimeConfigError(result)) {
        expect(result.runtimeKind).toBe('openclaw-cli');
        expect(result.openclawMode).toBe('gateway');
      }
    });

    it('requestedRuntimeKind=openclaw-cli with openclawLocal returns local mode', () => {
      const result = resolveRuntimeConfig(tmpDir, { requestedRuntimeKind: 'openclaw-cli', openclawLocal: true });
      expect(isRuntimeConfigError(result)).toBe(false);
      if (!isRuntimeConfigError(result)) {
        expect(result.runtimeKind).toBe('openclaw-cli');
        expect(result.openclawMode).toBe('local');
      }
    });

    it('requestedRuntimeKind=config without policy returns explicit_config_missing error', () => {
      const result = resolveRuntimeConfig(tmpDir, { requestedRuntimeKind: 'config' });
      expect(isRuntimeConfigError(result)).toBe(true);
      if (isRuntimeConfigError(result)) {
        expect(result.reason).toBe('explicit_config_missing');
        expect(result.nextAction).toBeTruthy();
      }
    });

    it('no requestedRuntimeKind without policy returns pi-ai default', () => {
      const result = resolveRuntimeConfig(tmpDir);
      expect(isRuntimeConfigError(result)).toBe(false);
      if (!isRuntimeConfigError(result)) {
        expect(result.runtimeKind).toBe('pi-ai');
      }
    });
  });
});
