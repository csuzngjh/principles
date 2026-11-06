import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateRuntimeConfig,
  isRuntimeConfigError,
  resolveRuntimeConfig,
} from '../pain-signal-runtime-factory.js';
import type { RuntimeConfig } from '../pain-signal-runtime-factory.js';
import { RuntimeKindSchema } from '../runtime-protocol.js';
import { Value } from '@sinclair/typebox/value';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// PRI-162 established the fail-loud boundary; ADR-0029 narrowed it to one
// executable backend. These tests pin that boundary: pi-ai is accepted, every
// other RuntimeKind literal is a read-only legacy fact that must never execute.
describe('Runtime Config Boundary (PRI-162, pi-ai-only per ADR-0029)', () => {
  describe('validateRuntimeConfig', () => {
    it('rejects the retired openclaw-cli kind with ADR-0029 and a nextAction', () => {
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
          expect(err.message).toContain('is not executable by PD');
          expect(err.message).toContain('ADR-0029');
          expect(err.message).toContain('nextAction');
        }
      }
    });

    it('rejects every historical enum member, not just openclaw', () => {
      // RuntimeKindSchema keeps these so persisted rows still parse; none of
      // them has (or had) a PD-side adapter reachable through this function.
      const historicalKinds = ['openclaw', 'openclaw-history', 'claude-cli', 'codex-cli', 'gemini-cli', 'local-worker'] as const;
      for (const runtimeKind of historicalKinds) {
        const config: RuntimeConfig = { runtimeKind, timeoutMs: 300_000, agentId: 'main' };
        expect(() => validateRuntimeConfig(config), runtimeKind).toThrow(/is not executable by PD/);
      }
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

    it('names .pd/config.yaml runtimeProfiles as the fix, never a host CLI backend', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'pi-ai',
        timeoutMs: 300_000,
        agentId: 'main',
        provider: 'openrouter',
      };
      try {
        validateRuntimeConfig(config);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const {message} = (err as Error);
        expect(message).toContain('nextAction');
        expect(message).toContain('runtimeProfiles');
        expect(message).not.toContain('openclaw');
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

  describe('RuntimeKindSchema read-only legacy (ADR-0029)', () => {
    // The retired literals stay in the union for ONE reason: rows already
    // written to state.db (runs.runtime_kind, leases, remediation reads) carry
    // them, and Value.Check is the read boundary for those rows. Dropping a
    // literal would make historical data unreadable — a data migration the
    // Owner explicitly ruled out. Keeping it must not make it executable,
    // which is the half the validateRuntimeConfig tests above pin.
    const historicalKinds = [
      'openclaw',
      'openclaw-cli',
      'openclaw-history',
      'claude-cli',
      'codex-cli',
      'gemini-cli',
      'local-worker',
    ];

    it.each(historicalKinds)('still parses the persisted legacy kind %s', (kind) => {
      expect(Value.Check(RuntimeKindSchema, kind)).toBe(true);
    });

    it('accepts the executable kinds', () => {
      expect(Value.Check(RuntimeKindSchema, 'pi-ai')).toBe(true);
      expect(Value.Check(RuntimeKindSchema, 'pi-ai-l2')).toBe(true);
      expect(Value.Check(RuntimeKindSchema, 'test-double')).toBe(true);
    });

    it('rejects a kind that was never part of the contract', () => {
      expect(Value.Check(RuntimeKindSchema, 'openclaw-cli-x')).toBe(false);
    });
  });

  describe('JSON failure output contract', () => {
    it('error result serializes to single parseable JSON with nextAction', () => {
      const error = { ok: false as const, reason: 'retired_runtime_kind', message: 'backend retired by ADR-0029', nextAction: 'Configure a pi-ai runtime profile' };
      const json = JSON.stringify(error);
      const parsed = JSON.parse(json);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe('retired_runtime_kind');
      expect(parsed.message).toBeTruthy();
      expect(parsed.nextAction).toBeTruthy();
    });

    it('the retired-backend resolution error is itself a parseable machine result', () => {
      const result = resolveRuntimeConfig('/nonexistent-state-dir', { requestedRuntimeKind: 'openclaw-cli' });
      expect(isRuntimeConfigError(result)).toBe(true);
      const parsed = JSON.parse(JSON.stringify(result));
      expect(parsed.reason).toBe('retired_runtime_kind');
      expect(parsed.nextAction).toBeTruthy();
    });
  });

  describe('RuntimeConfig type contract', () => {
    it('carries no openclawMode field — the retired backend had the only reader', () => {
      const config: RuntimeConfig = {
        runtimeKind: 'pi-ai',
        timeoutMs: 300_000,
        agentId: 'main',
        provider: 'openrouter',
        model: 'claude-sonnet-4',
        apiKeyEnv: 'TEST_KEY',
      };
      expect(Object.hasOwn(config, 'openclawMode')).toBe(false);
      expect(() => validateRuntimeConfig(config)).not.toThrow();
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

    it('requestedRuntimeKind=openclaw-cli returns retired_runtime_kind', () => {
      const result = resolveRuntimeConfig(tmpDir, { requestedRuntimeKind: 'openclaw-cli' });
      expect(isRuntimeConfigError(result)).toBe(true);
      if (isRuntimeConfigError(result)) {
        expect(result.reason).toBe('retired_runtime_kind');
        expect(result.message).toContain('ADR-0029');
        expect(result.nextAction).toBeTruthy();
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

    it('a legacy workflows.yaml policy that names openclaw-cli is refused, not migrated', () => {
      const wsDir = path.join(tmpDir, 'legacy-policy-ws');
      const stateDir = path.join(wsDir, '.state');
      fs.mkdirSync(stateDir, { recursive: true });
      const workflowsYaml = `version: '1'
funnels:
  - workflowId: pd-runtime-v2-diagnosis
    stages: []
    policy:
      runtimeKind: openclaw-cli
      openclawMode: local
`;
      fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), workflowsYaml);

      const result = resolveRuntimeConfig(stateDir);
      expect(isRuntimeConfigError(result)).toBe(true);
      if (isRuntimeConfigError(result)) {
        expect(result.reason).toBe('retired_runtime_kind');
        expect(result.message).toContain('workflows.yaml');
      }
    });

    it('a pi-ai workflows.yaml policy still resolves', () => {
      const wsDir = path.join(tmpDir, 'pi-ai-policy-ws');
      const stateDir = path.join(wsDir, '.state');
      fs.mkdirSync(stateDir, { recursive: true });
      const workflowsYaml = `version: '1'
funnels:
  - workflowId: pd-runtime-v2-diagnosis
    stages: []
    policy:
      runtimeKind: pi-ai
      provider: openrouter
      model: anthropic/claude-sonnet-4
      apiKeyEnv: OPENROUTER_API_KEY
`;
      fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), workflowsYaml);

      const result = resolveRuntimeConfig(stateDir);
      expect(isRuntimeConfigError(result)).toBe(false);
      if (!isRuntimeConfigError(result)) {
        expect(result.runtimeKind).toBe('pi-ai');
        expect(result.provider).toBe('openrouter');
      }
    });
  });
});
