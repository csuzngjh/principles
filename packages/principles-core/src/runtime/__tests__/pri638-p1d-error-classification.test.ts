/**
 * PRI-638 P1-D — `capability_disabled` must never mask a real persistence or
 * runtime error.
 *
 * Capability state is CONTEXT, not an exception-classification override. Only
 * a DisabledDiagnosticianRunner result (errorCategory capability_missing +
 * nextAction) classifies as `capability_disabled`; a real throw (SQLite write
 * failure, state initialization failure, storage_unavailable, …) keeps its
 * own category even while the Diagnostician is disabled.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PDRuntimeError } from '../error-categories.js';
import type { PainToPrincipleServiceOptions } from '../pain-to-principle-service.js';
import type { LedgerAdapter } from '../candidate-intake.js';

let capabilityAvailable = true;
let bridgeInitError: Error | null = null;
let bridgeOnPainDetected: ((data: { painId: string }) => Promise<unknown>) | null = null;

vi.mock('../../diagnostician-capability.js', () => ({
  resolveDiagnosticianCapability: vi.fn(() =>
    capabilityAvailable
      ? { available: true }
      : {
          available: false,
          reason: 'capability_disabled',
          message: "Agent 'diagnostician' is disabled",
          nextAction: "Enable agent 'diagnostician' in .pd/config.yaml internalAgents.agents.diagnostician.enabled",
        },
  ),
}));

vi.mock('../pain-signal-runtime-factory.js', () => ({
  createPainSignalBridge: vi.fn(async () => {
    if (bridgeInitError) throw bridgeInitError;
    return {
      onPainDetected: async (data: { painId: string }) => {
        if (bridgeOnPainDetected) return bridgeOnPainDetected(data);
        return { status: 'succeeded', painId: data.painId, taskId: `diagnosis_${data.painId}`, candidateIds: [], ledgerEntryIds: [] };
      },
    };
  }),
}));

vi.mock('../pain-signal-observability.js', () => ({
  recordPainSignalObservability: vi.fn(() => ({ warnings: [] })),
}));

import { PainToPrincipleService } from '../pain-to-principle-service.js';

function makeOpts(): PainToPrincipleServiceOptions {
  return {
    workspaceDir: '/tmp/ws',
    stateDir: '/tmp/st',
    ledgerAdapter: {} as LedgerAdapter,
    effectiveConfig: undefined,
  };
}

const PAIN = {
  painId: 'pain-p1d',
  painType: 'user_frustration' as const,
  source: 'manual',
  reason: 'PRI-638 P1-D probe',
  score: 80,
  sessionId: 'p1d-session',
  agentId: 'p1d',
  evidence: [{ sourceRef: 'tool_calls:1', note: 'evidence' }],
};

describe('PRI-638 P1-D — real errors are never masked by capability_disabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capabilityAvailable = false; // Diagnostician disabled for every scenario
    bridgeInitError = null;
    bridgeOnPainDetected = null;
  });

  it('D1: disabled + task persistence throws → real storage failure classification', async () => {
    bridgeOnPainDetected = async () => {
      throw new PDRuntimeError('storage_unavailable', 'disk full');
    };
    const service = new PainToPrincipleService(makeOpts());
    const result = await service.recordPain(PAIN);

    expect(result.status).toBe('failed');
    // Real storage failure observable — NOT relabeled as the Owner kill switch.
    expect(result.failureCategory).toBe('ledger_write_failed');
    expect(result.failureCategory).not.toBe('capability_disabled');
    expect(result.message).toContain('disk full');
  });

  it('D2: disabled + bridge construction (state init) throws → actual error classification', async () => {
    bridgeInitError = new PDRuntimeError('storage_unavailable', 'state initialization failed');
    const service = new PainToPrincipleService(makeOpts());
    const result = await service.recordPain(PAIN);

    expect(result.status).toBe('failed');
    expect(result.failureCategory).toBe('ledger_write_failed');
    expect(result.failureCategory).not.toBe('capability_disabled');
  });

  it('D3: disabled + persistence succeeds + DisabledRunner result → capability_disabled', async () => {
    bridgeOnPainDetected = async () => ({
      status: 'failed' as const,
      painId: PAIN.painId,
      taskId: `diagnosis_${PAIN.painId}`,
      candidateIds: [],
      ledgerEntryIds: [],
      errorCategory: 'capability_missing' as const,
      message: "Agent 'diagnostician' is disabled",
      nextAction: "Enable agent 'diagnostician' in .pd/config.yaml internalAgents.agents.diagnostician.enabled",
    });
    const service = new PainToPrincipleService(makeOpts());
    const result = await service.recordPain(PAIN);

    expect(result.status).toBe('failed');
    expect(result.failureCategory).toBe('capability_disabled');
    expect(result.nextAction).toContain('internalAgents.agents.diagnostician.enabled');
  });

  it('D4: a generic error while disabled keeps its generic classification', async () => {
    bridgeOnPainDetected = async () => {
      throw new Error('runtime crashed');
    };
    const service = new PainToPrincipleService(makeOpts());
    const result = await service.recordPain(PAIN);

    expect(result.status).toBe('failed');
    expect(result.failureCategory).toBe('runtime_unavailable');
    expect(result.failureCategory).not.toBe('capability_disabled');
  });
});
