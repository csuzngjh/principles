import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureWorkspaceTemplates } from '../../src/core/init.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('init - Directory Refactor', () => {
    const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };

    const mockApi = {
        logger: mockLogger,
    } as any;

    // Use path.resolve for cross-platform compatibility
    const workspaceDir = path.resolve('/mock/workspace');

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    it('should copy files to new directory structure (.principles and .state)', () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString();
            // Source templates exist
            if (pathStr.includes('templates')) return true;
            // Destination does not exist (force creation)
            return false;
        });

        // Mock readdirSync for template directories
        vi.mocked(fs.readdirSync).mockImplementation((p) => {
            const pathStr = p.toString();
            // Only return items for the main workspace templates directory
            const isWorkspaceTemplates = pathStr.includes('templates') && 
                                          pathStr.includes('workspace') && 
                                          !pathStr.includes('.principles') && 
                                          !pathStr.includes('.state');
            if (isWorkspaceTemplates) {
                return ['.principles', '.state', 'PLAN.md'] as any;
            }
            if (pathStr.includes('.principles')) return ['PROFILE.json', 'PRINCIPLES.md'] as any;
            if (pathStr.includes('.state')) return ['WORKBOARD.json'] as any;
            if (pathStr.includes('core')) return ['AGENTS.md', 'SOUL.md'] as any;
            return [] as any;
        });

        vi.mocked(fs.statSync).mockImplementation((p) => {
            const pathStr = p.toString();
            // Precisely match directory names - must end with .principles or .state
            // Use regex that handles both forward and backward slashes
            const isDir = /[\\\/]\.principles$/.test(pathStr) || /[\\\/]\.state$/.test(pathStr);
            return {
                isDirectory: () => isDir
            } as any;
        });

        vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);

        ensureWorkspaceTemplates(mockApi, workspaceDir);

        // Verify that it tried to create the new hidden directories
        expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.principles'), expect.anything());
        expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.state'), expect.anything());

        // Verify that PLAN.md is copied to root
        expect(fs.copyFileSync).toHaveBeenCalledWith(
            expect.stringMatching(/PLAN\.md$/),
            path.join(workspaceDir, 'PLAN.md')
        );

        // Verify that PROFILE.json is copied to .principles
        expect(fs.copyFileSync).toHaveBeenCalledWith(
            expect.stringMatching(/PROFILE\.json$/),
            path.join(workspaceDir, '.principles', 'PROFILE.json')
        );
    });
});
