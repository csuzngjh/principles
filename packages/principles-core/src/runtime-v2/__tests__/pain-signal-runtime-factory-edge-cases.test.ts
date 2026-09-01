/**
 * Edge case tests for pain-signal-runtime-factory
 *
 * Focus on error paths, validation boundaries, and DisabledDiagnosticianRunner
 * that are not fully covered by existing integration tests.
 */

import { describe, it, expect } from 'vitest';
import {
  DisabledDiagnosticianRunner,
  validateRuntimeConfig,
  isRuntimeConfigError,
  type RuntimeConfig,
  type RuntimeConfigError,
} from '../pain-signal-runtime-factory.js';

describe('DisabledDiagnosticianRunner', () => {
  it('returns failed status with capability_missing error category', async () => {
    const runner = new DisabledDiagnosticianRunner();
    const result = await runner.run('task-001');

    expect(result.status).toBe('failed');
    expect(result.taskId).toBe('task-001');
    expect(result.errorCategory).toBe('capability_missing');
    // PRI-638: the message now names the canonical capability authority.
    expect(result.failureReason).toContain('disabled by Owner configuration');
    expect(result.failureReason).toContain('internalAgents.agents.diagnostician.enabled');
    expect(result.nextAction).toContain('internalAgents.agents.diagnostician.enabled');
    expect(result.attemptCount).toBe(1);
  });

  it('returns the same error category for any taskId', async () => {
    const runner = new DisabledDiagnosticianRunner();

    const result1 = await runner.run('task-001');
    const result2 = await runner.run('different-task-id');
    const result3 = await runner.run('');

    expect(result1.errorCategory).toBe('capability_missing');
    expect(result2.errorCategory).toBe('capability_missing');
    expect(result3.errorCategory).toBe('capability_missing');
  });
});

describe('validateRuntimeConfig', () => {
  it('accepts valid openclaw-cli config with local mode', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'openclaw-cli',
      openclawMode: 'local',
      timeoutMs: 300000,
      agentId: 'main',
    };

    // Should not throw
    expect(() => validateRuntimeConfig(config)).not.toThrow();
  });

  it('accepts valid openclaw-cli config with gateway mode', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'openclaw-cli',
      openclawMode: 'gateway',
      timeoutMs: 300000,
      agentId: 'main',
    };

    expect(() => validateRuntimeConfig(config)).not.toThrow();
  });

  it('accepts openclaw-cli with undefined openclawMode (delegated mode)', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'openclaw-cli',
      openclawMode: undefined,
      timeoutMs: 300000,
      agentId: 'main',
    };

    expect(() => validateRuntimeConfig(config)).not.toThrow();
  });

  it('rejects invalid openclawMode value', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'openclaw-cli',
      openclawMode: 'invalid-mode' as 'local' | 'gateway',
      timeoutMs: 300000,
      agentId: 'main',
    };

    expect(() => validateRuntimeConfig(config)).toThrow(/Invalid openclawMode/);
    expect(() => validateRuntimeConfig(config)).toThrow(/nextAction/);
  });

  it('accepts valid pi-ai config with all required fields', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'pi-ai',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      timeoutMs: 300000,
      agentId: 'main',
    };

    expect(() => validateRuntimeConfig(config)).not.toThrow();
  });

  it('rejects pi-ai config missing provider', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'pi-ai',
      model: 'claude-3-5-sonnet',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      timeoutMs: 300000,
      agentId: 'main',
    };

    expect(() => validateRuntimeConfig(config)).toThrow(/Missing required fields/);
    expect(() => validateRuntimeConfig(config)).toThrow(/provider/);
  });

  it('rejects pi-ai config missing model', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'pi-ai',
      provider: 'anthropic',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      timeoutMs: 300000,
      agentId: 'main',
    };

    expect(() => validateRuntimeConfig(config)).toThrow(/Missing required fields/);
    expect(() => validateRuntimeConfig(config)).toThrow(/model/);
  });

  it('rejects pi-ai config missing apiKeyEnv', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'pi-ai',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      timeoutMs: 300000,
      agentId: 'main',
    };

    expect(() => validateRuntimeConfig(config)).toThrow(/Missing required fields/);
    expect(() => validateRuntimeConfig(config)).toThrow(/apiKeyEnv/);
  });

  it('rejects non-built-in pi-ai provider without baseUrl', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'pi-ai',
      provider: 'custom-provider',
      model: 'custom-model',
      apiKeyEnv: 'CUSTOM_API_KEY',
      timeoutMs: 300000,
      agentId: 'main',
    };

    expect(() => validateRuntimeConfig(config)).toThrow(/Missing required fields/);
    expect(() => validateRuntimeConfig(config)).toThrow(/baseUrl/);
  });

  it('accepts non-built-in pi-ai provider with baseUrl', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'pi-ai',
      provider: 'custom-provider',
      model: 'custom-model',
      apiKeyEnv: 'CUSTOM_API_KEY',
      baseUrl: 'https://custom-endpoint.example.com/v1',
      timeoutMs: 300000,
      agentId: 'main',
    };

    expect(() => validateRuntimeConfig(config)).not.toThrow();
  });
});

describe('isRuntimeConfigError', () => {
  it('returns true for RuntimeConfigError', () => {
    const error: RuntimeConfigError = {
      ok: false,
      reason: 'test_reason',
      message: 'Test error message',
      nextAction: 'Test next action',
    };

    expect(isRuntimeConfigError(error)).toBe(true);
  });

  it('returns false for valid RuntimeConfig', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'pi-ai',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      timeoutMs: 300000,
      agentId: 'main',
    };

    expect(isRuntimeConfigError(config)).toBe(false);
  });

  it('returns false for openclaw-cli config', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'openclaw-cli',
      openclawMode: 'local',
      timeoutMs: 300000,
      agentId: 'main',
    };

    expect(isRuntimeConfigError(config)).toBe(false);
  });
});