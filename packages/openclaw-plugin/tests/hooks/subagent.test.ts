import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSubagentEnded } from '../../src/hooks/subagent.js';
import * as fs from 'fs';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');

const mockEmitSync = vi.fn();
vi.mock('../../src/core/evolution-reducer.js', () => ({
  EvolutionReducerImpl: class {
    emitSync = mockEmitSync;
  },
}));

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

    it('should complete the oldest in-progress queue task using timestamp fallback', async () => {
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = {
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
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
                    { id: 'newer', status: 'in_progress', timestamp: '2026-03-17T02:00:00.000Z' },
                    { id: 'older', status: 'in_progress', timestamp: '2026-03-17T01:00:00.000Z' }
                ]);
            }
            if (pathStr.includes('.pain_flag')) {
                return 'score: 80\nstatus: queued\n';
            }
            return '';
        });

        const writeSpy = vi.mocked(fs.writeFileSync);
        const unlinkSpy = vi.mocked(fs.unlinkSync);

        await handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(writeSpy).toHaveBeenCalled();
        const [, queuePayload] = writeSpy.mock.calls.find((args) => args[0].toString().includes('evolution_queue.json'))!;
        const savedQueue = JSON.parse(queuePayload as string);
        expect(savedQueue.find((t: any) => t.id === 'older').status).toBe('completed');
        expect(savedQueue.find((t: any) => t.id === 'newer').status).toBe('in_progress');
        expect(unlinkSpy).toHaveBeenCalled();
    });

});
