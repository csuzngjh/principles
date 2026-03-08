import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureWorkspaceTemplates, ensureStateTemplates } from '../../src/core/init.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('init', () => {
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

    describe('ensureStateTemplates', () => {
        it('should create stateDir if it does not exist', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            ensureStateTemplates({ logger: mockLogger }, '/mock/state');

            expect(fs.mkdirSync).toHaveBeenCalledWith('/mock/state', { recursive: true });
        });

        it('should not create stateDir if it already exists', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);

            ensureStateTemplates({ logger: mockLogger }, '/mock/state');

            expect(fs.mkdirSync).not.toHaveBeenCalled();
        });

        it('should copy pain_settings.json if missing', () => {
            let existsPaths = new Set<string>();
            
            vi.mocked(fs.existsSync).mockImplementation((p) => {
                const pathStr = p.toString();
                const normalizedPath = pathStr.replace(/\\/g, '/');
                // Template exists, but destination does not
                if (normalizedPath.includes('templates/pain_settings.json')) return true;
                if (normalizedPath.endsWith('pain_settings.json')) return false;
                if (normalizedPath.endsWith('stateDir')) return false;
                return existsPaths.has(pathStr);
            });

            ensureStateTemplates({ logger: mockLogger }, '/mock/state');

            expect(fs.copyFileSync).toHaveBeenCalled();
        });

        it('should not copy pain_settings.json if already exists', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);

            ensureStateTemplates({ logger: mockLogger }, '/mock/state');

            // Should not copy since files already exist
            expect(fs.copyFileSync).not.toHaveBeenCalled();
        });

        it('should log error on failure', () => {
            vi.mocked(fs.existsSync).mockImplementation(() => {
                throw new Error('Test error');
            });

            ensureStateTemplates({ logger: mockLogger }, '/mock/state');

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to initialize state templates')
            );
        });

        it('should use language-specific dictionary template', () => {
            const stateDir = '/mock/state';
            
            vi.mocked(fs.existsSync).mockImplementation((p) => {
                const pathStr = p.toString();
                const normalizedPath = pathStr.replace(/\\/g, '/');
                // State dir exists
                if (normalizedPath === stateDir) return true;
                // pain_settings.json template exists
                if (normalizedPath.includes('templates/pain_settings.json')) return true;
                // zh-CN dictionary template exists
                if (normalizedPath.includes('templates/langs/zh-CN/pain_dictionary.json')) return true;
                // Destination files don't exist
                if (normalizedPath.endsWith('pain_settings.json')) return false;
                if (normalizedPath.endsWith('pain_dictionary.json')) return false;
                return false;
            });

            ensureStateTemplates({ logger: mockLogger }, stateDir, 'zh-CN');

            const copyCalls = vi.mocked(fs.copyFileSync).mock.calls;
            const dictCall = copyCalls.find(c => c[1].toString().endsWith('pain_dictionary.json'));
            expect(dictCall).toBeDefined();
            const dictSrcPath = dictCall?.[0].toString().replace(/\\/g, '/');
            expect(dictSrcPath).toContain('zh-CN');
        });

        it('should copy en dictionary as fallback when language-specific not found', () => {
            const stateDir = '/mock/state';
            
            // Return true for most template checks, but destination files don't exist
            vi.mocked(fs.existsSync).mockImplementation((p) => {
                const pathStr = p.toString();
                const normalizedPath = pathStr.replace(/\\/g, '/');
                // stateDir exists
                if (normalizedPath === stateDir) return true;
                // Template files exist
                if (normalizedPath.includes('templates')) return true;
                // Destination files don't exist (force copy)
                return false;
            });

            ensureStateTemplates({ logger: mockLogger }, stateDir, 'zh-CN');

            // Verify dictionary was copied
            const copyCalls = vi.mocked(fs.copyFileSync).mock.calls;
            const dictCall = copyCalls.find(c => c[1].toString().endsWith('pain_dictionary.json'));
            expect(dictCall).toBeDefined();
        });
    });

    describe('ensureWorkspaceTemplates', () => {
        it('should handle missing common templates directory', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            ensureWorkspaceTemplates(mockApi as any, '/mock/workspace');

            // Should not throw, just skip
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('should log error on failure', () => {
            vi.mocked(fs.existsSync).mockImplementation(() => {
                throw new Error('Test error');
            });

            ensureWorkspaceTemplates(mockApi as any, '/mock/workspace');

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to initialize workspace templates')
            );
        });
    });
});
