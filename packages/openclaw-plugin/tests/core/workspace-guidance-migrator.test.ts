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

// Mock heavy core module to avoid slow re-imports and to control staleness detection
const mockMigrateWorkspaceGuidance = vi.fn<(content: string, relativePath: string) => { changed: boolean; migrated: string }>();
const mockContainsStalePlanMdGuidance = vi.fn<(content: string, relativePath: string) => boolean>();

vi.mock('@principles/core/runtime-v2', () => ({
  migrateWorkspaceGuidance: (...args: unknown[]) => mockMigrateWorkspaceGuidance(...(args as [string, string])),
  containsStalePlanMdGuidance: (...args: unknown[]) => mockContainsStalePlanMdGuidance(...(args as [string, string])),
}));

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

    // Default: content is NOT stale
    mockContainsStalePlanMdGuidance.mockReturnValue(false);
    mockMigrateWorkspaceGuidance.mockImplementation((content: string) => ({
      changed: false,
      migrated: content,
    }));

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
      // Default: containsStalePlanMdGuidance returns false

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
      // First call (AGENTS.md) is stale, second (MEMORY.md) is not
      mockContainsStalePlanMdGuidance
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);
      mockMigrateWorkspaceGuidance.mockImplementation((content: string) => ({
        changed: true,
        migrated: content.replace('Physical interception', 'MIGRATED'),
      }));

      const result = migrateStaleWorkspaceGuidance(mockApi, '/workspace');

      expect(result.migratedFiles.some(f => f.includes('AGENTS.md'))).toBe(true);
      expect(result.skippedFiles.some(f => f.includes('MEMORY.md'))).toBe(true);
    });

    it('creates backup before migration', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        '# Agent Instructions\nPhysical interception ensures safety.',
      );
      mockContainsStalePlanMdGuidance.mockReturnValue(true);
      mockMigrateWorkspaceGuidance.mockImplementation((content: string) => ({
        changed: true,
        migrated: content.replace('Physical interception', 'MIGRATED'),
      }));

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
      mockContainsStalePlanMdGuidance.mockReturnValue(true);
      mockMigrateWorkspaceGuidance.mockImplementation((content: string) => ({
        changed: true,
        migrated: content.replace('Physical interception', 'MIGRATED'),
      }));

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
      mockContainsStalePlanMdGuidance.mockReturnValue(true);
      mockMigrateWorkspaceGuidance.mockImplementation((content: string) => ({
        changed: true,
        migrated: content.replace('Physical interception', 'MIGRATED'),
      }));

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
      const skillsPattern = path.join('.principles', 'skills');
      mockFs.existsSync.mockImplementation((p: string) => {
        if (String(p).includes(skillsPattern)) return true;
        return false;
      });
      mockFs.readdirSync.mockReturnValue([
        { isDirectory: () => true, name: 'admin' },
        { isDirectory: () => true, name: 'reflection' },
      ] as Dirent[]);
      mockFs.readFileSync.mockReturnValue(
        'Ensure `PLAN.md` contains `## Target Files` heading.',
      );
      mockContainsStalePlanMdGuidance.mockReturnValue(true);
      mockMigrateWorkspaceGuidance.mockImplementation((content: string) => ({
        changed: true,
        migrated: content.replace('## Target Files', '## Targets'),
      }));

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
      const skillsPattern = path.join('.principles', 'skills');
      mockFs.existsSync.mockImplementation((p: string) => {
        if (String(p).includes(skillsPattern)) return true;
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
