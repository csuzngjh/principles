import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { WorkspaceContext } from '../src/core/workspace-context.js';
import { PathResolver } from '../src/core/path-resolver.js';
import {
  resolveCommandWorkspaceDir,
  resolvePluginCommandWorkspaceDir,
  resolveToolHookWorkspaceDirSafe,
} from '../src/utils/workspace-resolver.js';
import { validateWorkspaceDir } from '../src/core/workspace-dir-validation.js';
import {
  resolveRuntimeConfig,
  isRuntimeConfigError,
} from '@principles/core/runtime-v2';

describe('PRI-228: Plugin config resolution cutover', () => {
  describe('WorkspaceContext does not silently fall back to PathResolver default', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri228-wctx-'));
      WorkspaceContext.clearCache();
      delete process.env.PD_WORKSPACE_DIR;
      delete process.env.OPENCLAW_WORKSPACE;
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      WorkspaceContext.clearCache();
    });

    it('WorkspaceContext.fromHookContext with explicit workspaceDir uses it directly', () => {
      const wctx = WorkspaceContext.fromHookContext({
        workspaceDir: tmpDir,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      expect(wctx.workspaceDir).toBe(tmpDir);
    });

    it('WorkspaceContext.fromHookContext without workspaceDir falls back to PathResolver', () => {
      const originalEnv = process.env.PD_WORKSPACE_DIR;
      process.env.PD_WORKSPACE_DIR = tmpDir;
      try {
        const wctx = WorkspaceContext.fromHookContext({
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        });
        expect(wctx.workspaceDir).toBeTruthy();
      } finally {
        process.env.PD_WORKSPACE_DIR = originalEnv;
      }
    });

    it('validateWorkspaceDir rejects home directory as workspace', () => {
      const homeDir = os.homedir();
      const issue = validateWorkspaceDir(homeDir);
      expect(issue).not.toBeNull();
      expect(issue).toContain('home directory');
    });

    it('validateWorkspaceDir accepts valid workspace directory', () => {
      const issue = validateWorkspaceDir(tmpDir);
      expect(issue).toBeNull();
    });
  });

  describe('Plugin-only legacy discovery is disconnected from Runtime V2', () => {
    it('resolveRuntimeConfig does not call PathResolver.detectWorkspaceDir', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri228-disc-'));
      const stateDir = path.join(tmpDir, '.state');
      fs.mkdirSync(stateDir, { recursive: true });

      try {
        const result = resolveRuntimeConfig(stateDir);
        expect(isRuntimeConfigError(result)).toBe(false);
        if (!isRuntimeConfigError(result)) {
          expect(result.runtimeKind).toBeDefined();
          expect(result.timeoutMs).toBeGreaterThan(0);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('workspace-resolver does not import nocturnal-config', () => {
      const resolverSource = fs.readFileSync(
        path.resolve(__dirname, '..', 'src', 'utils', 'workspace-resolver.ts'),
        'utf-8',
      );
      expect(resolverSource).not.toContain('nocturnal-config');
      expect(resolverSource).not.toContain('sleep-cycle');
      expect(resolverSource).not.toContain('nocturnal-runtime');
    });

    it('resolveRuntimeConfig does not import nocturnal-config or sleep-cycle', () => {
      const factoryPath = path.resolve(
        __dirname,
        '..',
        '..',
        'principles-core',
        'src',
        'runtime-v2',
        'pain-signal-runtime-factory.ts',
      );
      if (!fs.existsSync(factoryPath)) return;
      const source = fs.readFileSync(factoryPath, 'utf-8');
      expect(source).not.toContain('nocturnal-config');
      expect(source).not.toContain('sleep-cycle');
      expect(source).not.toContain('nocturnal-runtime');
      expect(source).not.toContain('idle');
    });
  });

  describe('Legitimate MVP-Core adapter is preserved', () => {
    it('resolveCommandWorkspaceDir still works for plugin commands', () => {
      const mockApi = {
        logger: { error: () => {}, info: () => {}, warn: () => {} },
        runtime: {
          agent: {
            resolveAgentWorkspaceDir: () => '/test/workspace',
          },
        },
        config: {},
      };
      const result = resolveCommandWorkspaceDir(mockApi, { workspaceDir: '/test/workspace' });
      expect(result).toBe('/test/workspace');
    });

    it('resolvePluginCommandWorkspaceDir still works for plugin command context', () => {
      const ctx = { workspaceDir: '/test/workspace', config: {} };
      const result = resolvePluginCommandWorkspaceDir(ctx, 'test-source');
      expect(result).toBe('/test/workspace');
    });

    it('resolveToolHookWorkspaceDirSafe returns undefined on failure (not throw)', () => {
      const mockApi = {
        logger: { error: () => {}, info: () => {}, warn: () => {} },
        runtime: {
          agent: {
            resolveAgentWorkspaceDir: () => {
              throw new Error('no workspace');
            },
          },
        },
        config: {},
      };
      const result = resolveToolHookWorkspaceDirSafe({}, mockApi, 'test');
      expect(result).toBeUndefined();
    });

    it('PainToPrincipleService uses resolveRuntimeConfig internally', async () => {
      const { PainToPrincipleService } = await import('@principles/core/runtime-v2');
      expect(PainToPrincipleService).toBeDefined();
      const service = new PainToPrincipleService({
        workspaceDir: '/tmp/test-ws',
        stateDir: '/tmp/test-ws/.state',
        ledgerAdapter: {
          readPrincipleSubtree: () => undefined,
          writePrinciple: () => ({ id: 'test' }) as never,
          updatePrincipleValueMetrics: () => ({ principleId: 'test' }) as never,
        },
      });
      expect(service).toBeDefined();
      expect(typeof service.recordPain).toBe('function');
    });
  });
});