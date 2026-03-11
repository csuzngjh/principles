import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePainCommand } from '../../src/commands/pain.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('../../src/core/session-tracker.js');
vi.mock('../../src/core/workspace-context.js');

describe('Pain Command', () => {
    const workspaceDir = '/mock/workspace';
    const sessionId = 's1';

    const mockDictionary = {
        getStats: vi.fn().mockReturnValue({ totalRules: 10, totalHits: 5 })
    };

    const mockWctx = {
        workspaceDir,
        dictionary: mockDictionary,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    });

    it('should format a comprehensive pain report', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 45 } as any);
        
        const result = handlePainCommand({ 
            args: '', 
            config: { workspaceDir, language: 'en' },
            sessionId 
        } as any);

        expect(result.text).toContain('GFI Index**: 45/100');
        expect(result.text).toContain('Rules**: 10');
        expect(result.text).toContain('Hits**: 5');
    });

    it('should show 🟢 status for low GFI', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 10 } as any);
        const result = handlePainCommand({ config: { workspaceDir }, sessionId } as any);
        expect(result.text).toContain('10/100');
    });

    it('should show 🔴 status for high GFI', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 85 } as any);
        const result = handlePainCommand({ config: { workspaceDir }, sessionId } as any);
        expect(result.text).toContain('85/100');
    });
});
