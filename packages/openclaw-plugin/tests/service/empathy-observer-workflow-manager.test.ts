import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmpathyObserverWorkflowManager } from '../../src/service/subagent-workflow/empathy-observer-workflow-manager.js';
import type { SubagentWorkflowSpec } from '../../src/service/subagent-workflow/types.js';

/**
 * Helper to create a mock async function for workflow-manager tests.
 */
function mockAsyncFn<T extends (...args: any[]) => Promise<any>>(impl: (...args: any[]) => any) {
    const fn = vi.fn(impl) as unknown as T;
    Object.defineProperty(fn, 'constructor', {
        value: function AsyncFunction() {},
        writable: true,
        configurable: true,
    });
    return fn;
}

describe('EmpathyObserverWorkflowManager', () => {
    let tempDir: string;
    let manager: EmpathyObserverWorkflowManager;
    let subagent: {
        run: (...args: any[]) => Promise<{ runId: string }>;
        waitForRun: (...args: any[]) => Promise<{ status: 'ok' | 'error' | 'timeout'; error?: string }>;
        getSessionMessages: (...args: any[]) => Promise<{ messages: unknown[]; assistantTexts?: string[] }>;
        deleteSession: (...args: any[]) => Promise<void>;
    };

    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };

    const spec: SubagentWorkflowSpec<{ ok: true }> = {
        workflowType: 'empathy-observer',
        transport: 'runtime_direct',
        buildPrompt: (taskInput) => String(taskInput),
        timeoutMs: 30_000,
        ttlMs: 300_000,
        shouldDeleteSessionAfterFinalize: true,
        parseResult: async () => ({ ok: true }),
        persistResult: async () => undefined,
        shouldFinalizeOnWaitStatus: (status) => status === 'ok',
    };

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-empathy-workflow-'));
        subagent = {
            run: mockAsyncFn(async () => ({ runId: 'run-123' })),
            waitForRun: mockAsyncFn(async () => ({ status: 'ok' as const })),
            getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: ['{"ok":true}'] })),
            deleteSession: mockAsyncFn(async () => {}),
        };
        manager = new EmpathyObserverWorkflowManager({
            workspaceDir: tempDir,
            logger,
            subagent,
        });
    });

    afterEach(() => {
        manager.dispose();
        fs.rmSync(tempDir, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it('finalizes on notifyWaitResult(ok) even when workflow started from active state', async () => {
        const handle = await manager.startWorkflow(spec, {
            parentSessionId: 'parent-1',
            taskInput: 'user message',
        });

        const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
        if (timeout) {
            clearTimeout(timeout);
            (manager as any).activeWorkflows.delete(handle.workflowId);
        }

        const finalizeSpy = vi.spyOn(manager, 'finalizeOnce').mockResolvedValue();
        await manager.notifyWaitResult(handle.workflowId, 'ok');

        expect(finalizeSpy).toHaveBeenCalledWith(handle.workflowId);
    });

    it('marks workflow terminal_error when notifyWaitResult receives timeout', async () => {
        const handle = await manager.startWorkflow(spec, {
            parentSessionId: 'parent-2',
            taskInput: 'user message',
        });

        const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
        if (timeout) {
            clearTimeout(timeout);
            (manager as any).activeWorkflows.delete(handle.workflowId);
        }

        await manager.notifyWaitResult(handle.workflowId, 'timeout', 'timed out');

        const workflow = (manager as any).store.getWorkflow(handle.workflowId);
        expect(workflow?.state).toBe('terminal_error');
    });

    it('uses spec persistResult and cleanup policy during finalize', async () => {
        const persistResult = vi.fn().mockResolvedValue(undefined);
        const parseResult = vi.fn().mockResolvedValue({ ok: true });
        const customSpec: SubagentWorkflowSpec<{ ok: true }> = {
            ...spec,
            parseResult,
            persistResult,
            shouldDeleteSessionAfterFinalize: true,
        };

        const handle = await manager.startWorkflow(customSpec, {
            parentSessionId: 'parent-3',
            taskInput: 'user message',
        });

        const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
        if (timeout) {
            clearTimeout(timeout);
            (manager as any).activeWorkflows.delete(handle.workflowId);
        }

        await manager.notifyWaitResult(handle.workflowId, 'ok');

        expect(parseResult).toHaveBeenCalled();
        expect(persistResult).toHaveBeenCalledWith(expect.objectContaining({
            workspaceDir: tempDir,
            metadata: expect.objectContaining({ parentSessionId: 'parent-3' }),
        }));
        expect(subagent.deleteSession).toHaveBeenCalled();
    });

    it('produces workflow debug summary with recent events', async () => {
        const handle = await manager.startWorkflow(spec, {
            parentSessionId: 'parent-4',
            taskInput: 'user message',
        });

        const summary = await manager.getWorkflowDebugSummary(handle.workflowId);

        expect(summary).not.toBeNull();
        expect(summary?.workflowId).toBe(handle.workflowId);
        expect(summary?.transport).toBe('runtime_direct');
        expect(summary?.recentEvents.some((event) => event.eventType === 'spawned')).toBe(true);
    });

    it('uses spec.buildPrompt instead of hardcoded empathy prompt', async () => {
        const buildPrompt = vi.fn().mockReturnValue('custom workflow prompt');
        const customSpec: SubagentWorkflowSpec<{ ok: true }> = {
            ...spec,
            buildPrompt,
        };

        await manager.startWorkflow(customSpec, {
            parentSessionId: 'parent-5',
            taskInput: 'raw input',
        });

        expect(buildPrompt).toHaveBeenCalledWith(
            'raw input',
            expect.objectContaining({
                parentSessionId: 'parent-5',
                workflowType: 'empathy-observer',
            }),
        );
        expect(subagent.run).toHaveBeenCalledWith(expect.objectContaining({
            message: 'custom workflow prompt',
        }));
    });
});
