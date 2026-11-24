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

import { PainToPrincipleService, type PainToPrincipleServiceOptions } from '../pain-to-principle-service.js';

const allowAll: SourceMaterialAuthorizationPort = {
  isHostSourceMaterialAuthorized: () => ({ authorized: true }),
};
const reader: TrajectoryTurnReader = {
  listUserTurnsForSession: () => [],
  listAssistantTurns: () => [],
};

/** The two union members, selected by the `asyncMode` discriminant. */
type SyncServiceOptions = Extract<PainToPrincipleServiceOptions, { asyncMode?: false }>;
type AsyncServiceOptions = Extract<PainToPrincipleServiceOptions, { asyncMode: true }>;

/**
 * A fully legal option set, typed as the union member itself: the compiler
 * checks every construction in this file exactly as it checks production
 * code (the core typecheck includes `__tests__`), instead of an untyped
 * `Record<string, unknown>` that hid the discriminant from the checker.
 */
function makeSyncOpts(overrides: Partial<SyncServiceOptions> = {}): SyncServiceOptions {
  return {
    workspaceDir: '/tmp/ws',
    stateDir: '/tmp/st',
    ledgerAdapter: {} as never,
    isAutoPainSubmissionAuthorized: () => true,
    asyncMode: false,
    trajectoryTurnReader: reader,
    sourceMaterialAuthorization: allowAll,
    ...overrides,
  };
}

function makeAsyncOpts(overrides: Partial<AsyncServiceOptions> = {}): AsyncServiceOptions {
  return {
    workspaceDir: '/tmp/ws',
    stateDir: '/tmp/st',
    ledgerAdapter: {} as never,
    isAutoPainSubmissionAuthorized: () => true,
    asyncMode: true,
    ...overrides,
  };
}

describe('D1 — PainToPrincipleService sync path forwards authorization + trajectory reader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastFactoryOpts = null;
  });

  it('sync mode forwards sourceMaterialAuthorization to createPainSignalBridge (identity)', async () => {
    const service = new PainToPrincipleService(makeSyncOpts());
    await service.recordPain({ painId: 'pain-001', painType: 'user_frustration', source: 'manual', reason: 'D1' });
    const factoryOpts = requireFactoryOpts(lastFactoryOpts);
    // the exact authorization instance must reach the bridge factory —
    // not a re-created deny-all fallback
    expect(factoryOpts.sourceMaterialAuthorization).toBe(allowAll);
  });

  it('sync mode forwards trajectoryTurnReader to createPainSignalBridge (identity)', async () => {
    const service = new PainToPrincipleService(makeSyncOpts());
    await service.recordPain({ painId: 'pain-002', painType: 'user_frustration', source: 'manual', reason: 'D1' });
    expect(requireFactoryOpts(lastFactoryOpts).trajectoryTurnReader).toBe(reader);
  });

  it('async mode stays legal without the sync-only collaborators', async () => {
    const service = new PainToPrincipleService(makeAsyncOpts());
    const result = await service.recordPain({ painId: 'pain-003', painType: 'user_frustration', source: 'manual', reason: 'D1' });
    // async mode returns after task persistence; the bridge factory is not
    // consulted with sync collaborators
    expect(result.status).toBe('submitted');
  });

  it('sync mode without sourceMaterialAuthorization is a compile-time contract violation (guarded by type, behavior asserted here)', async () => {
    // The discriminated union makes `{asyncMode:false}` without the two
    // collaborators a TYPE error in production code — the `@ts-expect-error`
    // below is that error, pinned: if the union ever stops rejecting the
    // omission, the directive itself fails the typecheck. At runtime the
    // service must still never invent an authorization: the factory receives
    // the reader and NO authorization (the deny-all default stays explicit
    // downstream).
    // @ts-expect-error -- deliberate: the sync union member requires sourceMaterialAuthorization (compile-time contract under test)
    const service = new PainToPrincipleService({ ...makeSyncOpts(), sourceMaterialAuthorization: undefined });
    await service.recordPain({ painId: 'pain-004', painType: 'user_frustration', source: 'manual', reason: 'D1' });
    const factoryOpts = requireFactoryOpts(lastFactoryOpts);
    expect(factoryOpts.trajectoryTurnReader).toBe(reader);
    expect(factoryOpts.sourceMaterialAuthorization).toBeUndefined();
  });
});
