import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSubagentEnded } from '../../src/hooks/subagent.js';
import * as fs from 'fs';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');

const mockEmitSync = vi.fn();

describe('Subagent Hook', () => {
    const workspaceDir = '/mock/workspace';

    const mockTrust = {
        recordSuccess: vi.fn(),
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
        trust: mockTrust,
        config: mockConfig,
        evolutionReducer: { emitSync: mockEmitSync },
        resolve: vi.fn().mockImplementation((key) => {
            if (key === 'EVOLUTION_QUEUE') return '/mock/workspace/.state/evolution_queue.json';
            if (key === 'PAIN_FLAG') return '/mock/workspace/.state/.pain_flag';
            return '';
        }),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockEmitSync.mockReset();
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    });

    it('should record success on successful subagent completion', async () => {
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = { 
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'ok' 
        };

        vi.mocked(fs.existsSync).mockReturnValue(false);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(mockTrust.recordSuccess).toHaveBeenCalledWith(
            'subagent_success',
            expect.objectContaining({ sessionId: 's1' }),
            true
        );
    });

    it('should NOT record success on failure', async () => {
        const mockCtx = { workspaceDir };
        const mockEvent = { 
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'error' 
        };

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(mockTrust.recordSuccess).not.toHaveBeenCalled();
        expect(mockEmitSync).toHaveBeenCalledWith(expect.objectContaining({
            type: 'pain_detected',
            data: expect.objectContaining({
                painType: 'subagent_error',
            }),
        }));
    });



    it('should emit pain_detected for timeout outcome', async () => {
        const mockCtx = { workspaceDir, sessionId: 's3' };
        const mockEvent = {
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'timeout'
        };

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(mockEmitSync).toHaveBeenCalledWith(expect.objectContaining({
            type: 'pain_detected',
            data: expect.objectContaining({
                painType: 'subagent_error',
                source: 'subagent_timeout',
                sessionId: 's3',
            }),
        }));
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

});
