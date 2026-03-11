import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSubagentEnded } from '../../src/hooks/subagent.js';
import * as fs from 'fs';
import * as path from 'path';
import * as trustEngine from '../../src/core/trust-engine-v2.js';

vi.mock('fs');
vi.mock('../../src/core/trust-engine-v2.js');

describe('Subagent Hook', () => {
    const workspaceDir = '/mock/workspace';

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should record success on successful subagent completion', () => {
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = { 
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'ok' 
        };

        // Mock queue cleanup to avoid errors
        vi.mocked(fs.existsSync).mockReturnValue(false);

        handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(trustEngine.recordSuccess).toHaveBeenCalledWith(
            workspaceDir, 
            'subagent_success',
            expect.objectContaining({ sessionId: 's1' })
        );
    });

    it('should NOT record success on failure', () => {
        const mockCtx = { workspaceDir };
        const mockEvent = { 
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'error' 
        };

        handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(trustEngine.recordSuccess).not.toHaveBeenCalled();
    });
});
