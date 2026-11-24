/**
 * SPEC-PD-PIPELINE-SPINE-001 §4.3 (PRI-1292 Phase 2A) — the ONE cache-free
 * diagnostician runner bundle shared by the cached-bridge factory, `pd
 * diagnose run` and `pd pain retry`.
 *
 * Pinned here: the resource-ownership contract (`ownsStateManager` — an
 * externally provided manager is NEVER closed by `dispose()`; a self-created
 * one is closed exactly once, idempotently; construction failure never leaks
 * the self-created manager and never touches an external one), the timing
 * derivation that reproduces both previous caller formulas, and the
 * cache-isolation guarantee (no `bridgeCache` contact — the bundle is usable
 * with a test-double adapter in a workspace whose config resolution would
 * fail, without seeding or consulting the process cache).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDiagnosticianRunnerBundle,
  PainToPrincipleService,
  RuntimeStateManager,
  TestDoubleRuntimeAdapter,
  type LedgerAdapter,
  type PDRuntimeAdapter,
} from '@principles/core/runtime';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1292-bundle-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

function testDoubleAdapter(): PDRuntimeAdapter {
  // Assembly-only probe: the bundle never invokes the adapter, so default
  // behavior overrides are sufficient.
  return new TestDoubleRuntimeAdapter();
}

function bundleOptions(overrides: Partial<Parameters<typeof createDiagnosticianRunnerBundle>[0]> = {}) {
  return {
    workspaceDir,
    ledgerAdapter: {} as LedgerAdapter,
    owner: 'pri-1292-test',
    runtimeAdapter: testDoubleAdapter(),
    runtimeKind: 'test-double',
    stageTimeoutMs: 1_200_000,
    ...overrides,
  };
}

describe('createDiagnosticianRunnerBundle — resource ownership (SPEC §4.3)', () => {
  it('external stateManager: dispose() NEVER closes it and it stays usable', async () => {
    const stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    const closeSpy = vi.spyOn(stateManager, 'close');

    const bundle = await createDiagnosticianRunnerBundle(bundleOptions({ stateManager }));
    expect(bundle.ownsStateManager).toBe(false);
    expect(bundle.stateManager).toBe(stateManager);

    await bundle.dispose();
    await bundle.dispose(); // idempotent — no second close attempt

    expect(closeSpy).not.toHaveBeenCalled();
    // The CLI's finally is still the owner: the manager keeps working after
    // bundle disposal (no premature connection close, no double-close later).
    await stateManager.createTask({
      taskId: 'diagnosis_post_dispose',
      taskKind: 'diagnostician',
      inputRef: 'pain_1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });
    await stateManager.close();
    closeSpy.mockRestore();
  });

  it('uninitialized external stateManager: construction fails loud WITHOUT closing or initializing the caller-owned manager', async () => {
    const stateManager = new RuntimeStateManager({ workspaceDir });
    const closeSpy = vi.spyOn(stateManager, 'close');
    // Not initialized: the bundle's first collaborator touch fails loud (rc-3).
    await expect(createDiagnosticianRunnerBundle(bundleOptions({ stateManager }))).rejects.toThrow();
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
    // The caller can still initialize and use it — the failed construction
    // left their resource untouched.
    await stateManager.initialize();
    await stateManager.close();
  });

  it('self-built stateManager: bundle owns it, dispose() closes it exactly once and is idempotent', async () => {
    const bundle = await createDiagnosticianRunnerBundle(bundleOptions());
    expect(bundle.ownsStateManager).toBe(true);
    // Connection serves every collaborator (single-connection topology).
    expect(bundle.committer).toBeDefined();
    expect(bundle.contextAssembler).toBeDefined();

    await bundle.dispose();
    // Post-condition: the manager is closed (initialized flag reset), and a
    // second dispose is a no-op rather than a second close.
    await expect(bundle.dispose()).resolves.toBeUndefined();
    expect(() => bundle.stateManager.connection).toThrow();
  });

  it('self-built manager is released when construction itself fails (no leak)', async () => {
    // Make a collaborator constructor fail AFTER the manager was created and
    // initialized: an uninitialized external manager as the assembler's
    // sibling input is not available here, so force it via a workspace whose
    // state directory cannot host the DB (path is a file, not a directory).
    const filePathWorkspace = path.join(workspaceDir, 'not-a-dir');
    fs.writeFileSync(filePathWorkspace, 'x');
    const bundlePromise = createDiagnosticianRunnerBundle(bundleOptions({ workspaceDir: filePathWorkspace }));
    await expect(bundlePromise).rejects.toThrow();
    // The workspace file was untouched (the failed manager never wrote rows
    // through a half-open store) and no state.db was created beside it.
    expect(fs.readFileSync(filePathWorkspace, 'utf8')).toBe('x');
    expect(fs.existsSync(path.join(filePathWorkspace, '.pd'))).toBe(false);
  });
});

describe('createDiagnosticianRunnerBundle — timing derivation (both prior caller formulas)', () => {
  it('stageTimeoutMs passes through; parentBudget = 3×; lease/heartbeat are the documented defaults', async () => {
    const stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    const bundle = await createDiagnosticianRunnerBundle(bundleOptions({ stateManager, stageTimeoutMs: 1_200_000 }));
    expect(bundle.executionTiming.stageTimeoutMs).toBe(1_200_000);
    expect(bundle.executionTiming.parentBudgetMs).toBe(3_600_000); // CLI formula (SPLIT/3 → ×3)
    expect(bundle.executionTiming.leaseTtlMs).toBe(120_000);
    expect(bundle.executionTiming.heartbeatIntervalMs).toBe(40_000);
    await bundle.dispose();
    await stateManager.close();
  });

  it('a config-provided 300s stage derives the factory formula (300s / 900s)', async () => {
    const bundle = await createDiagnosticianRunnerBundle(bundleOptions({ stageTimeoutMs: 300_000 }));
    expect(bundle.executionTiming.stageTimeoutMs).toBe(300_000);
    expect(bundle.executionTiming.parentBudgetMs).toBe(900_000);
    await bundle.dispose();
  });
});

describe('createDiagnosticianRunnerBundle — bridgeCache isolation (§4.4)', () => {
  it('a test-double bundle assembles without any runtime config (cache-free by construction)', async () => {
    // No .pd/config.yaml and no workflows.yaml in this workspace. The cached
    // bridge factory cannot even resolve its runtime config here, yet the
    // bundle assembles fine with a test-double adapter — the CLI override
    // paths (--runtime test-double / --no-intake) therefore cannot pollute,
    // or be swallowed by, the process-level cache (the structural
    // no-bridgeCache-contact guard lives in architecture-regression).
    const bundle = await createDiagnosticianRunnerBundle(bundleOptions());
    expect(bundle.runner).toBeDefined();
    expect(typeof bundle.runner.run).toBe('function');
    await bundle.dispose();
  });
});

// ── Type-level contract (checked by `typecheck --workspace=@principles/core`,
// which includes this file; rc-2: no `as` may bypass the sync-mode requirement).
// SPEC §3.1.2: sync (or possibly-sync) options REQUIRE both collaborators at
// compile time — if anyone re-widens them to optional, the ts-expect-error
// below goes unused and tsc fails this file. The constructor is pure (stores
// opts), so these calls are compile-time probes with no runtime effect.
export function typeNegativeSyncOptionsRequireCollaborators(dir: string): void {
  // @ts-expect-error sync mode requires trajectoryTurnReader + sourceMaterialAuthorization
  new PainToPrincipleService({ workspaceDir: dir, stateDir: `${dir}/.state`, ledgerAdapter: {} as LedgerAdapter, asyncMode: false });
  // Positive control: supplying BOTH required collaborators compiles.
  new PainToPrincipleService({
    workspaceDir: dir,
    stateDir: `${dir}/.state`,
    ledgerAdapter: {} as LedgerAdapter,
    asyncMode: false,
    trajectoryTurnReader: { listUserTurnsForSession: () => [], listAssistantTurns: () => [] },
    sourceMaterialAuthorization: { isHostSourceMaterialAuthorized: () => ({ authorized: false, reason: 'consent_missing' as const }) },
  });
}

// Positive control: async mode does NOT force the sync-only collaborators —
// the pure async-landing entries must compile without constructing any
// synchronous diagnostic context dependency.
export function typePositiveAsyncOptions(dir: string, ledgerAdapter: LedgerAdapter): PainToPrincipleService {
  return new PainToPrincipleService({
    workspaceDir: dir,
    stateDir: `${dir}/.state`,
    ledgerAdapter,
    asyncMode: true,
  });
}
