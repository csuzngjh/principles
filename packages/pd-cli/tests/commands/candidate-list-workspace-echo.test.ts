/**
 * PRI-957 — `pd candidate list` must query, and name, the workspace it resolved.
 *
 * Real stack: real workspace resolution + real RuntimeStateManager over a real
 * (empty) state.db, so the assertions cover the operator-visible production
 * messages rather than a mocked helper.
 *
 * Covers:
 *   - empty human-readable result echoes the queried workspace absolute path
 *     (with one .pd/state.db per host workspace, "no candidates" and "wrong
 *     workspace" are otherwise indistinguishable to the Owner);
 *   - `--json` stdout stays exactly the documented machine-readable result (cli-1);
 *   - running with no `-w` and no env from inside a workspace queries that
 *     workspace (acceptance criterion 3, exercised through the real command
 *     wiring rather than a stub).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'path';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

import { handleCandidateList } from '../../src/commands/candidate.js';
import { RuntimeStateManager } from '@principles/core/runtime-v2';

let workRoot: string;
let workspaceDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let originalWorkspaceEnv: string | undefined;

function printedStdout(): string {
  return logSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

/** Create the workspace skeleton and open/close its store once so state.db exists. */
async function createWorkspace(dir: string, configBody?: string): Promise<void> {
  mkdirSync(join(dir, '.pd'), { recursive: true });
  if (configBody !== undefined) {
    writeFileSync(join(dir, '.pd', 'config.yaml'), configBody, 'utf8');
  }
  const stateManager = new RuntimeStateManager({ workspaceDir: dir });
  await stateManager.initialize();
  await stateManager.close();
}

beforeEach(async () => {
  originalWorkspaceEnv = process.env.PD_WORKSPACE_DIR;
  delete process.env.PD_WORKSPACE_DIR;
  workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pd-list-957-')));
  workspaceDir = join(workRoot, 'workspace');
  await createWorkspace(workspaceDir);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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

describe('handleCandidateList — workspace self-reporting (PRI-957)', () => {
  it('names the queried workspace when the result is empty', async () => {
    await handleCandidateList({ taskId: 'diagnosis_957_absent', workspace: workspaceDir });

    expect(printedStdout()).toBe(
      `No candidates found for task: diagnosis_957_absent (workspace: ${resolve(workspaceDir)})`,
    );
  });

  it('keeps --json output pure machine-readable result', async () => {
    await handleCandidateList({
      taskId: 'diagnosis_957_absent',
      workspace: workspaceDir,
      json: true,
    });

    const parsed = JSON.parse(printedStdout()) as { taskId: string; candidates: unknown[] };
    expect(parsed.taskId).toBe('diagnosis_957_absent');
    expect(parsed.candidates).toEqual([]);
    expect(printedStdout()).not.toContain('No candidates found');
  });

  it('queries the workspace the operator is standing in when given no -w and no env', async () => {
    // Acceptance criterion 3 end to end: discovery, resolution and the store all
    // run for real, so a chain that ignored cwd would report against whatever
    // PD_WORKSPACE_DIR or OpenClaw default the machine happens to have.
    await createWorkspace(workspaceDir, 'version: 1\nfeatures: {}\n');
    vi.spyOn(process, 'cwd').mockReturnValue(join(workspaceDir, 'packages'));

    await handleCandidateList({ taskId: 'diagnosis_957_absent' });

    expect(printedStdout()).toBe(
      `No candidates found for task: diagnosis_957_absent (workspace: ${resolve(workspaceDir)})`,
    );
  });
});
