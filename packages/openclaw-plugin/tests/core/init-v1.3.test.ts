import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureWorkspaceTemplates } from '../../src/core/init.js';
import * as fs from 'fs';

vi.mock('fs');

describe('init v1.3 - simplified', () => {
    const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('ensureWorkspaceTemplates - pain_memory', () => {
        it('should attempt to create the pain memory directory', () => {
            const workspaceDir = '/mock/workspace';
            
            // Allow EVERYTHING to exist to avoid bail-outs
            vi.mocked(fs.existsSync).mockReturnValue(true);
            // EXCEPT for the final pain directory, so we trigger mkdir
            vi.mocked(fs.existsSync).mockImplementation((p) => {
                const pathStr = p.toString();
                if (pathStr.includes('memory') || pathStr.includes('pain')) {
                    if (pathStr.includes('templates')) return true; // Source templates exist
                    return false; // Destination doesn't
                }
                return true;
            });

            vi.mocked(fs.readdirSync).mockReturnValue([] as any);

            ensureWorkspaceTemplates({ logger: mockLogger } as any, workspaceDir, 'zh');

            // Find if any mkdirSync call included 'pain'
            const mkdirCalls = vi.mocked(fs.mkdirSync).mock.calls;
            const hasPain = mkdirCalls.some(args => args[0].toString().includes('pain'));
            
            expect(hasPain).toBe(true);
        });
    });
});
