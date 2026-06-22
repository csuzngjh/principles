/**
 * PainToPrincipleService unit tests.
 *
 * Tests the service's external contract via mocked bridge and observability.
 * Does NOT test PainSignalBridge internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PDRuntimeError, PD_ERROR_CATEGORIES, FAILURE_CATEGORY_MAP } from '../error-categories.js';
import type { PainSignalBridgeResult, PainDetectedData } from '../pain-signal-bridge.js';
import type { RecordPainSignalObservabilityOptions, PainSignalObservabilityResult } from '../pain-signal-observability.js';
import type { PainSignalRuntimeFactoryOptions } from '../pain-signal-runtime-factory.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

let mockBridgeResult: PainSignalBridgeResult = {
  status: 'succeeded', painId: '', taskId: '', candidateIds: [], ledgerEntryIds: [],
};
let mockBridgeError: Error | null = null;
let mockBridgeInitError: Error | null = null;
let observabilityCalled = false;
let mockObservabilityWarnings: string[] = [];
let lastPainDetectedData: PainDetectedData | null = null;
let lastFactoryOpts: PainSignalRuntimeFactoryOptions | null = null;

vi.mock('../pain-signal-runtime-factory.js', () => ({
  createPainSignalBridge: vi.fn(async (opts: PainSignalRuntimeFactoryOptions) => {
    lastFactoryOpts = opts;
    if (mockBridgeInitError) throw mockBridgeInitError;
    return {
      onPainDetected: vi.fn(async (data: PainDetectedData) => {
        lastPainDetectedData = data;
        if (mockBridgeError) throw mockBridgeError;
        return { ...mockBridgeResult, taskId: data.taskId ?? mockBridgeResult.taskId };
      }),
    };
  }),
}));

vi.mock('../pain-signal-observability.js', () => ({
  recordPainSignalObservability: vi.fn((_opts: RecordPainSignalObservabilityOptions): PainSignalObservabilityResult => {
    observabilityCalled = true;
    return { warnings: mockObservabilityWarnings };
  }),
}));

import { PainToPrincipleService } from '../pain-to-principle-service.js';
import type { PainToPrincipleServiceOptions } from '../pain-to-principle-service.js';
import type { LedgerAdapter } from '../candidate-intake.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const SUCCEEDED: PainSignalBridgeResult = {
  status: 'succeeded', painId: 'pain-001', taskId: 'diagnosis_pain-001',
  runId: 'run-001', artifactId: 'art-001', candidateIds: ['c1'], ledgerEntryIds: ['l1'],
};

function makeOpts(overrides?: Partial<PainToPrincipleServiceOptions>): PainToPrincipleServiceOptions {
  return { workspaceDir: '/tmp/ws', stateDir: '/tmp/st', ledgerAdapter: {} as LedgerAdapter, ...overrides };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PainToPrincipleService', () => {
   
  let service: PainToPrincipleService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridgeResult = { ...SUCCEEDED };
    mockBridgeError = null;
    mockBridgeInitError = null;
    observabilityCalled = false;
    mockObservabilityWarnings = [];
    lastPainDetectedData = null;
    service = new PainToPrincipleService(makeOpts());
  });

  // 1. Happy path
  it('recordPain returns succeeded with all fields', async () => {
    const r = await service.recordPain({ painId: 'pain-001', painType: 'user_frustration', source: 'manual', reason: 'test' });
    expect(r.status).toBe('succeeded');
    expect(r.painId).toBe('pain-001');
    expect(r.taskId).toBe('diagnosis_pain-001');
    expect(r.runId).toBe('run-001');
    expect(r.artifactId).toBe('art-001');
    expect(r.candidateIds).toEqual(['c1']);
    expect(r.ledgerEntryIds).toEqual(['l1']);
    expect(r.observabilityWarnings).toEqual([]);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.failureCategory).toBeUndefined();
  });

  // 1b. Full input contract: all PainDetectedData fields passed to bridge
  it('recordPain passes complete PainDetectedData to bridge', async () => {
    await service.recordPain({
      painId: 'pain-002',
      painType: 'subagent_error',
      source: 'auto',
      reason: 'timeout',
      score: 80,
      sessionId: 'sess-1',
      agentId: 'agent-1',
      taskId: 'custom-task',
      traceId: 'trace-1',
    });
    expect(lastPainDetectedData).toEqual({
      painId: 'pain-002',
      painType: 'subagent_error',
      source: 'auto',
      reason: 'timeout',
      score: 80,
      sessionId: 'sess-1',
      agentId: 'agent-1',
      taskId: 'custom-task',
      traceId: 'trace-1',
    });
  });

  // 2. Bridge returns failed with errorCategory → FAILURE_CATEGORY_MAP
  it('recordPain returns failed when bridge returns failed with errorCategory', async () => {
    mockBridgeResult = { ...SUCCEEDED, status: 'failed', errorCategory: 'timeout', candidateIds: [], ledgerEntryIds: [] };
    const r = await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });
    expect(r.status).toBe('failed');
    expect(r.failureCategory).toBe('runtime_timeout');
  });

  // 3. Idempotent: bridge returns skipped (leased)
  it('recordPain returns skipped when bridge returns skipped (idempotent leased)', async () => {
    mockBridgeResult = { status: 'skipped', painId: 'pain-001', taskId: 'diagnosis_pain-001', candidateIds: [], ledgerEntryIds: [], message: 'already leased' };
    const r = await service.recordPain({ painId: 'pain-001', painType: 'tool_failure', source: 's', reason: 'r' });
    expect(r.status).toBe('skipped');
    expect(r.failureCategory).toBeUndefined();
  });

  // 4. Idempotent: bridge returns succeeded (existing)
  it('recordPain returns succeeded when bridge returns succeeded (idempotent existing)', async () => {
    const r = await service.recordPain({ painId: 'pain-001', painType: 'tool_failure', source: 's', reason: 'r' });
    expect(r.status).toBe('succeeded');
    expect(r.candidateIds).toEqual(['c1']);
  });

  // 5. candidate_missing classification
  it('recordPain classifies candidate_missing', async () => {
    mockBridgeResult = { ...SUCCEEDED, status: 'failed', candidateIds: [], ledgerEntryIds: [], message: 'no candidates' };
    const r = await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });
    expect(r.failureCategory).toBe('candidate_missing');
  });

  // 6. ledger_write_failed classification
  it('recordPain classifies ledger_write_failed', async () => {
    mockBridgeResult = { ...SUCCEEDED, status: 'failed', candidateIds: ['c1'], ledgerEntryIds: [], message: 'no ledger' };
    const r = await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });
    expect(r.failureCategory).toBe('ledger_write_failed');
  });

  // 7. observability skip
  it('recordPain skips observability when recordObservability=false', async () => {
    await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r', recordObservability: false });
    expect(observabilityCalled).toBe(false);
  });

  // 8. observability warnings passthrough
  it('recordPain includes observability warnings', async () => {
    mockObservabilityWarnings = ['warn1', 'warn2'];
    const r = await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });
    expect(r.observabilityWarnings).toEqual(['warn1', 'warn2']);
  });

  // 9. Bridge throws PDRuntimeError
  it('recordPain catches bridge throw PDRuntimeError', async () => {
    mockBridgeError = new PDRuntimeError('storage_unavailable', 'disk full');
    const r = await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });
    expect(r.status).toBe('failed');
    expect(r.failureCategory).toBe('ledger_write_failed');
    expect(r.message).toContain('storage_unavailable');
  });

  // 10. Bridge throws generic Error
  it('recordPain catches bridge throw generic Error', async () => {
    mockBridgeError = new Error('Something timed out unexpectedly');
    const r = await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });
    expect(r.status).toBe('failed');
    expect(r.failureCategory).toBe('runtime_timeout');
  });

  // 11. latencyMs present and non-negative
  it('recordPain computes latencyMs', async () => {
    const r = await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });
    expect(typeof r.latencyMs).toBe('number');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // 12. Custom taskId passthrough
  it('recordPain uses provided taskId', async () => {
    const r = await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r', taskId: 'custom-task-123' });
    expect(r.taskId).toBe('custom-task-123');
  });

  // 13. Bridge init failure does NOT write observability
  it('recordPain does not call observability when createPainSignalBridge throws', async () => {
    mockBridgeInitError = new Error('API key not found in env');
    const r = await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });
    expect(r.status).toBe('failed');
    expect(observabilityCalled).toBe(false);
    expect(r.observabilityWarnings).toEqual([]);
    expect(r.failureCategory).toBe('config_missing');
  });

  // 14. Bridge call failure does NOT write observability
  it('recordPain does not call observability when onPainDetected throws', async () => {
    mockBridgeError = new Error('runtime crashed');
    const r = await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });
    expect(r.status).toBe('failed');
    expect(observabilityCalled).toBe(false);
    expect(r.observabilityWarnings).toEqual([]);
  });

  // 15. PRI-306 production path: effectiveConfig forwarded to createPainSignalBridge
  it('recordPain forwards effectiveConfig and getEnvVar to createPainSignalBridge', async () => {
    const mockGetEnvVar = (name: string) => name === 'MY_KEY' ? 'val' : undefined;
    const effectiveConfig: EffectivePdConfig = {
      config: {
        version: 1,
        features: {},
        runtimeProfiles: { 'oc-default': { type: 'openclaw', source: 'default' } },
        internalAgents: {
          defaultRuntime: 'oc-default',
          agents: {
            diagnostician: { enabled: true, runtimeProfile: 'oc-default' },
            dreamer: { enabled: true },
            philosopher: { enabled: true },
            scribe: { enabled: true },
            artificer: { enabled: true },
            evaluator: { enabled: true },
            rolloutReviewer: { enabled: true },
            correctionObserver: { enabled: true },
            empathyObserver: { enabled: true },
          },
        },
        ui: { diagnostics: { mode: 'simple' } },
      },
      source: 'user_config',
      warnings: [],
    };

    const svc = new PainToPrincipleService(makeOpts({ effectiveConfig, getEnvVar: mockGetEnvVar }));
    await svc.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });

    expect(lastFactoryOpts).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by not.toBeNull() above
    expect(lastFactoryOpts!.effectiveConfig).toBe(effectiveConfig);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by not.toBeNull() above
    expect(lastFactoryOpts!.getEnvVar).toBe(mockGetEnvVar);
  });

  // 16. PRI-306: without effectiveConfig, factory opts omit it (legacy path)
  it('recordPain omits effectiveConfig from factory opts when not provided', async () => {
    await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });

    expect(lastFactoryOpts).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by not.toBeNull() above
    expect(lastFactoryOpts!.effectiveConfig).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by not.toBeNull() above
    expect(lastFactoryOpts!.getEnvVar).toBeUndefined();
  });
});

// ── Parity: all 17 PDErrorCategory → FAILURE_CATEGORY_MAP ──────────────────

describe('PainToPrincipleService error classification parity', () => {
   
  let service: PainToPrincipleService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBridgeResult = { ...SUCCEEDED };
    mockBridgeError = null;
    mockBridgeInitError = null;
    observabilityCalled = false;
    mockObservabilityWarnings = [];
    lastPainDetectedData = null;
    service = new PainToPrincipleService(makeOpts());
  });

  it('classifyFromBridge maps all 17 PDErrorCategories correctly', async () => {
    for (const cat of PD_ERROR_CATEGORIES) {
      mockBridgeResult = { ...SUCCEEDED, status: 'failed', errorCategory: cat, candidateIds: ['c1'], ledgerEntryIds: ['l1'] };
      const r = await service.recordPain({ painId: 'p', painType: 'tool_failure', source: 's', reason: 'r' });
      expect(r.failureCategory).toBe(FAILURE_CATEGORY_MAP[cat]);
    }
  });
});
