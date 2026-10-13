/**
 * PRI-957 — `pd candidate list` empty results must name the library they queried.
 *
 * Real stack: real workspace resolution + real RuntimeStateManager over a real
 * (empty) state.db, so the assertion covers the operator-visible production
 * message rather than a mocked helper.
 *
 * Covers:
 *   - empty human-readable result echoes the queried workspace absolute path
 *     (with one .pd/state.db per host workspace, "no candidates" and "wrong
 *     workspace" are otherwise indistinguishable to the Owner);
 *   - `--json` stdout stays exactly the documented machine-readable result (cli-1).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';

import { handleCandidateList } from '../../src/commands/candidate.js';
import { RuntimeStateManager } from '@principles/core/runtime-v2';

let workspaceDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let originalWorkspaceEnv: string | undefined;

function printedStdout(): string {
  return logSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

beforeEach(async () => {
  originalWorkspaceEnv = process.env.PD_WORKSPACE_DIR;
  delete process.env.PD_WORKSPACE_DIR;
  workspaceDir = join(process.env.TEMP ?? '.', `pd-list-957-${randomUUID()}`);
  mkdirSync(join(workspaceDir, '.pd'), { recursive: true });
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  await stateManager.close();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  if (originalWorkspaceEnv !== undefined) {
    process.env.PD_WORKSPACE_DIR = originalWorkspaceEnv;
  } else {
    delete process.env.PD_WORKSPACE_DIR;
  }
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('handleCandidateList — workspace self-reporting (PRI-957)', () => {
  it('names the queried workspace when the result is empty', async () => {
    await handleCandidateList({ taskId: 'diagnosis_957_absent', workspace: workspaceDir });

    expect(printedStdout()).toBe(
      `No candidates found for task: diagnosis_957_absent (workspace: ${workspaceDir})`,
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
});
