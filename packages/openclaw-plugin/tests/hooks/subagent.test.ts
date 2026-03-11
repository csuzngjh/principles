import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSubagentEnded } from '../../src/hooks/subagent.js';
import * as fs from 'fs';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');

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
    });
});
