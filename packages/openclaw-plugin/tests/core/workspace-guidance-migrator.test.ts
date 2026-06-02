import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Dirent } from 'fs';
import type { OpenClawPluginApi } from '../../src/openclaw-sdk.js';

const mockFs = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
};

vi.mock('fs', () => mockFs);

const WORKSPACE_GUIDANCE_MIGRATOR_PATH = '../../src/core/workspace-guidance-migrator.js';

describe('workspace-guidance-migrator', () => {
  let migrateStaleWorkspaceGuidance: (api: OpenClawPluginApi, workspaceDir: string) => {
    migratedFiles: string[];
    skippedFiles: string[];
    errors: { file: string; error: string }[];
  };

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockApi = {
    logger: mockLogger,
  } as unknown as OpenClawPluginApi;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('');
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.readdirSync.mockReturnValue([]);

    const module = await import(WORKSPACE_GUIDANCE_MIGRATOR_PATH);
    migrateStaleWorkspaceGuidance = module.migrateStaleWorkspaceGuidance;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('migrateStaleWorkspaceGuidance', () => {
    it('skips files that do not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      expect(result.migratedFiles).toEqual([]);
      expect(result.skippedFiles).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('skips files with no stale guidance', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('# Clean AGENTS.md\nNo stale references here.');

      const result = migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      expect(result.migratedFiles).toEqual([]);
      expect(result.skippedFiles.length).toBeGreaterThan(0);
      expect(result.errors).toEqual([]);
    });

    it('migrates AGENTS.md with stale guidance', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        '# Agent Instructions\nPhysical interception ensures safety.',
      );

      const result = migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      expect(result.migratedFiles.some(f => f.includes('AGENTS.md'))).toBe(true);
      expect(result.skippedFiles.some(f => f.includes('MEMORY.md'))).toBe(true);
    });

    it('creates backup before migration', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        '# Agent Instructions\nPhysical interception ensures safety.',
      );

      migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      const backupCalls = mockFs.writeFileSync.mock.calls.filter(
        (call: unknown[]) => String(call[0]).includes('.pre-pri286.bak'),
      );
      expect(backupCalls.length).toBeGreaterThan(0);
    });

    it('logs migration progress', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        '# Agent Instructions\nPhysical interception ensures safety.',
      );

      migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('[PD:GuidanceMigration]'),
      );
    });

    it('handles read errors gracefully', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('Failed to read file content');
    });

    it('handles write errors and restores original', () => {
      const originalContent = '# Agent Instructions\nPhysical interception ensures safety.';
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(originalContent);

      let callCount = 0;
      mockFs.writeFileSync.mockImplementation((path: string, content: string) => {
        callCount++;
        if (path.includes('.pre-pri286.bak')) return;
        if (callCount === 2) {
          expect(content).toBe(originalContent);
          return;
        }
        throw new Error('Write error');
      });

      const result = migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      expect(result.errors.length).toBeGreaterThan(0);
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('skips non-guidance files', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('# Random Content\nNo guidance here.');

      const result = migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      expect(result.migratedFiles).toEqual([]);
    });

    it('discovers skill files in .principles/skills directory', () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        if (String(p).includes('.principles/skills')) return true;
        return false;
      });
      mockFs.readdirSync.mockReturnValue([
        { isDirectory: () => true, name: 'admin' },
        { isDirectory: () => true, name: 'reflection' },
      ] as Dirent[]);
      mockFs.readFileSync.mockReturnValue(
        'Ensure `PLAN.md` contains `## Target Files` heading.',
      );

      const result = migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      expect(result.migratedFiles.length).toBeGreaterThan(0);
    });

    it('handles empty workspace directory', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      expect(result.migratedFiles).toEqual([]);
      expect(result.skippedFiles).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('handles skills directory read error gracefully', () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        if (String(p).includes('.principles/skills')) return true;
        return false;
      });
      mockFs.readdirSync.mockImplementation(() => {
        throw new Error('Directory read error');
      });
      mockFs.readFileSync.mockReturnValue(
        '# Agent Instructions\nPhysical interception ensures safety.',
      );

      const result = migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
