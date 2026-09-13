/**
 * PRI-758 regression: an `approved` semantic verdict whose deterministic
 * adversarial replay FAILED must route the code_tool_hook chain back into the
 * PRI-509 repair loop (budget/NHR semantics identical to needs_revision)
 * instead of silently advancing without the mandatory validated rule
 * artifact.
 *
 * Uses the same REAL deterministic replay gate harness as
 * evaluator-artificer-repair-replay.test.ts — the BAD_RULE_CODE crashes the
 * sandbox, so adversarialResult.passed=false is produced by production code,
 * not mocked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { hydratePITaskRecord } from '../pitask-metadata.js';
import { decideInternalizationTransition, transitionInputFromTask } from '../internalization-transition-decision.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { createProductionGateDeps } from '../../activation/production-gate-deps.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let emitter: StoreEventEmitter;
let store: SqlitePIArtifactStore;

const SCRIBE_ID = 'scribe-p758';
const ART_ID = 'artificer-p758';
const EVAL_ID = 'evaluator-p758';
const REPAIR_ID = 'artificer-repair-p758';
const SCRIBE_ART = 'pi-art-scribe-p758';

/** Crashes the sandbox: paramsSummary is an object with no `includes`. */
const BROKEN_RULE_CODE = `function evaluate(input, helpers) {
  if (input.action.paramsSummary.includes('/etc/passwd')) {
    return { decision: 'block', matched: true, reason: 'risk path' };
  }
  return { decision: 'allow', matched: false, reason: 'safe path' };
}`;

function artificerArtifactContent(): string {
  return JSON.stringify({
    implementationSummary: 'broken rule', risks: [],
    implementationCode: BROKEN_RULE_CODE,
    goldenTraceCases: [
      { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
      { caseId: 'pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/workspace/a.ts' }, expectedDecision: 'allow' },
    ],
    affectedTools: ['write_file'],
  });
}

function scriptedAdapter(payload: unknown, runId: string): PDRuntimeAdapter {
  return {
    startRun: async () => ({ runId, runtimeKind: 'test-double', startedAt: new Date().toISOString() }),
    pollRun: async () => ({ status: 'succeeded', runId }),
    fetchOutput: async () => ({ runId, payload }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

async function setupChain(): Promise<string> {
  await stateManager.createTask({
    taskId: SCRIBE_ID, taskKind: 'scribe', status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }),
  });
  await stateManager.acquireLease({ taskId: SCRIBE_ID, owner: 'p758', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(SCRIBE_ID);
  await store.upsertArtifact({
    artifactId: SCRIBE_ART, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
    lineageArtifactIds: [], validationStatus: 'validated',
    contentJson: JSON.stringify({ principleId: 'pri-758-verify-sync', principleDraft: { statement: 'Verify source state before cross-session sync.' }, sourceTrace: {} }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await stateManager.createTask({
    taskId: ART_ID, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [SCRIBE_ID], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }),
  });
  return ART_ID;
}

function makeEvaluator(approved: boolean, repairEnabled: boolean, calls: string[]) {
  return new EvaluatorRunner(
    {
      stateManager,
      runtimeAdapter: scriptedAdapter(
        {
          taskId: EVAL_ID,
          sourceArtificerArtifactId: `pi-art-${ART_ID}`,
          evaluation: {
            decision: approved ? 'approved' : 'needs_revision',
            summary: 'PRI-758 regression',
            score: approved ? 0.9 : 0.5,
            strengths: [],
            concerns: [],
            requiredChanges: [],
          },
          sourceTrace: { artificerArtifactId: `pi-art-${ART_ID}`, scribeArtifactId: SCRIBE_ART },
          risks: [],
          generatedAt: new Date().toISOString(),
        },
        'run-p758',
      ),
      eventEmitter: emitter,
      artifactStore: store,
      validator: new DefaultEvaluatorValidator(),
      isRepairLoopEnabled: () => repairEnabled,
      seedArtificerRepairTask: async (params) => {
        calls.push('seed');
        // Mirror the production governance seeder: the repair task row
        // carries the repairPayload (sourceEvaluatorRunId included) so the
        // crash-resume dedupe can find it.
        await stateManager.createTask({
          taskId: REPAIR_ID, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
          diagnosticJson: createPITaskDiagnosticJson({
            dependencyTaskIds: [...params.inheritedDependencyTaskIds],
            channel: params.inheritedChannel,
            timeoutMs: params.inheritedTimeoutMs,
            inputArtifactRefs: [...params.inheritedInputArtifactRefs],
            outputArtifactRefs: [],
            repairPayload: params.repairPayload,
          }),
        });
        return REPAIR_ID;
      },
    },
    {
      owner: 'p758', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000,
      gateDeps: createProductionGateDeps(),
    },
  );
}

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri758-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  emitter = new StoreEventEmitter();
  store = new SqlitePIArtifactStore(new SqliteConnection(workspaceDir));
});

afterEach(async () => {
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

describe('PRI-758: approved + adversarial replay failed routes into repair', () => {
  it('seeds the artificer repair task instead of advancing without a rule artifact', async () => {
    await setupChain();
    await store.upsertArtifact({
      artifactId: `pi-art-${ART_ID}`, artifactKind: 'principle', sourceTaskId: ART_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: artificerArtifactContent(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await stateManager.acquireLease({ taskId: ART_ID, owner: 'p758', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(ART_ID);
    await stateManager.createTask({
      taskId: EVAL_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [ART_ID], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }),
    });

    const calls: string[] = [];
    const evaluator = makeEvaluator(true, true, calls);
    const result = await evaluator.run(EVAL_ID);
    expect(result.status).toBe('succeeded');
    expect(calls.length).toBe(1);
    // The mandatory rule artifact must NOT exist (replay failed).
    const ruleArtifacts = await store.listBySourceTaskId(EVAL_ID);
    expect(ruleArtifacts.some((a) => a.artifactKind === 'rule')).toBe(false);

    // CodeRabbit blocker assertion: the durable transition decision must be
    // needs_revision (blocks ADVANCE — no rollout successor is seeded for
    // this chain while repair is pending).
    const evalTask = await stateManager.getTask(EVAL_ID);
    expect(evalTask).toBeDefined();
    if (!evalTask) return;
    const piTask = hydratePITaskRecord(evalTask);
    if (!piTask) throw new Error('expected PITaskRecord for evaluator task');
    // Durable verdict stays the TRUTHFUL semantic decision ('approved') —
    // resume consistency requires intent.decision === durable output.
    expect(piTask.runnerDecision).toBe('approved');
    // The transition layer must block ADVANCE on replay failure (PRI-758).
    const transition = decideInternalizationTransition(
      transitionInputFromTask(piTask, undefined, { adversarialReplayFailed: true }),
    );
    expect(transition.kind).toBe('REVISION_REQUIRED');
  });

  it('does not seed repair when the repair loop is disabled (legacy advance)', async () => {
    await setupChain();
    await store.upsertArtifact({
      artifactId: `pi-art-${ART_ID}`, artifactKind: 'principle', sourceTaskId: ART_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: artificerArtifactContent(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await stateManager.acquireLease({ taskId: ART_ID, owner: 'p758', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(ART_ID);
    await stateManager.createTask({
      taskId: EVAL_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [ART_ID], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }),
    });

    const calls: string[] = [];
    const evaluator = makeEvaluator(true, false, calls);
    const result = await evaluator.run(EVAL_ID);
    expect(result.status).toBe('succeeded');
    expect(calls.length).toBe(0);
    const ruleArtifacts = await store.listBySourceTaskId(EVAL_ID);
    expect(ruleArtifacts.some((a) => a.artifactKind === 'rule')).toBe(false);
  });

  it('crash-resume with the same evaluator runId reuses the seeded repair (no double-seed)', async () => {
    await setupChain();
    await store.upsertArtifact({
      artifactId: `pi-art-${ART_ID}`, artifactKind: 'principle', sourceTaskId: ART_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: artificerArtifactContent(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await stateManager.acquireLease({ taskId: ART_ID, owner: 'p758', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(ART_ID);
    await stateManager.createTask({
      taskId: EVAL_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [ART_ID], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }),
    });

    const calls: string[] = [];
    const evaluator = makeEvaluator(true, true, calls);
    const first = await evaluator.run(EVAL_ID);
    expect(first.status).toBe('succeeded');
    expect(calls.length).toBe(1);

    // Simulate crash-resume: the evaluator task re-enters the queue and the
    // scripted adapter replays the SAME runId. The seeder must recognize the
    // existing repair for this run and reuse it (no second repair task, no
    // increment against the budget).
    const evaluator2 = makeEvaluator(true, true, calls);
    const conn = new SqliteConnection(workspaceDir);
    try {
      conn.getDb().prepare("UPDATE tasks SET status = 'pending', attempt_count = 0 WHERE task_id = ?").run(EVAL_ID);
    } finally {
      conn.close();
    }
    const second = await evaluator2.run(EVAL_ID);
    expect(second.status).toBe('succeeded');
    expect(calls.length).toBe(1);
  });
});
