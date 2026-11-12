import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveExperimentWorkspace,
  verifyExperimentChildEnvironment,
  verifyExperimentWorkspaceDirectory,
} from '../dev/experiment-workspace-isolation.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.resolve(SCRIPT_DIR, '..', 'dev', 'console-experiment.mjs');

// A fictional production path. It must NEVER be created by a test: the point is
// that isolation refuses it before any filesystem mutation.
const PRODUCTION_SENTINEL =
  process.platform === 'win32'
    ? 'D:\\__PD_PRODUCTION_SENTINEL_DO_NOT_USE__'
    : '/tmp/__PD_PRODUCTION_SENTINEL_DO_NOT_USE__';

function tempDir(label) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `pd-experiment-isolation-${label}-`)));
}

function expectRefusal(result, expectedReason) {
  expect(result.ok).toBe(false);
  if (expectedReason instanceof RegExp) {
    expect(result.reason).toMatch(expectedReason);
  } else {
    expect(result.reason).toBe(expectedReason);
  }
  expect(result.message.length).toBeGreaterThan(0);
  expect(result.nextAction.length).toBeGreaterThan(0);
}

// ── 1. inherited production pointer is overridden, not honoured ─────────────
test('1 · inherited production PD_WORKSPACE_DIR is overridden, not honoured', () => {
  const root = tempDir('root');
  const result = resolveExperimentWorkspace({
    experimentRoot: root,
    env: { PD_WORKSPACE_DIR: PRODUCTION_SENTINEL },
  });

  expect(result.ok).toBe(true);
  expect(result.workspace).toBe(path.join(root, 'workspace'));
  expect(result.overriddenPointers.map((pointer) => pointer.name)).toEqual(['PD_WORKSPACE_DIR']);
});

// ── 2. workspace outside the experiment root ───────────────────────────────
test('2 · a workspace outside the experiment root is refused', () => {
  const root = tempDir('root');
  expectRefusal(
    resolveExperimentWorkspace({ experimentRoot: root, requestedWorkspace: path.dirname(root), env: {} }),
    'experiment_workspace_outside_experiment_root',
  );
});

// ── 3. production default workspace path ───────────────────────────────────
test('3 · the production default workspace (~/.openclaw/workspace) is refused', () => {
  const root = tempDir('root');
  const defaultProductionWorkspace = path.join(os.homedir(), '.openclaw', 'workspace');
  expectRefusal(
    resolveExperimentWorkspace({ experimentRoot: root, requestedWorkspace: defaultProductionWorkspace, env: {} }),
    /experiment_workspace_(outside_experiment_root|overlaps_production_state)/,
  );
});

// ── 3b. inherited pointer that owns the workspace (no sentinel creation) ────
test('3b · a workspace inside an inherited production pointer is refused', () => {
  const productionPointer = tempDir('production-pointer');
  const root = path.join(productionPointer, 'run-1');
  fs.mkdirSync(root, { recursive: true });

  expectRefusal(
    resolveExperimentWorkspace({ experimentRoot: root, env: { PD_WORKSPACE_DIR: productionPointer } }),
    'experiment_workspace_overlaps_production_state',
  );
});

// ── 4. `..` traversal ─────────────────────────────────────────────────────
test('4 · `..` traversal out of the experiment root is refused', () => {
  const root = tempDir('root');
  const traversal = path.join(root, '..', `${path.basename(root)}-escape`);

  expectRefusal(
    resolveExperimentWorkspace({ experimentRoot: root, requestedWorkspace: traversal, env: {} }),
    'experiment_workspace_outside_experiment_root',
  );
});

// ── 5. junction / symlink escape ──────────────────────────────────────────
test('5 · a junction/symlink inside the root pointing outside is refused', () => {
  const root = tempDir('root');
  const outside = tempDir('outside');
  const link = path.join(root, 'workspace-link');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    // Symlink creation is the only environment-dependent step; make the skip
    // explicit rather than silently passing.
    throw new Error(`test environment cannot create a ${process.platform === 'win32' ? 'junction' : 'symlink'}: ${String(error)}`);
  }

  expectRefusal(
    resolveExperimentWorkspace({ experimentRoot: root, requestedWorkspace: link, env: {} }),
    'experiment_workspace_outside_experiment_root',
  );
});

// ── 6. Windows case aliasing must not bypass containment ───────────────────
test('6 · Windows case variants resolve to the same workspace', () => {
  const root = tempDir('root');
  const requested = path.join(root, 'WORKSpace');
  fs.mkdirSync(requested, { recursive: true });
  const result = resolveExperimentWorkspace({ experimentRoot: root, requestedWorkspace: requested, env: {} });

  expect(result.ok).toBe(true);
  const directory = verifyExperimentWorkspaceDirectory({ experimentRoot: root, workspace: result.workspace });
  expect(directory.ok).toBe(true);
});

// ── 7. child environment consistency ──────────────────────────────────────
test('7 · a child environment that disagrees with the workspace is refused', () => {
  const root = tempDir('root');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const childEnv = {
    PD_EXPERIMENT_ROOT: root,
    PD_WORKSPACE_DIR: path.join(root, 'somewhere-else'),
    OPENCLAW_WORKSPACE: workspace,
    OPENCLAW_WORKSPACE_DIR: workspace,
    OPENCLAW_STATE_DIR: path.join(root, '.openclaw'),
    OPENCLAW_CONFIG_PATH: path.join(root, '.openclaw', 'openclaw.json'),
    XDG_CACHE_HOME: path.join(root, '.cache'),
  };

  expectRefusal(
    verifyExperimentChildEnvironment({ experimentRoot: root, workspace, childEnv }),
    'experiment_child_env_inconsistent',
  );
});

test('7b · a consistent child environment passes', () => {
  const root = tempDir('root');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const result = verifyExperimentChildEnvironment({
    experimentRoot: root,
    workspace,
    childEnv: {
      PD_EXPERIMENT_ROOT: root,
      PD_WORKSPACE_DIR: workspace,
      OPENCLAW_WORKSPACE: workspace,
      OPENCLAW_WORKSPACE_DIR: workspace,
      OPENCLAW_STATE_DIR: path.join(root, '.openclaw'),
      OPENCLAW_CONFIG_PATH: path.join(root, '.openclaw', 'openclaw.json'),
      XDG_CACHE_HOME: path.join(root, '.cache'),
    },
  });

  expect(result).toEqual({ ok: true });
});

// ── extra: missing workspace directory is refused, not created blindly ─────
test('8 · a workspace that does not exist after creation is refused', () => {
  const root = tempDir('root');
  expectRefusal(
    verifyExperimentWorkspaceDirectory({ experimentRoot: root, workspace: path.join(root, 'missing') }),
    'experiment_workspace_missing',
  );
});

// ── launcher wiring: real subprocess, real refusal, exit code 1 ────────────
test('9 · launcher refuses to start when an inherited pointer owns the workspace', () => {
  const productionPointer = tempDir('production-pointer');
  const root = path.join(productionPointer, 'run-1');
  fs.mkdirSync(root, { recursive: true });

  const child = spawnSync(
    process.execPath,
    [LAUNCHER, '--root', root, '--workspace', path.join(root, 'workspace')],
    {
      env: { ...process.env, PD_WORKSPACE_DIR: productionPointer },
      encoding: 'utf8',
      timeout: 60000,
    },
  );

  expect(child.status, `${child.stdout ?? ''}${child.stderr ?? ''}`).toBe(1);
  expect(child.stderr).toMatch(/Refusing to start: experiment_workspace_overlaps_production_state/);
  expect(child.stderr).toMatch(/Next:/);
});

test('10 · launcher refuses the production sentinel path without creating it', () => {
  const root = tempDir('root');
  const child = spawnSync(
    process.execPath,
    [LAUNCHER, '--root', root, '--workspace', PRODUCTION_SENTINEL],
    {
      env: { ...process.env, PD_WORKSPACE_DIR: PRODUCTION_SENTINEL },
      encoding: 'utf8',
      timeout: 60000,
    },
  );

  expect(child.status, `${child.stdout ?? ''}${child.stderr ?? ''}`).toBe(1);
  expect(child.stderr).toMatch(/Refusing to start: experiment_workspace_(outside_experiment_root|overlaps_production_state)/);
  expect(fs.existsSync(PRODUCTION_SENTINEL)).toBe(false);
});
