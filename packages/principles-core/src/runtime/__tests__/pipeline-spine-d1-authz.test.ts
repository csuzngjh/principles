/**
 * D1 authorization pass-through tests — SPEC-PD-PIPELINE-SPINE-001 v0.9
 * §3.2/§4.2 (PRI-1291 Phase 1A red-first).
 *
 * D1 (verified at origin/main): `PainToPrincipleServiceOptions` has no
 * `sourceMaterialAuthorization`, so the SYNC path's `createPainSignalBridge`
 * call never forwards one — every downstream stage silently falls back to
 * `denyAllSourceMaterialAuthorization` and filters already-authorized
 * governance material as unauthorized.
 *
 * These cases pin the contract the SPEC fixes: in sync mode the service must
 * accept and forward BOTH `sourceMaterialAuthorization` and
 * `trajectoryTurnReader` to the bridge factory (identity-preserving); async
 * mode keeps them optional.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PainSignalRuntimeFactoryOptions } from '../pain-signal-runtime-factory.js';

function requireFactoryOpts(opts: PainSignalRuntimeFactoryOptions | null): PainSignalRuntimeFactoryOptions {
  if (opts === null) throw new Error('createPainSignalBridge was not consulted by the sync path');
  return opts;
}
import type { TrajectoryTurnReader } from '../store/context/trajectory-turn-reader.js';
import type { SourceMaterialAuthorizationPort } from '../source-material-authorization.js';

let lastFactoryOpts: PainSignalRuntimeFactoryOptions | null = null;

vi.mock('../pain-signal-runtime-factory.js', () => ({
  createPainSignalBridge: vi.fn(async (opts: PainSignalRuntimeFactoryOptions) => {
    lastFactoryOpts = opts;
    return {
      onPainDetected: vi.fn(async () => ({ status: 'succeeded', painId: 'pain-001', taskId: 'diagnosis_pain-001' })),
    };
  }),
}));

vi.mock('../store/runtime-state-manager.js', () => ({
  RuntimeStateManager: class {
    initialize = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    createTask = vi.fn(async () => undefined);
  },
}));

vi.mock('../pain-signal-observability.js', () => ({
  recordPainSignalObservability: vi.fn(() => ({ warnings: [] })),
}));

import { PainToPrincipleService } from '../pain-to-principle-service.js';

const allowAll: SourceMaterialAuthorizationPort = {
  isHostSourceMaterialAuthorized: () => ({ authorized: true }),
};
const reader: TrajectoryTurnReader = {
  listUserTurnsForSession: () => [],
  listAssistantTurns: () => [],
};

function makeOpts(overrides?: Record<string, unknown>) {
  return {
    workspaceDir: '/tmp/ws',
    stateDir: '/tmp/st',
    ledgerAdapter: {} as never,
    isAutoPainSubmissionAuthorized: () => true,
    ...overrides,
  };
}

describe('D1 — PainToPrincipleService sync path forwards authorization + trajectory reader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastFactoryOpts = null;
  });

  it('sync mode forwards sourceMaterialAuthorization to createPainSignalBridge (identity)', async () => {
    const service = new PainToPrincipleService(makeOpts({
      asyncMode: false,
      sourceMaterialAuthorization: allowAll,
      trajectoryTurnReader: reader,
    }));
    await service.recordPain({ painId: 'pain-001', painType: 'user_frustration', source: 'manual', reason: 'D1' });
    const factoryOpts = requireFactoryOpts(lastFactoryOpts);
    // the exact authorization instance must reach the bridge factory —
    // not a re-created deny-all fallback
    expect(factoryOpts.sourceMaterialAuthorization).toBe(allowAll);
  });

  it('sync mode forwards trajectoryTurnReader to createPainSignalBridge (identity)', async () => {
    const service = new PainToPrincipleService(makeOpts({
      asyncMode: false,
      sourceMaterialAuthorization: allowAll,
      trajectoryTurnReader: reader,
    }));
    await service.recordPain({ painId: 'pain-002', painType: 'user_frustration', source: 'manual', reason: 'D1' });
    expect(requireFactoryOpts(lastFactoryOpts).trajectoryTurnReader).toBe(reader);
  });

  it('async mode stays legal without the sync-only collaborators', async () => {
    const service = new PainToPrincipleService(makeOpts({ asyncMode: true }));
    const result = await service.recordPain({ painId: 'pain-003', painType: 'user_frustration', source: 'manual', reason: 'D1' });
    // async mode returns after task persistence; the bridge factory is not
    // consulted with sync collaborators
    expect(result.status).toBe('submitted');
  });

  it('sync mode without sourceMaterialAuthorization is a compile-time contract violation (guarded by type, behavior asserted here)', async () => {
    // The discriminated union makes `{asyncMode:false}` without the two
    // collaborators a TYPE error in production code. At runtime the service
    // must still never silently pretend an authorization exists: when only
    // the reader is provided the factory receives the reader and NO
    // authorization (the deny-all default stays explicit downstream).
    const service = new PainToPrincipleService(makeOpts({
      asyncMode: false,
      trajectoryTurnReader: reader,
      // deliberately omitting sourceMaterialAuthorization mirrors the
      // pre-fix state of the three sync entry points
    }));
    await service.recordPain({ painId: 'pain-004', painType: 'user_frustration', source: 'manual', reason: 'D1' });
    const factoryOpts = requireFactoryOpts(lastFactoryOpts);
    expect(factoryOpts.trajectoryTurnReader).toBe(reader);
    expect(factoryOpts.sourceMaterialAuthorization).toBeUndefined();
  });
});
