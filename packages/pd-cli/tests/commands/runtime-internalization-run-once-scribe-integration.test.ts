import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPITaskDiagnosticJson, RuntimeStateManager } from '@principles/core/runtime-v2';
import { handleRuntimeInternalizationRunOnce } from '../../src/commands/runtime-internalization-run-once.js';

const workspaceDirs: string[] = [];
const PHILOSOPHER_TASK_ID = 'scribe-integration-philosopher';
const SCRIBE_TASK_ID = 'scribe-integration-task';
const PHILOSOPHER_ARTIFACT_ID = 'pi-art-scribe-integration-source';

function makeWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-runonce-scribe-integration-'));
  workspaceDirs.push(workspaceDir);
  return workspaceDir;
}

async function seedScribeTask(workspaceDir: string): Promise<void> {
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  try {
    const diagnosticJson = (dependencyTaskIds: string[], inputArtifactRefs: { artifactType: string; ref: string }[]): string =>
      createPITaskDiagnosticJson({
        dependencyTaskIds,
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs,
        outputArtifactRefs: [],
      });
    await stateManager.createTask({
      taskId: PHILOSOPHER_TASK_ID,
      taskKind: 'philosopher',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: diagnosticJson([], []),
    });
    await stateManager.acquireLease({ taskId: PHILOSOPHER_TASK_ID, owner: 'seed', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(PHILOSOPHER_TASK_ID);
    await stateManager.piArtifactStore.upsertArtifact({
      artifactId: PHILOSOPHER_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: PHILOSOPHER_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: JSON.stringify({
        taskId: PHILOSOPHER_TASK_ID,
        thesis: 'Verify the source behavior before making a change.',
        principleCandidate: {
          title: 'Verify before changing',
          rationale: 'Checking the actual behavior avoids changes based on assumptions.',
          scope: 'Changes to existing systems',
          confidence: 0.9,
        },
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await stateManager.createTask({
      taskId: SCRIBE_TASK_ID,
      taskKind: 'scribe',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [PHILOSOPHER_TASK_ID],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [{ artifactType: 'principle', ref: PHILOSOPHER_ARTIFACT_ID }],
        outputArtifactRefs: [],
      }),
    });
  } finally {
    await stateManager.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const workspaceDir of workspaceDirs.splice(0)) {
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temporary test workspace */ }
  }
});

describe('run-once Scribe integration', () => {
  it('runs a complete source-linked Scribe output through SQLite, the real handler, and the real ScribeRunner', async () => {
    const workspaceDir = makeWorkspace();
    await seedScribeTask(workspaceDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const priorExitCode = process.exitCode;

    try {
      await handleRuntimeInternalizationRunOnce({
        workspace: workspaceDir,
        runner: 'scribe',
        runtime: 'test-double',
        allowTestDouble: true,
        enqueueNext: false,
        json: true,
      });

      const resultJson = logSpy.mock.calls.map((call) => String(call[0])).find((line) => line.trim().startsWith('{'));
      expect(resultJson).toBeDefined();
      const result: unknown = JSON.parse(resultJson ?? '{}');
      expect(result).toMatchObject({
        decision: 'would_lease',
        taskId: SCRIBE_TASK_ID,
        runnerResult: { status: 'succeeded', taskId: SCRIBE_TASK_ID },
      });

      const stateManager = new RuntimeStateManager({ workspaceDir });
      await stateManager.initialize();
      try {
        const scribeTask = await stateManager.getTask(SCRIBE_TASK_ID);
        expect(scribeTask?.status).toBe('succeeded');
        const artifacts = await stateManager.piArtifactStore.listBySourceTaskId(SCRIBE_TASK_ID);
        const scribeArtifact = artifacts.find((artifact) => artifact.artifactKind === 'principle');
        expect(scribeArtifact).toBeDefined();
        expect(scribeArtifact?.lineageArtifactIds).toContain(PHILOSOPHER_ARTIFACT_ID);
        const artifactContent: unknown = JSON.parse(scribeArtifact?.contentJson ?? 'null');
        expect(artifactContent).toMatchObject({
          taskId: SCRIBE_TASK_ID,
          sourcePhilosopherArtifactId: PHILOSOPHER_ARTIFACT_ID,
          sourceTrace: { philosopherArtifactId: PHILOSOPHER_ARTIFACT_ID },
          intentContract: {
            ownerIntent: expect.any(String),
            targetBehavior: expect.any(String),
            forbiddenBehavior: expect.any(String),
            evidenceSource: expect.any(String),
            validationExpectation: expect.any(String),
          },
          executionConditions: { version: 1, requiredFacts: [] },
        });
      } finally {
        await stateManager.close();
      }
    } finally {
      process.exitCode = priorExitCode;
    }
  }, 60_000);
});
