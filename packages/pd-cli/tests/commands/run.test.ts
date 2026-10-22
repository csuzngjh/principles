/**
 * PR #2106 review fix — `pd run list/show` must be able to read a shared
 * governance workspace from anywhere.
 *
 * Before the fix both handlers resolved their target with a bare
 * `resolveWorkspaceDir()` (cwd chain only): an operator standing in a project
 * directory while the run records live in the shared governance workspace got
 * `Run not found` / `No runs found` even though the records existed. `pd health`
 * already had `-w/--workspace`; this pins the same surface for run inspection.
 *
 * Real stack: real workspace resolution chain, real RuntimeStateManager over a
 * real state.db. The fixture is seeded through the manager's own public stores
 * (`taskStore.createTask` + `runStore.createRun`) — the same seeding path as
 * candidate-review.test.ts — so the handler reads exactly what production
 * writers persist, not hand-rolled rows.
 *
 * Covers:
 *   1. handleRunShow with an explicit workspace reads that workspace's run
 *      while the process cwd points at an unrelated directory (the review's
 *      misreported `Run not found`);
 *   2. handleRunList with an explicit workspace lists that workspace's runs
 *      from the same unrelated cwd;
 *   3. without --workspace the pre-fix behavior is preserved: the cwd chain
 *      still decides the target, so standing in workspace A never sees
 *      workspace B's records;
 *   4. CLI registration: `pd run list --help` and `pd run show --help` expose
 *      `-w, --workspace` (cli-7-test-wiring — the `run` subcommands are
 *      registered inline in index.ts, so the built CLI is the only real
 *      registration surface, as in cli-command-tree.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

import { handleRunList, handleRunShow } from '../../src/commands/run.js';
import { RuntimeStateManager } from '@principles/core';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';

// IDs are kept ≤ 22 chars: handleRunList prints `runId.substring(0, 22)`, so
// longer IDs would be truncated in the table row and unassertable verbatim.
const TASK_ID = 'diag_2106';
const RUN_ID = 'run_diag_2106_1';

let workRoot: string;
/** Workspace A — where the operator stands; a project directory with its own empty .pd. */
let workspaceA: string;
/** Workspace B — the shared governance workspace holding the run record. */
let workspaceB: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let originalWorkspaceEnv: string | undefined;

function printedStdout(): string {
  return logSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

function printedStderr(): string {
  return errorSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

/** Create a workspace skeleton (`.pd/` + config) and open its store once so state.db exists. */
async function createWorkspace(dir: string): Promise<void> {
  mkdirSync(join(dir, '.pd'), { recursive: true });
  writeFileSync(join(dir, '.pd', 'config.yaml'), 'version: 1\nfeatures: {}\n', 'utf8');
  const stateManager = new RuntimeStateManager({ workspaceDir: dir });
  await stateManager.initialize();
  await stateManager.close();
}

/** Seed one task + one succeeded run into workspace B via the real public stores. */
async function seedRunInWorkspaceB(): Promise<void> {
  const stateManager = new RuntimeStateManager({ workspaceDir: workspaceB });
  await stateManager.initialize();
  try {
    await stateManager.taskStore.createTask({
      taskId: TASK_ID,
      taskKind: 'diagnostician',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      inputRef: 'pain-seed-2106',
    });
    const now = new Date().toISOString();
    await stateManager.runStore.createRun({
      runId: RUN_ID,
      taskId: TASK_ID,
      runtimeKind: 'openclaw',
      attemptNumber: 1,
      executionStatus: 'succeeded',
      startedAt: now,
      endedAt: now,
    });
  } finally {
    await stateManager.close();
  }
}

/** Stand the process in a nested project directory under workspace A. */
function standInWorkspaceA(): void {
  vi.spyOn(process, 'cwd').mockReturnValue(join(workspaceA, 'packages', 'my-app'));
}

beforeEach(async () => {
  originalWorkspaceEnv = process.env.PD_WORKSPACE_DIR;
  delete process.env.PD_WORKSPACE_DIR;
  workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pd-run-ws-2106-')));
  workspaceA = join(workRoot, 'project-a');
  workspaceB = join(workRoot, 'governance-b');
  await createWorkspace(workspaceA);
  await createWorkspace(workspaceB);
  await seedRunInWorkspaceB();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Stubbed exit returns undefined, so the "Run not found" path in
  // handleRunShow continues into the success formatting and throws a TypeError
  // on the null run — the not-found observables are asserted before that.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalWorkspaceEnv !== undefined) {
    process.env.PD_WORKSPACE_DIR = originalWorkspaceEnv;
  } else {
    delete process.env.PD_WORKSPACE_DIR;
  }
  rmSync(workRoot, { recursive: true, force: true });
});

describe('pd run show — explicit workspace overrides cwd (PR #2106)', () => {
  it('reads a run from workspace B while standing in workspace A', async () => {
    standInWorkspaceA();

    await handleRunShow({ id: RUN_ID, workspace: workspaceB });

    expect(printedStdout()).toContain(`Run: ${RUN_ID}`);
    expect(printedStdout()).toContain(`Task ID:       ${TASK_ID}`);
    expect(printedStderr()).not.toContain('Run not found');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('pd run list — explicit workspace overrides cwd (PR #2106)', () => {
  it('lists a run from workspace B while standing in workspace A', async () => {
    standInWorkspaceA();

    await handleRunList({ taskId: TASK_ID, workspace: workspaceB });

    expect(printedStdout()).toContain(`Runs for ${TASK_ID} (1)`);
    expect(printedStdout()).toContain(RUN_ID);
    expect(printedStdout()).not.toContain('No runs found');
  });
});

describe('pd run list/show — no --workspace keeps the cwd resolution chain', () => {
  it('list standing in A does not see B records', async () => {
    standInWorkspaceA();

    await handleRunList({ taskId: TASK_ID });

    expect(printedStdout()).toContain(`No runs found for task: ${TASK_ID}`);
  });

  it('show standing in A reports Run not found and exits 1 (pre-fix behavior)', async () => {
    standInWorkspaceA();

    // The stubbed process.exit makes the handler continue past the exit point
    // and throw on the null run; the not-found contract is what is asserted.
    await expect(handleRunShow({ id: RUN_ID })).rejects.toThrow(TypeError);
    expect(printedStderr()).toContain(`Run not found: ${RUN_ID}`);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('pd run list/show — CLI option registration (cli-7-test-wiring)', () => {
  function runPdHelp(args: string[]): string {
    return execFileSync('node', [getBuiltPdCliPath(), ...args], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
  }

  it('registers -w/--workspace on `pd run list`', () => {
    const output = runPdHelp(['run', 'list', '--help']);
    expect(output).toContain('--workspace');
    expect(output).toContain('-w');
  });

  it('registers -w/--workspace on `pd run show`', () => {
    const output = runPdHelp(['run', 'show', '--help']);
    expect(output).toContain('--workspace');
    expect(output).toContain('-w');
  });
});
