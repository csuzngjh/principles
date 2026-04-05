import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TrinityRuntimeAdapter } from '../../core/nocturnal-trinity.js';

// Mock dependencies
vi.mock('../../src/service/nocturnal-service.js', () => ({
    executeNocturnalReflectionAsync: vi.fn(),
}));

vi.mock('../../core/nocturnal-paths.js', () => ({
    NocturnalPathResolver: {
        samplePath: vi.fn((workspaceDir: string, sampleId: string) =>
            `${workspaceDir}/.state/nocturnal/samples/${sampleId}.json`
        ),
        resolveNocturnalDir: vi.fn((workspaceDir: string, _type: string) =>
            `${workspaceDir}/.state/nocturnal/samples`
        ),
    },
}));

import { NocturnalWorkflowManager, nocturnalWorkflowSpec } from '../../src/service/subagent-workflow/nocturnal-workflow-manager.js';
import { executeNocturnalReflectionAsync } from '../../src/service/nocturnal-service.js';
import type { NocturnalRunResult } from '../../src/service/nocturnal-service.js';

const mockExecuteNocturnalReflectionAsync = executeNocturnalReflectionAsync as ReturnType<typeof vi.fn>;

describe('NocturnalWorkflowManager', () => {
    let manager: NocturnalWorkflowManager;
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const mockRuntimeAdapter = {} as TrinityRuntimeAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        manager = new NocturnalWorkflowManager({
            workspaceDir: '/tmp/test-workspace',
            stateDir: '/tmp/test-workspace/.state',
            logger: mockLogger as any,
            runtimeAdapter: mockRuntimeAdapter,
        });
    });

    afterEach(() => {
        manager.dispose();
    });

    describe('NOC-01: WorkflowManager interface', () => {
        it('implements all WorkflowManager interface methods (7 methods)', () => {
            expect(typeof manager.startWorkflow).toBe('function');
            expect(typeof manager.notifyWaitResult).toBe('function');
            expect(typeof manager.notifyLifecycleEvent).toBe('function');
            expect(typeof manager.finalizeOnce).toBe('function');
            expect(typeof manager.sweepExpiredWorkflows).toBe('function');
            expect(typeof manager.getWorkflowDebugSummary).toBe('function');
            expect(typeof manager.dispose).toBe('function');
        });

        it('implements WorkflowManager type', () => {
            // Type check: NocturnalWorkflowManager should be assignable to WorkflowManager
            const _wm: import('../../src/service/subagent-workflow/types.js').WorkflowManager = manager;
            expect(true).toBe(true);
        });
    });

    describe('NOC-02: Single-reflector path (useTrinity=false)', () => {
        it('calls executeNocturnalReflectionAsync with useTrinity=false', async () => {
            const mockResult: NocturnalRunResult = {
                success: false,
                noTargetSelected: true,
                skipReason: 'no_signals',
                validationFailed: false,
                validationFailures: [],
                diagnostics: {} as any,
            };
            mockExecuteNocturnalReflectionAsync.mockResolvedValue(mockResult);

            await manager.startWorkflow(nocturnalWorkflowSpec, {
                parentSessionId: 'session-123',
                taskInput: {},
            });

            expect(mockExecuteNocturnalReflectionAsync).toHaveBeenCalledWith(
                '/tmp/test-workspace',
                '/tmp/test-workspace/.state',
                expect.objectContaining({
                    trinityConfig: expect.objectContaining({ useTrinity: false }),
                })
            );
        });
    });

    describe('NOC-03: WorkflowStore event recording', () => {
        it('starts workflow and calls executeNocturnalReflectionAsync', async () => {
            const mockResult: NocturnalRunResult = {
                success: false,
                noTargetSelected: true,
                skipReason: 'no_signals',
                validationFailed: false,
                validationFailures: [],
                diagnostics: {} as any,
            };
            mockExecuteNocturnalReflectionAsync.mockResolvedValue(mockResult);

            await manager.startWorkflow(nocturnalWorkflowSpec, {
                parentSessionId: 'session-123',
                taskInput: {},
            });

            // Verify logger.info was called (workflow started)
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Starting workflow')
            );
            // Verify executeNocturnalReflectionAsync was called
            expect(mockExecuteNocturnalReflectionAsync).toHaveBeenCalled();
        });
    });

    describe('NOC-04: NocturnalWorkflowSpec definition', () => {
        it('has workflowType=nocturnal', () => {
            expect(nocturnalWorkflowSpec.workflowType).toBe('nocturnal');
        });

        it('has transport=runtime_direct', () => {
            expect(nocturnalWorkflowSpec.transport).toBe('runtime_direct');
        });

        it('has shouldDeleteSessionAfterFinalize=false', () => {
            expect(nocturnalWorkflowSpec.shouldDeleteSessionAfterFinalize).toBe(false);
        });

        it('has timeoutMs=900000 (15 minutes)', () => {
            expect(nocturnalWorkflowSpec.timeoutMs).toBe(15 * 60 * 1000);
        });

        it('has ttlMs=1800000 (30 minutes)', () => {
            expect(nocturnalWorkflowSpec.ttlMs).toBe(30 * 60 * 1000);
        });

        it('buildPrompt returns empty string', () => {
            expect(nocturnalWorkflowSpec.buildPrompt({}, {} as any)).toBe('');
        });
    });

    describe('NOC-05: sweepExpiredWorkflows', () => {
        it('sweepExpiredWorkflows is a function', () => {
            expect(typeof manager.sweepExpiredWorkflows).toBe('function');
        });
    });

    describe('notifyWaitResult is no-op (D-10)', () => {
        it('notifyWaitResult does not throw', async () => {
            await expect(manager.notifyWaitResult('wf_123', 'ok')).resolves.not.toThrow();
            await expect(manager.notifyWaitResult('wf_123', 'error', 'test error')).resolves.not.toThrow();
            await expect(manager.notifyWaitResult('wf_123', 'timeout')).resolves.not.toThrow();
        });
    });

    describe('notifyLifecycleEvent is no-op (D-10)', () => {
        it('notifyLifecycleEvent does not throw for subagent_spawned', async () => {
            await expect(manager.notifyLifecycleEvent('wf_123', 'subagent_spawned')).resolves.not.toThrow();
        });

        it('notifyLifecycleEvent does not throw for subagent_ended', async () => {
            await expect(manager.notifyLifecycleEvent('wf_123', 'subagent_ended', { data: 'test' })).resolves.not.toThrow();
        });
    });
});
