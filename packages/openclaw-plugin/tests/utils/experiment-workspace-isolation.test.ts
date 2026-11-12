/**
 * Experiment-instance workspace isolation (P0-1, 2026-11-12 real-user E2E
 * acceptance).
 *
 * A gateway started by `scripts/dev/console-experiment.mjs` inherits the
 * operator's shell environment. A user-level `PD_WORKSPACE_DIR` outranks the
 * OpenClaw context, so the experiment process once resolved the production
 * workspace and wrote production state.db / trajectory.db. In experiment mode
 * that resolution must now FAIL instead of warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveCommandWorkspaceDir,
  resolveHookWorkspaceDir,
  resolvePluginCommandWorkspaceDir,
  resolveToolHookWorkspaceDirSafe,
} from '../../src/utils/workspace-resolver.js';
import { PathResolver } from '../../src/core/path-resolver.js';
import { InternalizationAutoConsumerService } from '../../src/service/internalization-auto-consumer-service.js';
import { handleBeforePromptBuild } from '../../src/hooks/prompt.js';

const PRODUCTION_SENTINEL =
  process.platform === 'win32'
    ? 'D:\\__PD_PRODUCTION_SENTINEL_DO_NOT_USE__'
    : '/tmp/__PD_PRODUCTION_SENTINEL_DO_NOT_USE__';

const originalEnv = { ...process.env };

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
const api = {
  runtime: { agent: { resolveAgentWorkspaceDir: vi.fn() } },
  config: {},
  logger,
};

function makeDir(label: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `pd-experiment-isolation-${label}-`)));
}

let experimentRoot: string;
let productionWorkspace: string;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.PD_WORKSPACE_DIR;
  delete process.env.OPENCLAW_WORKSPACE;
  delete process.env.PD_EXPERIMENT_ROOT;
  vi.clearAllMocks();

  experimentRoot = makeDir('root');
  productionWorkspace = makeDir('production');
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('hook workspace resolution under PD_EXPERIMENT_ROOT', () => {
  it('refuses an inherited production PD_WORKSPACE_DIR instead of writing production state', () => {
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;
    process.env.PD_WORKSPACE_DIR = productionWorkspace;

    const result = resolveHookWorkspaceDir({ workspaceDir: path.join(experimentRoot, 'workspace') }, api as any, 'test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('workspace_outside_experiment_root');
      expect(result.message).toContain(productionWorkspace);
      expect(result.message).toContain(experimentRoot);
      expect(result.nextAction).toContain('PD_EXPERIMENT_ROOT');
    }
  });

  it('resolves the experiment workspace normally when it is inside the root', () => {
    const workspace = path.join(experimentRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;
    process.env.PD_WORKSPACE_DIR = workspace;

    const result = resolveHookWorkspaceDir({}, api as any, 'test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspaceDir).toBe(workspace);
      expect(result.source).toBe('pd_env');
    }
  });

  it('also refuses when the escaping workspace comes from the OpenClaw context', () => {
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;

    const result = resolveHookWorkspaceDir(
      { workspaceDir: productionWorkspace },
      api as any,
      'test',
      { explicitPdResolver: () => null },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('workspace_outside_experiment_root');
    }
  });

  it('keeps production behaviour unchanged when PD_EXPERIMENT_ROOT is absent', () => {
    process.env.PD_WORKSPACE_DIR = productionWorkspace;

    const result = resolveHookWorkspaceDir({}, api as any, 'test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspaceDir).toBe(path.resolve(productionWorkspace));
      expect(result.source).toBe('pd_env');
    }
  });

  it('safe tool-hook resolution degrades to undefined and logs the reason', () => {
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;
    process.env.PD_WORKSPACE_DIR = productionWorkspace;

    const resolved = resolveToolHookWorkspaceDirSafe({}, api as any, 'after_tool_call');

    expect(resolved).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('command workspace resolution under PD_EXPERIMENT_ROOT', () => {
  it('throws when the command would run against the production workspace', () => {
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;
    process.env.PD_WORKSPACE_DIR = productionWorkspace;

    expect(() => resolveCommandWorkspaceDir(api as any, {})).toThrow(/Experiment isolation refused/);
  });

  it('throws from the plugin command resolver as well', () => {
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;
    process.env.PD_WORKSPACE_DIR = productionWorkspace;

    expect(() =>
      resolvePluginCommandWorkspaceDir({ workspaceDir: productionWorkspace } as any, 'pain'),
    ).toThrow(/Experiment isolation refused/);
  });

  it('still resolves a workspace inside the experiment root', () => {
    const workspace = path.join(experimentRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;
    process.env.PD_WORKSPACE_DIR = workspace;

    expect(resolveCommandWorkspaceDir(api as any, {})).toBe(workspace);
  });
});

// ── Second line of defence: the other production write paths ────────────────
describe('PathResolver under PD_EXPERIMENT_ROOT', () => {
  it('refuses the inherited production pointer instead of returning it', () => {
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;
    process.env.PD_WORKSPACE_DIR = productionWorkspace;
    delete process.env.OPENCLAW_WORKSPACE;

    const resolver = new PathResolver({ logger });

    expect(() => resolver.getWorkspaceDir()).toThrow(/Experiment isolation refused/);
  });

  it('refuses the production sentinel path', () => {
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;
    process.env.PD_WORKSPACE_DIR = PRODUCTION_SENTINEL;

    expect(() => new PathResolver({ logger }).getWorkspaceDir()).toThrow(/Experiment isolation refused/);
  });

  it('refuses a PD_STATE_DIR outside the experiment root', () => {
    const workspace = path.join(experimentRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;
    process.env.PD_WORKSPACE_DIR = workspace;
    process.env.PD_STATE_DIR = path.join(productionWorkspace, '.state');

    expect(() => new PathResolver().getStateDir()).toThrow(/Experiment isolation refused/);
  });

  it('keeps production behaviour without PD_EXPERIMENT_ROOT', () => {
    process.env.PD_WORKSPACE_DIR = productionWorkspace;

    expect(new PathResolver().getWorkspaceDir()).toBe(path.resolve(productionWorkspace));
  });
});

describe('prompt hooks under PD_EXPERIMENT_ROOT', () => {
  it('refuses to run a prompt round for a workspace outside the root', async () => {
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;

    const result = await handleBeforePromptBuild(
      {} as any,
      { workspaceDir: productionWorkspace, trigger: 'user', api: { logger } } as any,
    );

    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Experiment isolation refused'));
  });
});

describe('internalization AutoConsumer under PD_EXPERIMENT_ROOT', () => {
  it('does not start for a workspace outside the root and writes nothing there', () => {
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;

    InternalizationAutoConsumerService.start({
      workspaceDir: productionWorkspace,
      logger: logger as any,
    } as any);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Experiment isolation refused'));
    expect(fs.existsSync(path.join(productionWorkspace, '.pd'))).toBe(false);
  });

  it('starts for a workspace inside the root', () => {
    const workspace = path.join(experimentRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    process.env.PD_EXPERIMENT_ROOT = experimentRoot;

    InternalizationAutoConsumerService.start({
      workspaceDir: workspace,
      logger: logger as any,
    } as any);

    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('Experiment isolation refused'));
    InternalizationAutoConsumerService.stop?.({ workspaceDir: workspace } as any);
  });
});
