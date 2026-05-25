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
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* already removed */ }
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

    it('rejects /tmp/.. which normalizes to root "/"', () => {
      expect(() =>
        WorkspaceContext.fromHookContextExplicit({ workspaceDir: '/tmp/..', logger: noopLogger })
      ).toThrow(/workspace_dir_invalid/);
    });

    it('rejects /tmp/../.. which normalizes to root "/"', () => {
      expect(() =>
        WorkspaceContext.fromHookContextExplicit({ workspaceDir: '/tmp/../..', logger: noopLogger })
      ).toThrow(/workspace_dir_invalid/);
    });

    it('rejects home subpath traversal that normalizes to home', () => {
      expect(() =>
        WorkspaceContext.fromHookContextExplicit({ workspaceDir: os.homedir() + '/subdir/..', logger: noopLogger })
      ).toThrow(/workspace_dir_invalid/);
    });

    it('rejects path with repeated separators that normalizes to root', () => {
      expect(() =>
        WorkspaceContext.fromHookContextExplicit({ workspaceDir: '/foo/../bar/../..', logger: noopLogger })
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
  });

  describe('fromHookContext (legacy): safe degradation for host enhancement hooks', () => {
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

    it('returns normalized workspaceDir when explicit and valid', () => {
      const result = resolveWorkspaceDirForRuntimeV2(
        { workspaceDir: tmpDir },
        undefined,
        'test-source',
      );
      expect(path.resolve(tmpDir)).toBe(result);
    });

    it('rejects /tmp/.. which normalizes to root', () => {
      expect(() =>
        resolveWorkspaceDirForRuntimeV2({ workspaceDir: '/tmp/..' }, undefined, 'test-source')
      ).toThrow(WorkspaceResolutionError);
    });

    it('rejects home subpath traversal that normalizes to home', () => {
      expect(() =>
        resolveWorkspaceDirForRuntimeV2({ workspaceDir: os.homedir() + '/subdir/..' }, undefined, 'test-source')
      ).toThrow(WorkspaceResolutionError);
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

  describe('Hook classification: only pain.ts is Runtime V2', () => {
    it('pain.ts uses fromHookContextExplicit (Runtime V2 entrypoint)', () => {
      const filePath = path.resolve(__dirname, '..', 'src', 'hooks', 'pain.ts');
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('fromHookContextExplicit');
      expect(content).toContain('resolveWorkspaceDirForRuntimeV2');
    });

    const hostEnhancementHooks = [
      'prompt.ts',
      'lifecycle.ts',
      'gate.ts',
      'subagent.ts',
      'llm.ts',
    ];

    for (const hookFile of hostEnhancementHooks) {
      it(hookFile + ' uses fromHookContext (host enhancement — safe degradation)', () => {
        const filePath = path.resolve(__dirname, '..', 'src', 'hooks', hookFile);
        const content = fs.readFileSync(filePath, 'utf-8');
        const explicitCalls = content.match(/fromHookContextExplicit/g) ?? [];
        expect(
          explicitCalls.length,
          hookFile + ' should NOT use fromHookContextExplicit — it is a host enhancement hook'
        ).toBe(0);
      });
    }
  });

  describe('resolveWorkspaceDirForRuntimeV2 has production caller', () => {
    it('pain.ts calls resolveWorkspaceDirForRuntimeV2', () => {
      const filePath = path.resolve(__dirname, '..', 'src', 'hooks', 'pain.ts');
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('resolveWorkspaceDirForRuntimeV2');
      const callMatch = content.match(/resolveWorkspaceDirForRuntimeV2\(/g) ?? [];
      expect(callMatch.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Prompt hook safe degradation', () => {
    it('prompt.ts returns early when workspaceDir is missing (does not throw)', () => {
      const filePath = path.resolve(__dirname, '..', 'src', 'hooks', 'prompt.ts');
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain("if (!workspaceDir)");
      expect(content).toContain("skipping PD context injection");
      expect(content).toContain("return;");
    });

    it('prompt.ts uses fromHookContext (not fromHookContextExplicit)', () => {
      const filePath = path.resolve(__dirname, '..', 'src', 'hooks', 'prompt.ts');
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('fromHookContext(ctx)');
      const explicitCalls = content.match(/fromHookContextExplicit/g) ?? [];
      expect(explicitCalls.length).toBe(0);
    });
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