import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSubagentEnded } from '../../src/hooks/subagent.js';
import * as fs from 'fs';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as evolutionWorker from '../../src/service/evolution-worker.js';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');
vi.mock('../../src/service/evolution-worker.js', () => ({
    acquireQueueLock: vi.fn(async () => () => undefined),
}));

const mockEmitSync = vi.fn();

describe('Subagent Hook', () => {
    const workspaceDir = '/mock/workspace';

const mockTrajectory = {
    recordTaskOutcome: vi.fn(),
};

    const mockConfig = {
        get: vi.fn().mockImplementation((key) => {
            if (key === 'scores') return {
                subagent_error_penalty: 80,
                subagent_timeout_penalty: 65
            };
            return {};
        })
    };

    const mockWctx = {
        workspaceDir,
        config: mockConfig,
        evolutionReducer: { emitSync: mockEmitSync },
        trajectory: mockTrajectory,
        resolve: vi.fn().mockImplementation((key) => {
            if (key === 'EVOLUTION_QUEUE') return '/mock/workspace/.state/evolution_queue.json';
            if (key === 'PAIN_FLAG') return '/mock/workspace/.state/.pain_flag';
            return '';
        }),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        mockEmitSync.mockReset();
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should record success on successful subagent completion', async () => {
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = { 
            targetSessionKey: 'agent:main:subagent:worker-123',
            outcome: 'ok' 
        };

        vi.mocked(fs.existsSync).mockReturnValue(false);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(mockTrajectory.recordTaskOutcome).not.toHaveBeenCalled();
    });

    it('should NOT record success on failure', async () => {
        const mockCtx = { workspaceDir };
        const mockEvent = { 
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'error' 
        };

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(mockEmitSync).toHaveBeenCalledWith(expect.objectContaining({
            type: 'pain_detected',
            data: expect.objectContaining({
                painType: 'subagent_error',
            }),
        }));
    });

    it('should NOT emit pain_detected for timeout outcome (OpenClaw fix applied)', async () => {
        // OpenClaw v2026.3.23 fix: recheck timed-out worker waits against latest runtime snapshot
        // Fast-finishing workers should not be incorrectly reported as timed out
        // Therefore, timeout outcomes should NOT trigger pain penalties
        const mockCtx = { workspaceDir, sessionId: 's3' };
        const mockEvent = {
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'timeout'
        };

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        // Timeout should NOT trigger pain_detected event
        expect(mockEmitSync).not.toHaveBeenCalled();
    });

    it('should NOT emit pain_detected for killed outcome (user-initiated termination)', async () => {
        // Killed outcome indicates user explicitly terminated the subagent
        // This is not an agent failure - should not trigger pain penalties
        const mockCtx = { workspaceDir, sessionId: 's4' };
        const mockEvent = {
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'killed'
        };

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(mockEmitSync).not.toHaveBeenCalled();
    });

    it('should NOT emit pain_detected for reset outcome (system reset)', async () => {
        const mockCtx = { workspaceDir, sessionId: 's5' };
        const mockEvent = {
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'reset'
        };

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(mockEmitSync).not.toHaveBeenCalled();
    });

    it('should match HEARTBEAT placeholder task for diagnostician session', async () => {
        // HEARTBEAT-triggered tasks have placeholder assigned_session_key like "heartbeat:diagnostician:{taskId}"
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = {
            targetSessionKey: 'agent:diagnostician:session-123',
            outcome: 'ok'
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString();
            return pathStr.includes('evolution_queue.json') || pathStr.includes('.pain_flag');
        });

        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            const pathStr = p.toString();
            if (pathStr.includes('evolution_queue.json')) {
                return JSON.stringify([
                    { id: 'task-heartbeat', status: 'in_progress', assigned_session_key: 'heartbeat:diagnostician:task-heartbeat', started_at: new Date().toISOString() }
                ]);
            }
            if (pathStr.includes('.pain_flag')) {
                return 'score: 80\nstatus: queued\ntask_id: task-heartbeat\n';
            }
            return '';
        });

        const writeSpy = vi.mocked(fs.writeFileSync);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(writeSpy).toHaveBeenCalled();
        const [, queuePayload] = writeSpy.mock.calls.find((args) => args[0].toString().includes('evolution_queue.json'))!;
        const savedQueue = JSON.parse(queuePayload as string);
        expect(savedQueue.find((t: any) => t.id === 'task-heartbeat').status).toBe('completed');
    });

    it('should not emit pain_detected for successful subagent completion', async () => {
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = {
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'ok'
        };

        vi.mocked(fs.existsSync).mockReturnValue(false);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(mockEmitSync).not.toHaveBeenCalled();
    });

    it('should complete only the matching assigned diagnostician task and clean the linked pain flag', async () => {
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = {
            targetSessionKey: 'agent:diagnostician:session-123',
            outcome: 'ok'
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString();
            return pathStr.includes('evolution_queue.json') || pathStr.includes('.pain_flag');
        });

        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            const pathStr = p.toString();
            if (pathStr.includes('evolution_queue.json')) {
                return JSON.stringify([
                    { id: 'task-a', status: 'in_progress', assigned_session_key: 'agent:diagnostician:other' },
                    { id: 'task-b', status: 'in_progress', assigned_session_key: 'agent:diagnostician:session-123' }
                ]);
            }
            if (pathStr.includes('.pain_flag')) {
                return 'score: 80\nstatus: queued\ntask_id: task-b\n';
            }
            return '';
        });

        const writeSpy = vi.mocked(fs.writeFileSync);
        const unlinkSpy = vi.mocked(fs.unlinkSync);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(writeSpy).toHaveBeenCalled();
        const [, queuePayload] = writeSpy.mock.calls.find((args) => args[0].toString().includes('evolution_queue.json'))!;
        const savedQueue = JSON.parse(queuePayload as string);
        expect(savedQueue.find((t: any) => t.id === 'task-b').status).toBe('completed');
        expect(savedQueue.find((t: any) => t.id === 'task-a').status).toBe('in_progress');
        expect(unlinkSpy).toHaveBeenCalled();
        expect(mockTrajectory.recordTaskOutcome).toHaveBeenCalledWith({
            sessionId: 'agent:diagnostician:session-123',
            taskId: 'task-b',
            outcome: 'ok',
            summary: 'Diagnostician session agent:diagnostician:session-123 completed evolution task task-b.',
        });
    });

    it('should not record a task outcome for unrelated subagent completions', async () => {
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = {
            targetSessionKey: 'agent:main:subagent:worker-123',
            outcome: 'ok'
        };

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(mockTrajectory.recordTaskOutcome).not.toHaveBeenCalled();
    });

    it('should not complete an unrelated in-progress task without a matching assigned session key', async () => {
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = {
            targetSessionKey: 'agent:diagnostician:session-123',
            outcome: 'ok'
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString();
            return pathStr.includes('evolution_queue.json') || pathStr.includes('.pain_flag');
        });

        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            const pathStr = p.toString();
            if (pathStr.includes('evolution_queue.json')) {
                return JSON.stringify([
                    { id: 'task-a', status: 'in_progress', assigned_session_key: 'agent:diagnostician:other' },
                    { id: 'task-b', status: 'pending' }
                ]);
            }
            if (pathStr.includes('.pain_flag')) {
                return 'score: 80\nstatus: queued\ntask_id: task-a\n';
            }
            return '';
        });

        const writeSpy = vi.mocked(fs.writeFileSync);
        const unlinkSpy = vi.mocked(fs.unlinkSync);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(writeSpy.mock.calls.some((args) => args[0].toString().includes('evolution_queue.json'))).toBe(false);
        expect(unlinkSpy.mock.calls.some((args) => args[0].toString().includes('.pain_flag'))).toBe(false);
    });

    it('should retry diagnostician completion after transient queue lock failure', async () => {
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = {
            targetSessionKey: 'agent:diagnostician:session-123',
            outcome: 'ok'
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString();
            return pathStr.includes('evolution_queue.json') || pathStr.includes('.pain_flag');
        });

        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            const pathStr = p.toString();
            if (pathStr.includes('evolution_queue.json')) {
                return JSON.stringify([
                    { id: 'task-b', status: 'in_progress', assigned_session_key: 'agent:diagnostician:session-123' }
                ]);
            }
            if (pathStr.includes('.pain_flag')) {
                return 'score: 80\nstatus: queued\ntask_id: task-b\n';
            }
            return '';
        });

        vi.mocked(evolutionWorker.acquireQueueLock)
            .mockRejectedValueOnce(new Error('lock busy'))
            .mockResolvedValue(async () => () => undefined as any);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);
        await vi.advanceTimersByTimeAsync(300);

        const writeSpy = vi.mocked(fs.writeFileSync);
        expect(writeSpy.mock.calls.some((args) => args[0].toString().includes('evolution_queue.json'))).toBe(true);
    });

    it('should retry task outcome persistence independently after queue completion succeeds', async () => {
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = {
            targetSessionKey: 'agent:diagnostician:session-123',
            outcome: 'ok'
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString();
            return pathStr.includes('evolution_queue.json') || pathStr.includes('.pain_flag');
        });

        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            const pathStr = p.toString();
            if (pathStr.includes('evolution_queue.json')) {
                return JSON.stringify([
                    { id: 'task-b', status: 'in_progress', assigned_session_key: 'agent:diagnostician:session-123' }
                ]);
            }
            if (pathStr.includes('.pain_flag')) {
                return 'score: 80\nstatus: queued\ntask_id: task-b\n';
            }
            return '';
        });

        mockTrajectory.recordTaskOutcome
            .mockImplementationOnce(() => {
                throw new Error('trajectory busy');
            })
            .mockImplementation(() => undefined);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);
        await vi.advanceTimersByTimeAsync(300);

        const writeSpy = vi.mocked(fs.writeFileSync);
        expect(writeSpy.mock.calls.some((args) => args[0].toString().includes('evolution_queue.json'))).toBe(true);
        expect(mockTrajectory.recordTaskOutcome).toHaveBeenCalledTimes(2);
        expect(mockTrajectory.recordTaskOutcome).toHaveBeenLastCalledWith({
            sessionId: 'agent:diagnostician:session-123',
            taskId: 'task-b',
            outcome: 'ok',
            summary: 'Diagnostician session agent:diagnostician:session-123 completed evolution task task-b.',
        });
    });

    // ── P0-2: Precise HEARTBEAT matching ──

    it('should match HEARTBEAT task by EXACT task ID extracted from placeholder', async () => {
        // P0-2: Extract task ID from "heartbeat:diagnostician:{taskId}" and match precisely.
        // Two concurrent tasks with different IDs should NOT cross-match.
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = {
            targetSessionKey: 'agent:diagnostician:session-456',
            outcome: 'ok'
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString();
            return pathStr.includes('evolution_queue.json') || pathStr.includes('.pain_flag');
        });

        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            const pathStr = p.toString();
            if (pathStr.includes('evolution_queue.json')) {
                return JSON.stringify([
                    { id: 'task-correct', status: 'in_progress', assigned_session_key: 'heartbeat:diagnostician:task-correct', started_at: new Date().toISOString() },
                    { id: 'task-wrong', status: 'in_progress', assigned_session_key: 'heartbeat:diagnostician:task-wrong', started_at: new Date().toISOString() }
                ]);
            }
            if (pathStr.includes('.pain_flag')) {
                return 'score: 50\nstatus: queued\ntask_id: task-correct\n';
            }
            return '';
        });

        const writeSpy = vi.mocked(fs.writeFileSync);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(writeSpy).toHaveBeenCalled();
        const [, queuePayload] = writeSpy.mock.calls.find((args) => args[0].toString().includes('evolution_queue.json'))!;
        const savedQueue = JSON.parse(queuePayload as string);
        expect(savedQueue.find((t: any) => t.id === 'task-correct').status).toBe('completed');
        expect(savedQueue.find((t: any) => t.id === 'task-wrong').status).toBe('in_progress');
    });

    it('should NOT match HEARTBEAT task when task ID does NOT match', async () => {
        // P0-2: Two concurrent diagnostician sessions should NOT cross-match.
        // Session "unrelated" does not match either task's ID in the placeholder.
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = {
            targetSessionKey: 'agent:diagnostician:session-unrelated',
            outcome: 'ok'
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString();
            return pathStr.includes('evolution_queue.json');
        });

        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            const pathStr = p.toString();
            if (pathStr.includes('evolution_queue.json')) {
                return JSON.stringify([
                    { id: 'task-A', status: 'in_progress', assigned_session_key: 'heartbeat:diagnostician:task-A', started_at: new Date().toISOString() },
                    { id: 'task-B', status: 'in_progress', assigned_session_key: 'heartbeat:diagnostician:task-B', started_at: new Date().toISOString() }
                ]);
            }
            return '';
        });

        const writeSpy = vi.mocked(fs.writeFileSync);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        // No task should be matched — session-unrelated doesn't match either placeholder
        expect(writeSpy).not.toHaveBeenCalled();
    });

    // ── P0-4: Safe pain flag cleanup ──

    it('should NOT delete pain flag when task_id does NOT match completed task', async () => {
        // P0-4: Prevent race condition where a new pain flag gets deleted by old task completion.
        // The pain flag file now has task_id for a DIFFERENT task (simulates race).
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = {
            targetSessionKey: 'agent:diagnostician:session-old',
            outcome: 'ok'
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString();
            return pathStr.includes('evolution_queue.json') || pathStr.includes('.pain_flag');
        });

        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            const pathStr = p.toString();
            if (pathStr.includes('evolution_queue.json')) {
                return JSON.stringify([
                    { id: 'task-old', status: 'in_progress', assigned_session_key: 'agent:diagnostician:session-old', started_at: new Date().toISOString() }
                ]);
            }
            if (pathStr.includes('.pain_flag')) {
                // This pain flag belongs to a DIFFERENT task (new signal written during race window)
                return 'score: 80\nstatus: queued\ntask_id: task-new\n';
            }
            return '';
        });

        const writeSpy = vi.mocked(fs.writeFileSync);
        const appendSpy = vi.mocked(fs.appendFileSync);
        const unlinkSpy = vi.mocked(fs.unlinkSync);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        // Pain flag should NOT be modified — task_id mismatch protects the new signal
        expect(appendSpy).not.toHaveBeenCalled();
        expect(unlinkSpy).not.toHaveBeenCalled();
        // Queue should still be written (task completion)
        expect(writeSpy).toHaveBeenCalled();
    });
});
