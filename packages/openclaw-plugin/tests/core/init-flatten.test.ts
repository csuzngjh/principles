import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureWorkspaceTemplates } from '../../src/core/init.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('init-flatten', () => {
    const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };

    const mockApi = {
        logger: mockLogger,
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    it('should flatten core templates to workspace root and not create core subfolder', () => {
        const workspaceDir = '/mock/workspace';
        
        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString().replace(/\\/g, '/');
            // Mock that common templates don't exist to simplify
            if (pathStr.includes('templates/workspace')) return false;
            // Mock that core templates DO exist
            if (pathStr.includes('templates/langs/zh/core')) return true;
            // Mock that pain templates don't exist to simplify
            if (pathStr.includes('pain')) return false;
            return false;
        });

        vi.mocked(fs.readdirSync).mockImplementation((p) => {
            const pathStr = p.toString().replace(/\\/g, '/');
            if (pathStr.endsWith('templates/langs/zh/core')) {
                return ['AGENTS.md', 'SOUL.md'] as any;
            }
            return [] as any;
        });

        // Mock statSync to return not a directory for files
        vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as any);

        ensureWorkspaceTemplates(mockApi as any, workspaceDir, 'zh');

        // Check if copyFileSync was called for the files
        const copyCalls = vi.mocked(fs.copyFileSync).mock.calls;
        
        // It should copy AGENTS.md directly to /mock/workspace/AGENTS.md
        const agentsCall = copyCalls.find(c => c[1].toString().replace(/\\/g, '/').endsWith('/mock/workspace/AGENTS.md'));
        expect(agentsCall).toBeDefined();
        
        // It should NOT copy to /mock/workspace/core/AGENTS.md
        const wrongAgentsCall = copyCalls.find(c => c[1].toString().replace(/\\/g, '/').includes('/mock/workspace/core/'));
        expect(wrongAgentsCall).toBeUndefined();

        // Check logs
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Flattening zh core templates to workspace root'));
    });
});
