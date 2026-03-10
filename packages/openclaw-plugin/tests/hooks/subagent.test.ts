import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSubagentEnded } from '../../src/hooks/subagent.js';
import * as fs from 'fs';
import * as path from 'path';
import * as trustEngine from '../../src/core/trust-engine.js';

vi.mock('fs');
vi.mock('../../src/core/trust-engine.js');

describe('Subagent Hook', () => {
    const workspaceDir = '/mock/workspace';

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should increment trust score on successful subagent completion', () => {
        const mockCtx = { workspaceDir, sessionId: 's1' };
        const mockEvent = { 
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'ok' 
        };

        // Mock queue cleanup to avoid errors
        vi.mocked(fs.existsSync).mockReturnValue(false);

        handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(trustEngine.adjustTrustScore).toHaveBeenCalledWith(
            workspaceDir, 
            expect.any(Number), 
            expect.stringContaining('subagent:'),
            expect.objectContaining({ sessionId: 's1' })
        );
    });

    it('should NOT increment trust score on failure', () => {
        const mockCtx = { workspaceDir };
        const mockEvent = { 
            targetSessionKey: 'agent:main:subagent:diagnostician-123',
            outcome: 'error' 
        };

        handleSubagentEnded(mockEvent as any, mockCtx as any);

        expect(trustEngine.adjustTrustScore).not.toHaveBeenCalledWith(
            workspaceDir, 
            expect.any(Number), 
            expect.any(String),
            expect.any(Object)
        );
    });
});
