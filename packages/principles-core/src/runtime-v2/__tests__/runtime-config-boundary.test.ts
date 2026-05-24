import { describe, it, expect } from 'vitest';
import {
  validateRuntimeConfig,
  isRuntimeConfigError,
} from '../pain-signal-runtime-factory.js';
import type { RuntimeConfig } from '../pain-signal-runtime-factory.js';

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
});
