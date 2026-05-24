import { describe, it, expect } from 'vitest';
import { resolvePDConfig } from '../cli/pd-config-boundary.js';

describe('resolvePDConfig pure prioritization and validation', () => {
  const defaultEnv = {
    OPENAI_API_KEY: 'sk-proj-testkey',
    OPENROUTER_API_KEY: 'or-testkey',
  };

  it('resolves default test-double runtime when no inputs provided', () => {
    const res = resolvePDConfig({
      workspaceDir: '/test/workspace',
      cliOptions: {},
      envVars: defaultEnv,
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.config.workspaceDir).toBe('/test/workspace');
      expect(res.config.runtimeKind).toBe('test-double');
      expect(res.config.intake).toBe(true);
    }
  });

  it('fails loud with structured failure if workspace is missing', () => {
    const res = resolvePDConfig({
      workspaceDir: '',
      cliOptions: {},
      envVars: defaultEnv,
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.failure.error).toContain('Missing workspace directory');
      expect(res.failure.nextAction).toContain('--workspace');
    }
  });

  it('fails loud for unsupported runtime kinds', () => {
    const res = resolvePDConfig({
      workspaceDir: '/test/workspace',
      cliOptions: { runtime: 'invalid-runtime' },
      envVars: defaultEnv,
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.failure.error).toContain("Unsupported runtime kind 'invalid-runtime'");
      expect(res.failure.nextAction).toContain('test-double');
    }
  });

  it('prioritizes CLI options over fileConfig policy and defaults', () => {
    const res = resolvePDConfig({
      workspaceDir: '/test/workspace',
      cliOptions: {
        runtime: 'pi-ai',
        provider: 'cli-provider',
        model: 'cli-model',
        apiKeyEnv: 'OPENAI_API_KEY',
        timeoutMs: 1000,
      },
      envVars: defaultEnv,
      fileConfig: {
        runtimeKind: 'pi-ai',
        provider: 'file-provider',
        model: 'file-model',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        timeoutMs: 5000,
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.config.runtimeKind).toBe('pi-ai');
      expect(res.config.provider).toBe('cli-provider');
      expect(res.config.model).toBe('cli-model');
      expect(res.config.apiKeyEnv).toBe('OPENAI_API_KEY');
      expect(res.config.timeoutMs).toBe(1000);
    }
  });

  it('falls back to fileConfig when CLI options are omitted', () => {
    const res = resolvePDConfig({
      workspaceDir: '/test/workspace',
      cliOptions: {},
      envVars: defaultEnv,
      fileConfig: {
        runtimeKind: 'pi-ai',
        provider: 'file-provider',
        model: 'file-model',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        timeoutMs: 5000,
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.config.runtimeKind).toBe('pi-ai');
      expect(res.config.provider).toBe('file-provider');
      expect(res.config.model).toBe('file-model');
      expect(res.config.apiKeyEnv).toBe('OPENROUTER_API_KEY');
      expect(res.config.timeoutMs).toBe(5000);
    }
  });

  it('fails loud when required fields for pi-ai are missing', () => {
    const res = resolvePDConfig({
      workspaceDir: '/test/workspace',
      cliOptions: { runtime: 'pi-ai' },
      envVars: defaultEnv,
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.failure.error).toContain('Missing required pi-ai config');
      expect(res.failure.nextAction).toContain('--provider');
    }
  });

  it('fails loud when pi-ai key environment variable is not defined in envVars', () => {
    const res = resolvePDConfig({
      workspaceDir: '/test/workspace',
      cliOptions: {
        runtime: 'pi-ai',
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        apiKeyEnv: 'NONEXISTENT_ENV_VAR',
      },
      envVars: defaultEnv,
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.failure.error).toContain("Environment variable 'NONEXISTENT_ENV_VAR' is not set");
      expect(res.failure.nextAction).toContain("Set the environment variable 'NONEXISTENT_ENV_VAR'");
    }
  });

  it('validates openclaw-cli local and gateway exclusivity and requirements', () => {
    // 1. Neither set
    const res1 = resolvePDConfig({
      workspaceDir: '/test/workspace',
      cliOptions: { runtime: 'openclaw-cli' },
      envVars: defaultEnv,
    });
    expect(res1.success).toBe(false);
    if (!res1.success) {
      expect(res1.failure.error).toContain('--openclaw-local or --openclaw-gateway is required');
    }

    // 2. Both set
    const res2 = resolvePDConfig({
      workspaceDir: '/test/workspace',
      cliOptions: {
        runtime: 'openclaw-cli',
        openclawLocal: true,
        openclawGateway: true,
      },
      envVars: defaultEnv,
    });
    expect(res2.success).toBe(false);
    if (!res2.success) {
      expect(res2.failure.error).toContain('mutually exclusive');
    }

    // 3. One set (success)
    const res3 = resolvePDConfig({
      workspaceDir: '/test/workspace',
      cliOptions: {
        runtime: 'openclaw-cli',
        openclawLocal: true,
      },
      envVars: defaultEnv,
    });
    expect(res3.success).toBe(true);
    if (res3.success) {
      expect(res3.config.runtimeKind).toBe('openclaw-cli');
      expect(res3.config.openclawLocal).toBe(true);
      expect(res3.config.openclawGateway).toBeFalsy();
    }
  });
});
