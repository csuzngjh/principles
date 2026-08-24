import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const { mockClose, mockDeactivate, mockWriteGovernanceAction } = vi.hoisted(() => ({
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockDeactivate: vi.fn().mockResolvedValue(true),
  mockWriteGovernanceAction: vi.fn(),
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn(() => '/workspace'),
}));

vi.mock('principles-disciple/governance-audit', () => ({
  writeGovernanceAction: mockWriteGovernanceAction,
  authorizeGovernanceAction: vi.fn(async (_stateDir, _data, mutation) => mutation()),
}));

vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    RuntimeStateManager: vi.fn().mockImplementation(function () {
      return {
        initialize: vi.fn().mockResolvedValue(undefined),
        close: mockClose,
        connection: {},
      };
    }),
    SqliteActivationStateStore: vi.fn().mockImplementation(function () {
      return { deactivateActivation: mockDeactivate };
    }),
  };
});

import { handleRuntimeActivationDeactivate } from '../../src/commands/runtime-activation.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockDeactivate.mockResolvedValue(true);
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe('deactivate governance audit ordering (PRI-566)', () => {
  it('durably authorizes the canonical audit event before mutating activation state', async () => {
    const callOrder: string[] = [];
    mockWriteGovernanceAction.mockImplementation(() => { callOrder.push('audit'); });
    mockDeactivate.mockImplementation(async () => { callOrder.push('mutation'); return true; });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleRuntimeActivationDeactivate({
      workspace: '/workspace',
      activationId: 'act-566',
      reasonCode: 'owner_requested_rollback',
      json: true,
    });

    expect(callOrder).toEqual(['audit', 'mutation']);
    expect(mockWriteGovernanceAction).toHaveBeenCalledWith(path.join(path.resolve('/workspace'), '.pd'), {
      action: 'deactivate',
      activationId: 'act-566',
      actor: 'cli',
      reasonCode: 'owner_requested_rollback',
      outcome: 'authorized',
    });
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({ ok: true, activationId: 'act-566' });
    logSpy.mockRestore();
  });

  it('refuses without mutation when the audit event cannot be persisted', async () => {
    mockWriteGovernanceAction.mockImplementation(() => { throw new Error('disk full'); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleRuntimeActivationDeactivate({
      workspace: '/workspace',
      activationId: 'act-566',
      reasonCode: 'owner_requested_rollback',
      json: true,
    });

    expect(mockDeactivate).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      reason: 'governance_audit_failed: disk full',
      nextAction: expect.stringMatching(/retry/i),
    });
    logSpy.mockRestore();
  });
});
