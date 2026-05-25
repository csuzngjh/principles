import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { WorkspaceContext } from '../src/core/workspace-context.js';
import {
  resolveWorkspaceDirForRuntimeV2,
  WorkspaceResolutionError,
} from '../src/utils/workspace-resolver.js';
import { validateWorkspaceDir } from '../src/core/workspace-dir-validation.js';

const noopLogger = {
  info: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
  debug: (..._args: unknown[]) => {},
};

describe('PRI-228: Plugin config resolution cutover', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri228-'));
    WorkspaceContext.clearCache();
    delete process.env.PD_WORKSPACE_DIR;
    delete process.env.OPENCLAW_WORKSPACE;
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    WorkspaceContext.clearCache();
  });

  describe('fromHookContextExplicit: fail-loud on missing workspaceDir', () => {
    it('throws when workspaceDir is undefined', () => {
      expect(() =>
        WorkspaceContext.fromHookContextExplicit({ logger: noopLogger })
      ).toThrow(/workspace_dir_missing/);
    });

    it('throws when workspaceDir is empty string', () => {
      expect(() =>
        WorkspaceContext.fromHookContextExplicit({ workspaceDir: '', logger: noopLogger })
      ).toThrow(/workspace_dir_missing/);
    });

    it('throws when workspaceDir is whitespace-only', () => {
      expect(() =>
        WorkspaceContext.fromHookContextExplicit({ workspaceDir: '   ', logger: noopLogger })
      ).toThrow(/workspace_dir_missing/);
    });

    it('throws error with structured reason and nextAction', () => {
      try {
        WorkspaceContext.fromHookContextExplicit({ logger: noopLogger });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain('workspace_dir_missing');
        expect(msg).toContain('Runtime V2');
        expect(msg).toContain('workspaceDir');
      }
    });
  });

  describe('fromHookContextExplicit: reject dangerous paths', () => {
    it('throws when workspaceDir is home directory', () => {
      expect(() =>
        WorkspaceContext.fromHookContextExplicit({ workspaceDir: os.homedir(), logger: noopLogger })
      ).toThrow(/workspace_dir_invalid/);
    });

    it('throws when workspaceDir is root "/"', () => {
      expect(() =>
        WorkspaceContext.fromHookContextExplicit({ workspaceDir: '/', logger: noopLogger })
      ).toThrow(/workspace_dir_invalid/);
    });

    it('throws when workspaceDir is Windows drive root', () => {
      expect(() =>
        WorkspaceContext.fromHookContextExplicit({ workspaceDir: 'C:\\', logger: noopLogger })
      ).toThrow(/workspace_dir_invalid/);
    });

    it('throws when workspaceDir is home with trailing slash', () => {
      expect(() =>
        WorkspaceContext.fromHookContextExplicit({ workspaceDir: os.homedir() + '/', logger: noopLogger })
      ).toThrow(/workspace_dir_invalid/);
    });
  });

  describe('fromHookContextExplicit: succeed with valid workspaceDir', () => {
    it('creates context with explicit valid workspaceDir', () => {
      const wctx = WorkspaceContext.fromHookContextExplicit({
        workspaceDir: tmpDir,
        logger: noopLogger,
      });
      expect(wctx.workspaceDir).toBe(tmpDir);
      expect(wctx.stateDir).toBeDefined();
    });

    it('returns cached instance for same workspaceDir', () => {
      const wctx1 = WorkspaceContext.fromHookContextExplicit({
        workspaceDir: tmpDir,
        logger: noopLogger,
      });
      const wctx2 = WorkspaceContext.fromHookContextExplicit({
        workspaceDir: tmpDir,
        logger: noopLogger,
      });
      expect(wctx1).toBe(wctx2);
    });

    it('returns different instances for different workspaceDirs', () => {
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri228-alt-'));
      try {
        const wctx1 = WorkspaceContext.fromHookContextExplicit({
          workspaceDir: tmpDir,
          logger: noopLogger,
        });
        const wctx2 = WorkspaceContext.fromHookContextExplicit({
          workspaceDir: tmpDir2,
          logger: noopLogger,
        });
        expect(wctx1).not.toBe(wctx2);
        expect(wctx1.workspaceDir).toBe(tmpDir);
        expect(wctx2.workspaceDir).toBe(tmpDir2);
      } finally {
        try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch {}
      }
    });
  });

  describe('fromHookContext (legacy): still allows PathResolver fallback', () => {
    it('falls back to PathResolver when workspaceDir is missing', () => {
      process.env.PD_WORKSPACE_DIR = tmpDir;
      try {
        const wctx = WorkspaceContext.fromHookContext({ logger: noopLogger });
        expect(wctx.workspaceDir).toBeTruthy();
      } finally {
        delete process.env.PD_WORKSPACE_DIR;
      }
    });

    it('only warns (does not throw) on dangerous paths', () => {
      const warnings: string[] = [];
      const capturingLogger = {
        info: (..._args: unknown[]) => {},
        warn: (...args: unknown[]) => { warnings.push(String(args[0])); },
        error: (..._args: unknown[]) => {},
        debug: (..._args: unknown[]) => {},
      };
      const wctx = WorkspaceContext.fromHookContext({ workspaceDir: os.homedir(), logger: capturingLogger });
      expect(wctx).toBeDefined();
      expect(warnings.some(w => w.includes('LEGACY_PATH_RESOLVER_FALLBACK'))).toBe(true);
    });
  });

  describe('resolveWorkspaceDirForRuntimeV2: explicit-only resolution', () => {
    it('throws WorkspaceResolutionError when workspaceDir is missing', () => {
      expect(() =>
        resolveWorkspaceDirForRuntimeV2({}, undefined, 'test-source')
      ).toThrow(WorkspaceResolutionError);

      try {
        resolveWorkspaceDirForRuntimeV2({}, undefined, 'test-source');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceResolutionError);
        const wsErr = err as WorkspaceResolutionError;
        expect(wsErr.reason).toBe('workspace_dir_missing');
        expect(wsErr.nextAction).toContain('workspaceDir');
        expect(wsErr.toJSON()).toEqual({
          ok: false,
          reason: 'workspace_dir_missing',
          message: expect.any(String),
          nextAction: expect.any(String),
        });
      }
    });

    it('throws WorkspaceResolutionError when workspaceDir is invalid', () => {
      expect(() =>
        resolveWorkspaceDirForRuntimeV2({ workspaceDir: os.homedir() }, undefined, 'test-source')
      ).toThrow(WorkspaceResolutionError);

      try {
        resolveWorkspaceDirForRuntimeV2({ workspaceDir: os.homedir() }, undefined, 'test-source');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceResolutionError);
        expect((err as WorkspaceResolutionError).reason).toBe('workspace_dir_invalid');
      }
    });

    it('returns validated workspaceDir when explicit and valid', () => {
      const result = resolveWorkspaceDirForRuntimeV2(
        { workspaceDir: tmpDir },
        undefined,
        'test-source',
      );
      expect(result).toBe(tmpDir);
    });

    it('does NOT fall back to resolveWorkspaceDirFromApi', () => {
      const mockApi = {
        logger: noopLogger,
        runtime: {
          agent: { resolveAgentWorkspaceDir: () => tmpDir },
        },
        config: {},
      };
      expect(() =>
        resolveWorkspaceDirForRuntimeV2({}, mockApi, 'test-source')
      ).toThrow(WorkspaceResolutionError);
    });
  });

  describe('WorkspaceResolutionError: structured output', () => {
    it('toJSON returns ok:false with reason, message, nextAction', () => {
      const err = new WorkspaceResolutionError('test msg', 'test_reason', 'do something');
      const json = err.toJSON();
      expect(json.ok).toBe(false);
      expect(json.reason).toBe('test_reason');
      expect(json.message).toBe('test msg');
      expect(json.nextAction).toBe('do something');
    });

    it('is instanceof Error', () => {
      const err = new WorkspaceResolutionError('test', 'r', 'a');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('WorkspaceResolutionError');
    });
  });

  describe('validateWorkspaceDir: dangerous path detection', () => {
    it('rejects undefined', () => {
      expect(validateWorkspaceDir(undefined)).toContain('undefined');
    });

    it('rejects home directory', () => {
      expect(validateWorkspaceDir(os.homedir())).toContain('home directory');
    });

    it('rejects root "/"', () => {
      expect(validateWorkspaceDir('/')).toContain('root');
    });

    it('rejects empty string', () => {
      expect(validateWorkspaceDir('')).toBeTruthy();
    });

    it('rejects Windows drive root', () => {
      expect(validateWorkspaceDir('C:\\')).toContain('drive root');
      expect(validateWorkspaceDir('D:\\')).toContain('drive root');
    });

    it('accepts valid workspace paths', () => {
      expect(validateWorkspaceDir(tmpDir)).toBeNull();
      expect(validateWorkspaceDir('/home/user/projects/my-workspace')).toBeNull();
    });
  });

  describe('Production hooks use fromHookContextExplicit', () => {
    const hookFiles = [
      'pain.ts',
      'lifecycle.ts',
      'gate.ts',
      'subagent.ts',
      'llm.ts',
      'prompt.ts',
    ];

    for (const hookFile of hookFiles) {
      it(hookFile + ' uses fromHookContextExplicit (no legacy fromHookContext calls)', () => {
        const filePath = path.resolve(__dirname, '..', 'src', 'hooks', hookFile);
        const content = fs.readFileSync(filePath, 'utf-8');
        const legacyCalls = content.match(/fromHookContext(?!Explicit)/g) ?? [];
        expect(
          legacyCalls.length,
          hookFile + ' should not call fromHookContext (legacy) directly'
        ).toBe(0);
      });
    }
  });

  describe('Cache isolation between workspaces', () => {
    it('invalidate clears service caches without removing the instance', () => {
      const wctx = WorkspaceContext.fromHookContextExplicit({
        workspaceDir: tmpDir,
        logger: noopLogger,
      });
      const config = wctx.config;
      wctx.invalidate();
      const configAfter = wctx.config;
      expect(config).toBeDefined();
      expect(configAfter).toBeDefined();
    });

    it('dispose removes the instance from cache entirely', () => {
      const wctx1 = WorkspaceContext.fromHookContextExplicit({
        workspaceDir: tmpDir,
        logger: noopLogger,
      });
      WorkspaceContext.dispose(tmpDir);
      const wctx2 = WorkspaceContext.fromHookContextExplicit({
        workspaceDir: tmpDir,
        logger: noopLogger,
      });
      expect(wctx1).not.toBe(wctx2);
    });
  });
});