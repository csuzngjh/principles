import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { migrateDirectoryStructure } from '../../src/core/migration.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('Directory Structure Migration', () => {
    const workspaceDir = '/mock/workspace';
    const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
    const mockApi = { logger: mockLogger } as any;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should move files from docs/ to new locations', () => {
        const legacyProfile = path.join(workspaceDir, 'docs', 'PROFILE.json');
        const newProfile = path.join(workspaceDir, '.principles', 'PROFILE.json');
        const legacyPlan = path.join(workspaceDir, 'docs', 'PLAN.md');
        const newPlan = path.join(workspaceDir, 'PLAN.md');

        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString();
            if (pathStr === path.join(workspaceDir, 'docs')) return true;
            if (pathStr === legacyProfile) return true;
            if (pathStr === legacyPlan) return true;
            // Destination directories don't exist yet
            if (pathStr === path.join(workspaceDir, '.principles')) return false;
            // Destination files don't exist yet
            if (pathStr === newProfile) return false;
            if (pathStr === newPlan) return false;
            return false;
        });

        migrateDirectoryStructure(mockApi, workspaceDir);

        // Verify it tried to create .principles/
        expect(fs.mkdirSync).toHaveBeenCalledWith(path.join(workspaceDir, '.principles'), expect.anything());

        // Verify it moved PROFILE.json
        expect(fs.renameSync).toHaveBeenCalledWith(legacyProfile, newProfile);

        // Verify it moved PLAN.md to root
        expect(fs.renameSync).toHaveBeenCalledWith(legacyPlan, newPlan);

        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Successfully migrated'));
    });

    it('should not overwrite existing files at destination', () => {
        const legacyProfile = path.join(workspaceDir, 'docs', 'PROFILE.json');
        const newProfile = path.join(workspaceDir, '.principles', 'PROFILE.json');

        vi.mocked(fs.existsSync).mockImplementation((p) => {
            const pathStr = p.toString();
            if (pathStr === path.join(workspaceDir, 'docs')) return true;
            if (pathStr === legacyProfile) return true;
            if (pathStr === newProfile) return true; // DESTINATION EXISTS
            return false;
        });

        migrateDirectoryStructure(mockApi, workspaceDir);

        expect(fs.renameSync).not.toHaveBeenCalledWith(legacyProfile, newProfile);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('already exists at destination'));
    });
});
