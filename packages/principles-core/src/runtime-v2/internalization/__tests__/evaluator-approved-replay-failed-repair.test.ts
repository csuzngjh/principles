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
import { ArtificerRunner } from '../artificer-runner.js';
import { hydratePITaskRecord } from '../pitask-metadata.js';
import { decideInternalizationTransition, transitionInputFromTask } from '../internalization-transition-decision.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import { DefaultArtificerValidator } from '../artificer-output.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { createProductionGateDeps } from '../../activation/production-gate-deps.js';
import { getDefaultPdConfig } from '../../config/pd-config-defaults.js';
import { resolveProfile } from '../../config/pd-profile-constants.js';
import { artificerRepairTaskId } from '../pitask-metadata.js';
import type { OwnerEvidenceSelection } from '../evidence-readiness.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let emitter: StoreEventEmitter;
let store: SqlitePIArtifactStore;

const SCRIBE_ID = 'scribe-p758';
const PHILOSOPHER_ID = 'philosopher-p758';
const ART_ID = 'artificer-p758';
const EVAL_ID = 'evaluator-p758';
const REPAIR_ID = artificerRepairTaskId(EVAL_ID, 1);
const SCRIBE_ART = 'pi-art-scribe-p758';
const PHILOSOPHER_ART = 'pi-art-philosopher-p758';
const OWNER_EVIDENCE_SELECTION: OwnerEvidenceSelection = {
  sourcePainId: 'pain_p758',
  sourceNegativeToolCallId: 42,
  positiveToolCallIds: [7],
  ownerDesiredOutcome: 'Block the identified protected-path write and allow ordinary workspace writes.',
  revision: 1,
  contentDigest: `sha256:${'a'.repeat(64)}`,
  ownerOperation: 'cli:attach',
  attachedAt: '2026-10-18T00:00:00.000Z',
};

function effectiveConfig(): EffectivePdConfig {
  return {
    config: getDefaultPdConfig(),
    source: 'user_config',
    warnings: [],
    featuresChangedFromDefault: [],
    resolvedProfile: resolveProfile({}),
    resolvedContextInjection: { thinkingOs: false, projectFocus: 'off' },
  };
}

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

function legacyV2ArtifactMissingOwnerStamp(): string {
  return JSON.stringify({
    sourceScribeArtifactId: SCRIBE_ART,
    requiresContextVersion: 2,
    implementationSummary: 'legacy RuleCode missing system Owner-pack provenance',
    implementationCode: BROKEN_RULE_CODE,
    goldenTraceCases: [
      { caseId: 'model-neg', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
      { caseId: 'model-pos', kind: 'positive', toolName: 'write_file', params: { path: '/workspace/a.ts' }, expectedDecision: 'allow' },
    ],
    affectedTools: ['write_file'],
  });
}

function scriptedAdapter(payload: unknown, runId: string, onStart?: () => void): PDRuntimeAdapter {
  return {
    startRun: async () => {
      onStart?.();
      return { runId, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    },
    pollRun: async () => ({ status: 'succeeded', runId }),
    fetchOutput: async () => ({ runId, payload }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

async function setupChain(channel: 'prompt' | 'code_tool_hook' = 'prompt'): Promise<string> {
  await stateManager.createTask({
    taskId: PHILOSOPHER_ID, taskKind: 'philosopher', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
    diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [], channel, timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }),
  });
  await store.upsertArtifact({
    artifactId: PHILOSOPHER_ART, artifactKind: 'principle', sourceTaskId: PHILOSOPHER_ID,
    lineageArtifactIds: [], validationStatus: 'validated',
    contentJson: JSON.stringify({ thesis: 'The agent must inspect relevant intent material before implementation.', analysis: 'A decision without its upstream context can diverge from the Owner intent.' }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await stateManager.createTask({
    taskId: SCRIBE_ID, taskKind: 'scribe', status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [PHILOSOPHER_ID], channel, timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }),
  });
  await stateManager.acquireLease({ taskId: SCRIBE_ID, owner: 'p758', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(SCRIBE_ID);
  await store.upsertArtifact({
    artifactId: SCRIBE_ART, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
    lineageArtifactIds: [], validationStatus: 'validated',
    contentJson: JSON.stringify({
      principleId: 'pri-758-verify-sync',
      principleDraft: { statement: 'Verify source state before cross-session sync.' },
      sourcePhilosopherArtifactId: PHILOSOPHER_ART,
      sourceTrace: { philosopherArtifactId: PHILOSOPHER_ART },
      intentContract: {
        ownerIntent: 'Verify source state before cross-session sync.',
        targetBehavior: 'Check the source state before syncing.',
        forbiddenBehavior: 'Syncing without checking the source state.',
        evidenceSource: 'pain://p758-owner-example',
        validationExpectation: 'The agent verifies state before syncing.',
      },
      executionConditions: { version: 1, requiredFacts: [] },
    }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await stateManager.createTask({
    taskId: ART_ID, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [SCRIBE_ID], channel, timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }),
  });
  return ART_ID;
}

function makeEvaluator(options: {
  approved: boolean;
  repairEnabled: boolean;
  seeds: string[];
  llmCalls?: string[];
  gateEnabled?: boolean;
  sourceArtificerArtifactId?: string;
  runId?: string;
  repairRound?: boolean;
}) {
  const {
    approved,
    repairEnabled,
    seeds: calls,
    llmCalls = [],
    gateEnabled = true,
    sourceArtificerArtifactId = `pi-art-${ART_ID}`,
    runId = 'run-p758',
    repairRound = false,
  } = options;
  return new EvaluatorRunner(
    {
      stateManager,
      runtimeAdapter: scriptedAdapter(
        {
          taskId: EVAL_ID,
          sourceArtificerArtifactId,
          evaluation: {
            decision: approved ? 'approved' : 'needs_revision',
            summary: 'PRI-758 regression',
            score: approved ? 0.9 : 0.5,
            strengths: [],
            concerns: [],
            requiredChanges: [],
            ...(repairRound
              ? {
                  priorRequirementStatuses: [],
                  requirementLedger: [],
                }
              : {}),
          },
          sourceTrace: { artificerArtifactId: sourceArtificerArtifactId, scribeArtifactId: SCRIBE_ART },
          risks: [],
          generatedAt: new Date().toISOString(),
        },
        runId,
        () => llmCalls.push('called'),
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
            ...(params.ownerEvidenceSelection ? { ownerEvidenceSelection: params.ownerEvidenceSelection } : {}),
          }),
        });
        return REPAIR_ID;
      },
    },
    {
      owner: 'p758', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000,
      ...(gateEnabled ? { gateDeps: createProductionGateDeps() } : {}),
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  it('prompt-channel V2 code without Owner provenance remains a prompt result and cannot create RuleCode', async () => {
    await setupChain('prompt');
    await store.upsertArtifact({
      artifactId: `pi-art-${ART_ID}`, artifactKind: 'principle', sourceTaskId: ART_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: legacyV2ArtifactMissingOwnerStamp(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await stateManager.acquireLease({ taskId: ART_ID, owner: 'p758', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(ART_ID);
    await stateManager.createTask({
      taskId: EVAL_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [ART_ID], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }),
    });

    const seeds: string[] = [];
    const llmCalls: string[] = [];
    const result = await makeEvaluator({ approved: true, repairEnabled: true, seeds, llmCalls, gateEnabled: false }).run(EVAL_ID);
    expect(result.status).toBe('succeeded');
    expect(llmCalls).toHaveLength(1);
    expect(seeds).toHaveLength(0);
    const evaluatorArtifacts = await store.listBySourceTaskId(EVAL_ID);
    expect(evaluatorArtifacts.some((artifact) => artifact.artifactKind === 'rule')).toBe(false);
    const evaluatorPrinciple = evaluatorArtifacts.find((artifact) => artifact.artifactKind === 'principle');
    expect(evaluatorPrinciple).toBeDefined();
    if (!evaluatorPrinciple) return;
    const output = JSON.parse(evaluatorPrinciple.contentJson) as { adversarialResult?: unknown };
    expect(Object.hasOwn(output, 'adversarialResult')).toBe(false);
    expect((await stateManager.getTask(EVAL_ID))?.diagnosticJson).not.toContain('owner_golden_trace_provenance_missing');
  });

  it('code_tool_hook missing-stamp input fails loud when the bounded repair loop is disabled', async () => {
    await setupChain('code_tool_hook');
    await store.upsertArtifact({
      artifactId: `pi-art-${ART_ID}`, artifactKind: 'principle', sourceTaskId: ART_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: legacyV2ArtifactMissingOwnerStamp(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await stateManager.acquireLease({ taskId: ART_ID, owner: 'p758', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(ART_ID);
    await stateManager.createTask({
      taskId: EVAL_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [ART_ID], channel: 'code_tool_hook', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }),
    });

    const seeds: string[] = [];
    const result = await makeEvaluator({ approved: true, repairEnabled: false, seeds }).run(EVAL_ID);
    expect(result.status).toBe('failed');
    expect(seeds).toHaveLength(0);
    expect(result.failureReason).toContain('owner_golden_trace_stamp_missing_or_invalid');
    expect((await store.listBySourceTaskId(EVAL_ID)).some((artifact) => artifact.artifactKind === 'rule')).toBe(false);
  });

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
    const evaluator = makeEvaluator({ approved: true, repairEnabled: true, seeds: calls });
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
    // CodeRabbit blocker: assert the PRODUCTION commit boundary —
    // commitNextTaskProposal must return blocked_by_revision and must NOT
    // seed a rollout successor while repair is pending.
    const { InternalizationOrchestrator } = await import('../internalization-orchestrator.js');
    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: 'p758', runtimeKind: 'test-double', dryRun: true },
    );
    const commit = await orchestrator.commitNextTaskProposal(EVAL_ID);
    expect(commit.decision).toBe('blocked_by_revision');
    const rolloutTasks = (await stateManager.listTasks({})).filter(
      (t) => t.taskKind === 'rollout_reviewer',
    );
    expect(rolloutTasks.length).toBe(0);
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
    const evaluator = makeEvaluator({ approved: true, repairEnabled: false, seeds: calls });
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
    const evaluator = makeEvaluator({ approved: true, repairEnabled: true, seeds: calls });
    const first = await evaluator.run(EVAL_ID);
    expect(first.status).toBe('succeeded');
    expect(calls.length).toBe(1);

    // Simulate crash-resume: the evaluator task re-enters the queue and the
    // scripted adapter replays the SAME runId. The seeder must recognize the
    // existing repair for this run and reuse it (no second repair task, no
    // increment against the budget).
    const evaluator2 = makeEvaluator({ approved: true, repairEnabled: true, seeds: calls });
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

  it('legacy V2 missing Owner provenance repairs from the current pack and blocks ADVANCE until replacement is reopened', async () => {
    await setupChain('code_tool_hook');
    const sourceArtificerTask = await stateManager.getTask(ART_ID);
    if (!sourceArtificerTask) throw new Error('source Artificer task missing');
    const sourceArtificerPiTask = hydratePITaskRecord(sourceArtificerTask);
    if (!sourceArtificerPiTask) throw new Error('source Artificer metadata invalid');
    await stateManager.updateTask(ART_ID, {
      diagnosticJson: createPITaskDiagnosticJson({
        ...sourceArtificerPiTask,
        ownerEvidenceSelection: OWNER_EVIDENCE_SELECTION,
      }),
    });
    await store.upsertArtifact({
      artifactId: `pi-art-${ART_ID}`, artifactKind: 'principle', sourceTaskId: ART_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: legacyV2ArtifactMissingOwnerStamp(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await stateManager.acquireLease({ taskId: ART_ID, owner: 'p758', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(ART_ID);
    await stateManager.createTask({
      taskId: EVAL_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [ART_ID], channel: 'code_tool_hook', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }),
    });

    const calls: string[] = [];
    const llmCalls: string[] = [];
    const evaluator = makeEvaluator({ approved: true, repairEnabled: true, seeds: calls, llmCalls });
    const firstResult = await evaluator.run(EVAL_ID);
    expect(firstResult.status).toBe('succeeded');
    expect(calls).toHaveLength(1);

    const repairTask = await stateManager.getTask(REPAIR_ID);
    const repairPi = repairTask ? hydratePITaskRecord(repairTask) : null;
    expect(repairPi?.ownerEvidenceSelection).toEqual(OWNER_EVIDENCE_SELECTION);
    expect(repairPi?.repairPayload?.requiredChanges).toContain(
      'Regenerate this RuleCode from the current validated Owner BehaviorExamplePack so the persisted artifact carries the system-owned ownerGoldenTraceCases; preserve the approved principle semantics.',
    );
    expect(llmCalls).toHaveLength(1);

    const evalArtifacts = await store.listBySourceTaskId(EVAL_ID);
    const evalArtifact = evalArtifacts.find((artifact) => artifact.artifactKind === 'principle');
    expect(evalArtifact).toBeDefined();
    if (!evalArtifact) return;
    const evalOutput: unknown = JSON.parse(evalArtifact.contentJson);
    expect(evalOutput).toMatchObject({ evaluation: { decision: 'approved' } }); // preserve the LLM verdict
    expect(isRecord(evalOutput)).toBe(true);
    if (!isRecord(evalOutput)) return;
    expect(Object.hasOwn(evalOutput, 'adversarialResult')).toBe(false); // no fabricated gate evidence
    expect(evalArtifacts.some((artifact) => artifact.artifactKind === 'rule')).toBe(false);

    const evalTask = await stateManager.getTask(EVAL_ID);
    expect(evalTask).toBeDefined();
    if (!evalTask) return;
    const piTask = hydratePITaskRecord(evalTask);
    expect(piTask?.runnerDecision).toBe('approved');
    expect(piTask?.completionIntent?.transitionOverrideReason).toBe('owner_golden_trace_provenance_missing');
    const { InternalizationOrchestrator } = await import('../internalization-orchestrator.js');
    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: 'p758', runtimeKind: 'test-double', dryRun: true },
    );
    const blocked = await orchestrator.commitNextTaskProposal(EVAL_ID);
    expect(blocked).toMatchObject({ decision: 'blocked_by_revision' });
    expect((await stateManager.listTasks({})).filter((task) => task.taskKind === 'rollout_reviewer')).toHaveLength(0);

    // Crash after deterministic repair seeding but before intent-applied: the
    // persisted recovery reason must resume without a second LLM call/seed.
    if (!piTask?.completionIntent) throw new Error('expected pending completion intent');
    await stateManager.updateTask(EVAL_ID, {
      status: 'pending',
      diagnosticJson: createPITaskDiagnosticJson({
        ...piTask,
        completionIntent: { ...piTask.completionIntent, status: 'pending' },
      }),
    });
    const resumedResult = await evaluator.run(EVAL_ID);
    expect(resumedResult.status).toBe('succeeded');
    expect(llmCalls).toHaveLength(1);
    expect(calls).toHaveLength(1);

    // The existing Artificer repair path receives the real current Owner pack;
    // its persisted stamp is system-restored from that pack, never model output.
    const ruleContext = {
      version: 2 as const,
      history: { status: 'available' as const, truncated: false, calls: [] },
      facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
    };
    const ownerNegative = {
      caseId: 'pack-neg', kind: 'negative' as const, toolName: 'write_file',
      params: { path: '/etc/passwd' }, expectedDecision: 'block' as const, ruleContext,
    };
    const ownerPositive = {
      caseId: 'pack-pos', kind: 'positive' as const, toolName: 'write_file',
      params: { path: '/workspace/a.ts' }, expectedDecision: 'allow' as const, ruleContext,
    };
    const behaviorExamplePack = {
      sourceNegativeCase: ownerNegative,
      ownerDesiredOutcome: 'Block writes to /etc/passwd; allow ordinary workspace writes.',
      positiveCounterexamples: [ownerPositive],
      evidenceRefs: ['pain://p758-owner-example'],
      redactionNotes: [],
    };
    const repairedRule = `function evaluate(input, helpers) {
      var p = input.action.normalizedPath || input.action.paramsSummary.path;
      if (p === '/etc/passwd') return { decision: 'block', matched: true, reason: 'Owner negative example' };
      return { decision: 'allow', matched: false, reason: 'Owner positive example' };
    }`;
    const artificerPayload = {
      taskId: REPAIR_ID,
      sourceScribeArtifactId: SCRIBE_ART,
      requiresContextVersion: 2,
      evidenceRefs: ['pain://p758-owner-example'],
      implementationSummary: 'Preserve the approved principle with Owner-backed cases.',
      sourceTrace: { scribeArtifactId: SCRIBE_ART },
      risks: [],
      implementationCode: repairedRule,
      goldenTraceCases: [ownerNegative, ownerPositive],
      affectedTools: ['write_file'],
      generatedAt: new Date().toISOString(),
    };
    const repairRunner = new ArtificerRunner(
      {
        stateManager,
        runtimeAdapter: scriptedAdapter(artificerPayload, 'run-owner-stamp-repair'),
        eventEmitter: emitter,
        artifactStore: store,
        validator: new DefaultArtificerValidator(),
        behaviorExamplePack,
      },
      {
        owner: 'p758', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000,
        effectiveConfig: effectiveConfig(),
      },
    );
    const repaired = await repairRunner.run(REPAIR_ID);
    expect(repaired.status).toBe('succeeded');
    const repairArtifacts = await store.listBySourceTaskId(REPAIR_ID);
    const repairArtifact = repairArtifacts.find((artifact) => artifact.artifactKind === 'principle');
    expect(repairArtifact).toBeDefined();
    if (!repairArtifact) return;
    const repairedContent: unknown = JSON.parse(repairArtifact.contentJson);
    expect(repairedContent).toMatchObject({ ownerGoldenTraceCases: [ownerNegative, ownerPositive] });

    const reopened = await orchestrator.commitNextTaskProposal(REPAIR_ID);
    expect(reopened).toMatchObject({ decision: 'revision_reopened', reopenedTaskId: EVAL_ID });
    const reopenedTask = await stateManager.getTask(EVAL_ID);
    expect(reopenedTask?.status).toBe('pending');
    const reopenedPi = reopenedTask ? hydratePITaskRecord(reopenedTask) : null;
    expect(reopenedPi?.dependencyTaskIds).toEqual([REPAIR_ID]);
    expect(reopenedPi?.runnerDecision).toBeUndefined();
    expect(reopenedPi?.completionIntent).toBeUndefined();

    const finalEvaluator = makeEvaluator({
      approved: true,
      repairEnabled: false,
      seeds: calls,
      llmCalls,
      sourceArtificerArtifactId: repairArtifact.artifactId,
      runId: 'run-p758-after-owner-repair',
      repairRound: true,
    });
    const finalResult = await finalEvaluator.run(EVAL_ID);
    expect(finalResult.status).toBe('succeeded');
    const finalArtifacts = await store.listBySourceTaskId(EVAL_ID);
    const finalPrinciple = finalArtifacts.find((artifact) => artifact.artifactKind === 'principle');
    expect(finalPrinciple).toBeDefined();
    if (!finalPrinciple) return;
    const finalOutput: unknown = JSON.parse(finalPrinciple.contentJson);
    expect(finalOutput).toMatchObject({ adversarialResult: { passed: true, failedCases: [] } });
    expect(finalArtifacts.some((artifact) => artifact.artifactKind === 'rule' && artifact.validationStatus === 'validated')).toBe(true);
    const advanced = await orchestrator.commitNextTaskProposal(EVAL_ID);
    expect(advanced).toMatchObject({ decision: 'successor_created', sourceTaskId: EVAL_ID, successorKind: 'rollout_reviewer' });
    if (advanced.decision !== 'successor_created') return;
    const rolloutTask = await stateManager.getTask(advanced.successorTaskId);
    expect(rolloutTask?.taskKind).toBe('rollout_reviewer');
    const rolloutPi = rolloutTask ? hydratePITaskRecord(rolloutTask) : null;
    expect(rolloutPi?.dependencyTaskIds).toContain(EVAL_ID);
    expect(llmCalls).toHaveLength(2);
  });
});
