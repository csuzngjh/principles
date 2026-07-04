/**
 * Task 2: Regression tests for tryUpdateRetryCount / tryUpdatePrinciple
 * silent-failure fix (rc-9-no-silent-fallback).
 *
 * Before the fix, the catch blocks in these helpers swallowed errors with
 * only a SystemLogger.log call — no structured error was recorded to
 * worker-status.json, so monitoring could not detect update failures.
 *
 * After the fix:
 *   - Errors are appended to workerStatus.errors as structured entries
 *     ({at, kind, principleId, error})
 *   - writeWorkerStatus() is called immediately to persist
 *   - SystemLogger.log records WORKER_RETRY_UPDATE_FAILED / WORKER_PRINCIPLE_UPDATE_FAILED
 *   - The worker continues (does not re-throw)
 *
 * No `as` type assertions are used in this file (rc-2-no-as-bypass).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

// Mock updatePrinciple to throw — exercises the catch block in
// tryUpdateRetryCount / tryUpdatePrinciple. Other exports (loadLedger,
// addPrincipleToLedger) remain real so the test can set up ledger state.
vi.mock('../../src/core/principle-tree-ledger.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/core/principle-tree-ledger.js')>();
    return {
        ...actual,
        updatePrinciple: vi.fn(() => {
            throw new Error('mocked update failure');
        }),
    };
});

// Mock SystemLogger.log to capture calls without file I/O side effects.
// Other SystemLogger exports (disposeSystemLogger, etc.) remain real.
vi.mock('../../src/core/system-logger.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/core/system-logger.js')>();
    return {
        ...actual,
        SystemLogger: {
            ...actual.SystemLogger,
            log: vi.fn(),
        },
    };
});

import { processCompilationBackfill, type WorkerStatusReport, type WorkerStatusErrorEntry } from '../../src/service/evolution-worker.js';
import { SystemLogger } from '../../src/core/system-logger.js';
import { addPrincipleToLedger, type LedgerPrinciple } from '../../src/core/principle-tree-ledger.js';
import type { PluginLogger } from '../../src/openclaw-sdk.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-silent-fail-'));
    tempDirs.push(dir);
    return dir;
}

function makeStateDir(workspace: string): string {
    const stateDir = path.join(workspace, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'EVOLUTION_STREAM'), '', 'utf8');
    fs.writeFileSync(path.join(stateDir, 'PRINCIPLES'), '', 'utf8');
    fs.writeFileSync(path.join(stateDir, 'evolution_queue.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(stateDir, 'ledger.json'), JSON.stringify({
        trainingStore: {},
        tree: { principles: {}, rules: {}, implementations: {}, metrics: {}, lastUpdated: new Date().toISOString() },
    }), 'utf8');
    return stateDir;
}

// Create a WorkspaceContext without `as` type assertions.
// Object.create returns `any` (per lib.d.ts), which is assignable to
// WorkspaceContext without an explicit cast. Object.assign sets the
// readonly `workspaceDir` and `stateDir` properties at runtime.
function makeWctx(workspace: string, stateDir: string): WorkspaceContext {
    const wctx: WorkspaceContext = Object.create(WorkspaceContext.prototype);
    Object.assign(wctx, { workspaceDir: workspace, stateDir });
    return wctx;
}

function makePrinciple(id: string, overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
    return {
        id,
        version: 1,
        text: `principle ${id}`,
        triggerPattern: 'test',
        action: 'test action',
        status: 'active',
        priority: 'P1',
        scope: 'general',
        evaluability: 'weak_heuristic',
        compilationRetryCount: undefined,
        ruleIds: [],
        conflictsWithPrincipleIds: [],
        derivedFromPainIds: [],
        valueScore: 0,
        adherenceRate: 0,
        painPreventedCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

function makeWorkerStatus(): WorkerStatusReport {
    return {
        timestamp: new Date().toISOString(),
        cycle_start_ms: Date.now(),
        duration_ms: 0,
        pain_flag: { exists: false, score: null, source: null, enqueued: false, skipped_reason: null },
        queue: { total: 0, pending: 0, in_progress: 0, completed_this_cycle: 0, failed_this_cycle: 0 },
        errors: [],
    };
}

const noopLogger: PluginLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

// Type guard for structured error entries (rc-2: no `as` bypass).
function isStructuredError(e: string | WorkerStatusErrorEntry): e is WorkerStatusErrorEntry {
    return typeof e === 'object' && e !== null && 'kind' in e && 'principleId' in e;
}

afterEach(() => {
    // Clear mock call history between tests (vi.mock factories persist).
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // On Windows, temp dirs may be held open — ignore cleanup errors
        }
    }
});

describe('tryUpdateRetryCount / tryUpdatePrinciple — silent failure fix (rc-9)', () => {
    it('records retry_count_update_failed to workerStatus.errors when updatePrinciple throws', () => {
        const workspace = makeTempDir();
        const stateDir = makeStateDir(workspace);

        // Pre-write marker to skip Phase 1 backfill (we only want Phase 2 retry).
        fs.writeFileSync(path.join(stateDir, 'COMPILATION_BACKFILL_DONE'), new Date().toISOString(), 'utf8');

        // Principle with count=1 — Phase 2 compile fails (no trajectory),
        // tryUpdateRetryCount called with nextCount=2, updatePrinciple throws.
        addPrincipleToLedger(stateDir, makePrinciple('P_RETRY', {
            evaluability: 'weak_heuristic',
            compilationRetryCount: 1,
        }));

        const wctx = makeWctx(workspace, stateDir);
        const workerStatus = makeWorkerStatus();

        processCompilationBackfill(wctx, noopLogger, workerStatus);

        // Assert workerStatus.errors contains a structured error entry.
        const structuredErrors = workerStatus.errors.filter(isStructuredError);
        expect(structuredErrors.length).toBeGreaterThan(0);
        const retryError = structuredErrors.find((e) => e.kind === 'retry_count_update_failed');
        expect(retryError).toBeDefined();
        expect(retryError?.principleId).toBe('P_RETRY');
        expect(retryError?.error).toContain('mocked update failure');
        expect(retryError?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        // Assert SystemLogger.log was called with WORKER_RETRY_UPDATE_FAILED.
        expect(SystemLogger.log).toHaveBeenCalledWith(
            workspace,
            'WORKER_RETRY_UPDATE_FAILED',
            expect.stringContaining('P_RETRY'),
        );

        // Assert writeWorkerStatus was called — worker-status.json should exist
        // and contain the structured error entry.
        const statusPath = path.join(stateDir, 'worker-status.json');
        expect(fs.existsSync(statusPath)).toBe(true);
        const statusContent = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        expect(Array.isArray(statusContent.errors)).toBe(true);
        const fileErrors: unknown[] = Array.isArray(statusContent.errors) ? statusContent.errors : [];
        const structuredInFile = fileErrors.filter(
            (e): e is WorkerStatusErrorEntry =>
                typeof e === 'object' && e !== null && 'kind' in e && 'principleId' in e,
        );
        expect(structuredInFile.length).toBeGreaterThan(0);
        const retryInFile = structuredInFile.find((e) => e.kind === 'retry_count_update_failed');
        expect(retryInFile?.principleId).toBe('P_RETRY');
    });

    it('records principle_update_failed when count reaches exhaustion (>=5)', () => {
        const workspace = makeTempDir();
        const stateDir = makeStateDir(workspace);

        fs.writeFileSync(path.join(stateDir, 'COMPILATION_BACKFILL_DONE'), new Date().toISOString(), 'utf8');

        // Principle at count=4 — next failure exhausts (nextCount=5),
        // tryUpdatePrinciple called with manual_only, updatePrinciple throws.
        addPrincipleToLedger(stateDir, makePrinciple('P_EXHAUST', {
            evaluability: 'weak_heuristic',
            compilationRetryCount: 4,
        }));

        const wctx = makeWctx(workspace, stateDir);
        const workerStatus = makeWorkerStatus();

        processCompilationBackfill(wctx, noopLogger, workerStatus);

        // Assert workerStatus.errors contains principle_update_failed.
        const structuredErrors = workerStatus.errors.filter(isStructuredError);
        const principleError = structuredErrors.find((e) => e.kind === 'principle_update_failed');
        expect(principleError).toBeDefined();
        expect(principleError?.principleId).toBe('P_EXHAUST');
        expect(principleError?.error).toContain('mocked update failure');

        // Assert SystemLogger.log was called with WORKER_PRINCIPLE_UPDATE_FAILED.
        expect(SystemLogger.log).toHaveBeenCalledWith(
            workspace,
            'WORKER_PRINCIPLE_UPDATE_FAILED',
            expect.stringContaining('P_EXHAUST'),
        );

        // Assert writeWorkerStatus persisted the structured error.
        const statusPath = path.join(stateDir, 'worker-status.json');
        expect(fs.existsSync(statusPath)).toBe(true);
        const statusContent = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        const fileErrors: unknown[] = Array.isArray(statusContent.errors) ? statusContent.errors : [];
        const structuredInFile = fileErrors.filter(
            (e): e is WorkerStatusErrorEntry =>
                typeof e === 'object' && e !== null && 'kind' in e && 'principleId' in e,
        );
        const principleInFile = structuredInFile.find((e) => e.kind === 'principle_update_failed');
        expect(principleInFile?.principleId).toBe('P_EXHAUST');
    });

    it('continues processing other principles after one fails (worker does not re-throw)', () => {
        const workspace = makeTempDir();
        const stateDir = makeStateDir(workspace);

        fs.writeFileSync(path.join(stateDir, 'COMPILATION_BACKFILL_DONE'), new Date().toISOString(), 'utf8');

        addPrincipleToLedger(stateDir, makePrinciple('P_A', {
            evaluability: 'weak_heuristic',
            compilationRetryCount: 1,
        }));
        addPrincipleToLedger(stateDir, makePrinciple('P_B', {
            evaluability: 'weak_heuristic',
            compilationRetryCount: 2,
        }));

        const wctx = makeWctx(workspace, stateDir);
        const workerStatus = makeWorkerStatus();

        // processCompilationBackfill is async but synchronous (no awaits).
        // If it threw after the first principle, the second's error entry
        // would not exist. Both entries existing proves the worker continued.
        processCompilationBackfill(wctx, noopLogger, workerStatus);

        const structuredErrors = workerStatus.errors.filter(isStructuredError);
        const principleIds = new Set(structuredErrors.map((e) => e.principleId));
        expect(principleIds.has('P_A')).toBe(true);
        expect(principleIds.has('P_B')).toBe(true);

        // SystemLogger.log should have been called with WORKER_RETRY_UPDATE_FAILED
        // for both principles (each principle also triggers a COMPILE_FAILED log,
        // so we check specific calls rather than total count).
        expect(SystemLogger.log).toHaveBeenCalledWith(
            workspace, 'WORKER_RETRY_UPDATE_FAILED', expect.stringContaining('P_A'),
        );
        expect(SystemLogger.log).toHaveBeenCalledWith(
            workspace, 'WORKER_RETRY_UPDATE_FAILED', expect.stringContaining('P_B'),
        );
    });
});
