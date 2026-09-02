/**
 * PRI-634 PR-A — Runner-level deterministic regression (SPEC §31/§35/§38).
 *
 * The full self-healing closure, through REAL production components:
 *
 *   Round 1: Artificer emits RuleCode calling input.action.paramsSummary.includes(...)
 *            → REAL deterministic replay (createProductionGateDeps, node:vm)
 *            → every case fails runtime_error ("…includes is not a function")
 *            → Evaluator artifact durably carries concrete failed-case evidence
 *              (caseId / expectedDecision / errorType / message; no fabricated
 *              actualDecision)
 *            → repair task seeded with diagnosticReplay {ran:true, passed:false}
 *
 *   Repair:   ArtificerRunner.buildContext resolves the evidence BY REFERENCE
 *            from the source Evaluator artifact (intent-runId artifact
 *            identity) — with all three Progressive Disclosure flags OFF —
 *            and the repair prompt contains the concrete case details.
 *
 *   Round 2: Artificer emits correct RuleCode → evaluator approved → REAL
 *            replay PASSES all cases (incl. the 5 canonical v2 adversarial
 *            cases) → formal pi-rule-* artifact assembled + validated.
 *
 * No mock gate, no hand-written artifacts, no DB writes outside the runners.
 * The only scripted component is the LLM (allowed: deterministic failure
 * injection per SPEC §37).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { ArtificerRunner } from '../artificer-runner.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import { DefaultArtificerValidator } from '../artificer-output.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { createProductionGateDeps } from '../../activation/production-gate-deps.js';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '../../config/pd-config-feature-flags.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let emitter: StoreEventEmitter;
let emitted: { eventType: string; payload: Record<string, unknown> }[];
let store: SqlitePIArtifactStore;

const SCRIBE_ID = 'scribe-rr';
const ART1_ID = 'artificer-rr1';
const EVAL1_ID = 'evaluator-rr1';
const REPAIR_ID = 'artificer-repair-rr1';
const EVAL2_ID = 'evaluator-rr2';
const SCRIBE_ART = 'pi-art-scribe-rr';

/** Round-1 RuleCode: the classic whole-object string-method bug. */
const BAD_RULE_CODE = `function evaluate(input, helpers) {
  if (input.action.paramsSummary.includes('/etc/passwd')) {
    return { decision: 'block', matched: true, reason: 'risk path' };
  }
  return { decision: 'allow', matched: false, reason: 'safe path' };
}`;

/** Round-2 RuleCode: risk-path dominance + read-before-write via context facts.
 * Reads params via guarded key access — the exact pattern the repaired
 * prompt contract teaches (contrast with the BAD code's string-method call). */
const GOOD_RULE_CODE = `function evaluate(input, helpers) {
  var rawPath = input.action.paramsSummary.path;
  var p = (typeof rawPath === 'string') ? rawPath : (input.action.normalizedPath || '');
  if (p.indexOf('/etc/') === 0 || p === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: 'risk path dominates prior context' };
  }
  var ctx = input.context;
  if (ctx && ctx.facts && ctx.facts.priorReadOfTarget === 'no') {
    return { decision: 'block', matched: true, reason: 'write target was not read first' };
  }
  return { decision: 'allow', matched: false, reason: 'no risk signal' };
}`;

const GOLDEN_TRACE_CASES = [
  { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
  { caseId: 'pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/workspace/src/a.ts' }, expectedDecision: 'allow' },
];

function flagsOffConfig(): EffectivePdConfig {
  return {
    config: {
      version: 1,
      features: {
        artifact_summary_redundancy: { category: 'quiet', enabled: false },
        context_manifest_budget: { category: 'quiet', enabled: false },
        progressive_evaluator: { category: 'quiet', enabled: false },
      },
      runtimeProfiles: {},
      internalAgents: {},
      ui: { diagnostics: { mode: 'simple' } },
    },
    source: 'user_config',
    warnings: [],
    resolvedContextInjection: {
      thinkingOs: false,
      projectFocus: 'off',
      evolutionContext: { enabled: true, maxMessages: 4, maxCharsPerMessage: 200 },
    },
  } as unknown as EffectivePdConfig;
}

function artificerOutput(implementationCode: string, scribeArtifactId: string, taskId: string): unknown {
  return {
    taskId,
    sourceScribeArtifactId: scribeArtifactId,
    implementationSummary: 'read-before-write guard',
    sourceTrace: { scribeArtifactId: scribeArtifactId },
    risks: [],
    implementationCode,
    goldenTraceCases: GOLDEN_TRACE_CASES,
    affectedTools: ['write_file'],
    generatedAt: new Date().toISOString(),
  };
}

function evaluatorOutput(taskId: string, artificerArtifactId: string, decision: 'approved' | 'needs_revision'): unknown {
  return {
    taskId,
    sourceArtificerArtifactId: artificerArtifactId,
    evaluation: {
      decision,
      summary: 'repair-replay regression',
      score: decision === 'approved' ? 0.9 : 0.6,
      strengths: [],
      concerns: decision === 'needs_revision' ? ['paramsSummary misuse'] : [],
      requiredChanges: decision === 'needs_revision' ? ['Fix the paramsSummary string-method crash'] : [],
      // PRI-630 convergence: the round-2 evaluator adjudicates the round-1
      // requirement (req-1 = the round-1 requiredChange, sequential id).
      ...(taskId === EVAL2_ID
        ? {
            priorRequirementStatuses: [{ id: 'req-1', status: 'resolved' }],
            requirementLedger: [{ id: 'req-1', statement: 'Fix the paramsSummary string-method crash', status: 'resolved' }],
          }
        : {}),
    },
    sourceTrace: { artificerArtifactId, scribeArtifactId: SCRIBE_ART },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

/** Scripted LLM adapter that records every prompt it receives. */
function scriptedAdapter(payload: unknown, prompts: string[], runId: string): PDRuntimeAdapter {
  return {
    startRun: async (req: { inputPayload: unknown }) => {
      prompts.push(String(req.inputPayload));
      return { runId, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    },
    pollRun: async () => ({ status: 'succeeded', runId }),
    fetchOutput: async () => ({ runId, payload }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

function meta(o: Record<string, unknown> = {}): string {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
    inputArtifactRefs: [], outputArtifactRefs: [], ...o,
  });
}

interface MkTaskSpec {
  readonly id: string;
  readonly kind: string;
  readonly deps: readonly string[];
  readonly diagnosticJson?: string;
}

async function mkTask(spec: MkTaskSpec): Promise<void> {
  await stateManager.createTask({
    taskId: spec.id, taskKind: spec.kind, status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: spec.diagnosticJson ?? meta({ dependencyTaskIds: spec.deps }),
  });
}

async function succeed(id: string): Promise<void> {
  await stateManager.acquireLease({ taskId: id, owner: 'rr-test', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(id);
}

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-repair-replay-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  emitter = new StoreEventEmitter();
  emitted = [];
  emitter.onTelemetry((event) => {
    emitted.push({ eventType: event.eventType, payload: event.payload });
  });
  store = new SqlitePIArtifactStore(new SqliteConnection(workspaceDir));
});

afterEach(async () => {
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

describe('PRI-634 PR-A: FAIL → durable evidence → repair retrieval → PASS → pi-rule (flags OFF)', () => {
  it('closes the full self-healing loop through the REAL deterministic replay gate', async () => {
    // SPEC §38 acceptance: prove the fix works with all Progressive
    // Disclosure quiet features explicitly OFF (they default off; pin them).
    const flags = computeFeatureFlagsFromConfig(flagsOffConfig());
    expect(isFeatureEnabled(flags, 'artifact_summary_redundancy')).toBe(false);
    expect(isFeatureEnabled(flags, 'context_manifest_budget')).toBe(false);
    expect(isFeatureEnabled(flags, 'progressive_evaluator')).toBe(false);

    // ── lineage: scribe task + artifact ──
    await mkTask({ id: SCRIBE_ID, kind: 'scribe', deps: [] });
    await succeed(SCRIBE_ID);
    await store.upsertArtifact({
      artifactId: SCRIBE_ART, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: JSON.stringify({ principleId: 'pri-rr-read-before-write', principleDraft: { statement: 'Read a file before writing it.' }, sourceTrace: {} }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // ── Round 1: Artificer emits the paramsSummary string-method bug ──
    await mkTask({ id: ART1_ID, kind: 'artificer', deps: [SCRIBE_ID] });
    const artPrompts: string[] = [];
    const artificer1 = new ArtificerRunner(
      {
        stateManager,
        runtimeAdapter: scriptedAdapter(artificerOutput(BAD_RULE_CODE, SCRIBE_ART, ART1_ID), artPrompts, 'run-art-1'),
        eventEmitter: emitter,
        artifactStore: store,
        validator: new DefaultArtificerValidator(),
      },
      { owner: 'rr-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000, effectiveConfig: flagsOffConfig() },
    );
    const art1Result = await artificer1.run(ART1_ID);
    expect(art1Result.status).toBe('succeeded');
    const art1Artifacts = await store.listBySourceTaskId(ART1_ID);
    const art1Artifact = art1Artifacts.find((a) => a.artifactKind === 'principle');
    expect(art1Artifact).toBeDefined();
    if (!art1Artifact) return;

    // ── Round 1: Evaluator needs_revision + REAL diagnostic replay ──
    await mkTask({ id: EVAL1_ID, kind: 'evaluator', deps: [ART1_ID] });
    const evalPrompts: string[] = [];
    const seededRepair: { payload?: Record<string, unknown> } = {};
    const evaluator1 = new EvaluatorRunner(
      {
        stateManager,
        runtimeAdapter: scriptedAdapter(evaluatorOutput(EVAL1_ID, art1Artifact.artifactId, 'needs_revision'), evalPrompts, 'run-eval-1'),
        eventEmitter: emitter,
        artifactStore: store,
        validator: new DefaultEvaluatorValidator(),
        isRepairLoopEnabled: () => true,
        seedArtificerRepairTask: async (params) => {
          seededRepair.payload = params.repairPayload as unknown as Record<string, unknown>;
          // Plugin-style seeder: real task row carrying the repairPayload.
          await mkTask({ id: REPAIR_ID, kind: 'artificer', deps: params.inheritedDependencyTaskIds, diagnosticJson: meta({
            dependencyTaskIds: params.inheritedDependencyTaskIds,
            repairPayload: params.repairPayload,
          }) });
          return REPAIR_ID;
        },
      },
      {
        owner: 'rr-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000,
        gateDeps: createProductionGateDeps(), // REAL deterministic replay — no stubs
        // EvaluatorRunner takes no effectiveConfig — base-runner flag helpers
        // default to legacy (all three quiet flags OFF) without it.
      },
    );
    const eval1Result = await evaluator1.run(EVAL1_ID);
    expect(eval1Result.status).toBe('succeeded');

    // (1) The durable Evaluator artifact carries CONCRETE replay evidence.
    const eval1Artifacts = await store.listBySourceTaskId(EVAL1_ID);
    const eval1Artifact = eval1Artifacts.find((a) => a.artifactKind === 'principle');
    expect(eval1Artifact).toBeDefined();
    if (!eval1Artifact) return;
    const eval1Content = JSON.parse(eval1Artifact.contentJson) as {
      evaluation?: { decision?: string };
      adversarialResult?: {
        passed?: boolean;
        failedCases?: Record<string, unknown>[];
      };
    };
    expect(eval1Content.evaluation?.decision).toBe('needs_revision'); // verdict not overridden
    expect(eval1Content.adversarialResult?.passed).toBe(false);
    const failedCases = eval1Content.adversarialResult?.failedCases ?? [];
    expect(failedCases.length).toBeGreaterThanOrEqual(5); // 5 v2 cases at minimum all crashed
    for (const failure of failedCases) {
      expect(typeof failure.errorType).toBe('string');           // SPEC §14: errorType is its own field
      expect(failure.errorType).toBe('runtime_error');
      expect(failure.actualDecision).toBeUndefined();            // no fabricated decision on throws
      expect(typeof failure.message).toBe('string');
    }
    const v2Unavailable = failedCases.find((f) => f.caseId === 'v2-unavailable');
    expect(v2Unavailable).toBeDefined();
    if (!v2Unavailable) return;
    expect(v2Unavailable.expectedDecision).toBe('allow');
    expect(String(v2Unavailable.message)).toContain('includes is not a function');

    // (2) The repair round was seeded with the bounded control summary only.
    expect(seededRepair.payload).toBeDefined();
    const seededRepairPayload = seededRepair.payload;
    if (seededRepairPayload === undefined) return;
    expect(seededRepairPayload.diagnosticReplay).toEqual({ ran: true, passed: false, failedCaseCount: failedCases.length });
    expect(seededRepairPayload.sourceEvaluatorTaskId).toBe(EVAL1_ID);
    // RepairPayload must NOT carry full failedCases (SPEC §21/§24).
    expect(Object.hasOwn(seededRepairPayload, 'failedCases')).toBe(false);

    // (3) Repair round: ArtificerRunner resolves the evidence BY REFERENCE and
    // the prompt contains the concrete case details — flags OFF.
    const repairPrompts: string[] = [];
    const artificerRepair = new ArtificerRunner(
      {
        stateManager,
        runtimeAdapter: scriptedAdapter(artificerOutput(GOOD_RULE_CODE, SCRIBE_ART, REPAIR_ID), repairPrompts, 'run-repair-1'),
        eventEmitter: emitter,
        artifactStore: store,
        validator: new DefaultArtificerValidator(),
      },
      { owner: 'rr-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000, effectiveConfig: flagsOffConfig() },
    );
    const repairResult = await artificerRepair.run(REPAIR_ID);
    expect(repairResult.status).toBe('succeeded');

    expect(repairPrompts).toHaveLength(1);
    const [repairPrompt] = repairPrompts;
    if (repairPrompt === undefined) return;
    expect(repairPrompt).toContain('Deterministic Replay Evidence (resolved by reference from evaluator artifact');
    expect(repairPrompt).toContain(`Case: v2-unavailable`);
    expect(repairPrompt).toContain('Expected: allow');
    expect(repairPrompt).toContain('Error: runtime_error');
    expect(repairPrompt).toContain('includes is not a function');
    expect(repairPrompt).toContain(EVAL1_ID); // stable source reference in the evidence header
    expect(emitted.some((e) => e.eventType === 'artificer_repair_replay_evidence_resolved')).toBe(true);

    const repairArtifacts = await store.listBySourceTaskId(REPAIR_ID);
    const repairArtifact = repairArtifacts.find((a) => a.artifactKind === 'principle');
    expect(repairArtifact).toBeDefined();
    if (!repairArtifact) return;

    // ── Round 2: Evaluator approves the repaired code → REAL replay PASSES → pi-rule ──
    await mkTask({ id: EVAL2_ID, kind: 'evaluator', deps: [REPAIR_ID] });
    const evaluator2 = new EvaluatorRunner(
      {
        stateManager,
        runtimeAdapter: scriptedAdapter(evaluatorOutput(EVAL2_ID, repairArtifact.artifactId, 'approved'), [], 'run-eval-2'),
        eventEmitter: emitter,
        artifactStore: store,
        validator: new DefaultEvaluatorValidator(),
      },
      {
        owner: 'rr-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000,
        gateDeps: createProductionGateDeps(), // REAL gate again
      },
    );
    const eval2Result = await evaluator2.run(EVAL2_ID);
    expect(eval2Result.status).toBe('succeeded');

    const eval2Artifacts = await store.listBySourceTaskId(EVAL2_ID);
    const ruleArtifact = eval2Artifacts.find((a) => a.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    if (!ruleArtifact) return;
    expect(ruleArtifact.artifactId).toContain('pi-rule-');
    expect(ruleArtifact.validationStatus).toBe('validated');

    // The repaired code replayed clean: adversarialResult.passed=true durable.
    const eval2Principle = eval2Artifacts.find((a) => a.artifactKind === 'principle');
    const eval2Content = JSON.parse((eval2Principle ?? { contentJson: '{}' }).contentJson) as { adversarialResult?: { passed?: boolean; failedCases?: unknown[] } };
    expect(eval2Content.adversarialResult?.passed).toBe(true);
    expect(eval2Content.adversarialResult?.failedCases).toHaveLength(0);
  });

  it('missing replay evidence fails loud — no blind LLM repair round (SPEC §27)', async () => {
    // Build a repair task whose diagnosticReplay says FAILED but whose source
    // evaluator artifact does not exist.
    await mkTask({ id: SCRIBE_ID, kind: 'scribe', deps: [] });
    await succeed(SCRIBE_ID);
    await store.upsertArtifact({
      artifactId: SCRIBE_ART, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: JSON.stringify({ principleDraft: { statement: 'x' } }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await mkTask({ id: 'evaluator-ghost', kind: 'evaluator', deps: [] }); // no artifacts for this task
    await stateManager.deleteTask?.('evaluator-ghost').catch(() => undefined);

    await mkTask({ id: REPAIR_ID, kind: 'artificer', deps: [SCRIBE_ID], diagnosticJson: meta({
      dependencyTaskIds: [SCRIBE_ID],
      repairPayload: {
        requiredChanges: ['fix it'],
        concerns: [],
        previousScore: 0.5,
        repairIteration: 1,
        sourceArtificerArtifactId: 'pi-art-ghost',
        sourceEvaluatorTaskId: 'evaluator-ghost',
        diagnosticReplay: { ran: true, passed: false, failedCaseCount: 3 },
      },
    }) });

    const repairPrompts: string[] = [];
    const artificerRepair = new ArtificerRunner(
      {
        stateManager,
        runtimeAdapter: scriptedAdapter(artificerOutput(GOOD_RULE_CODE, SCRIBE_ART, REPAIR_ID), repairPrompts, 'run-repair-x'),
        eventEmitter: emitter,
        artifactStore: store,
        validator: new DefaultArtificerValidator(),
      },
      { owner: 'rr-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000, effectiveConfig: flagsOffConfig() },
    );
    const result = await artificerRepair.run(REPAIR_ID);

    // Fail loud BEFORE any LLM call: no prompt consumed, structured evidence.
    expect(result.status).toBe('failed');
    expect(repairPrompts).toHaveLength(0);
    expect(result.failureReason).toContain('repair_replay_evidence_unavailable');
    expect(emitted.some((e) => e.eventType === 'artificer_repair_replay_evidence_unavailable')).toBe(true);
  });

  it('diagnosticReplay absent (replay never ran) keeps legacy repair behavior — no resolver, no fail', async () => {
    await mkTask({ id: SCRIBE_ID, kind: 'scribe', deps: [] });
    await succeed(SCRIBE_ID);
    await store.upsertArtifact({
      artifactId: SCRIBE_ART, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: JSON.stringify({ principleDraft: { statement: 'x' } }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await mkTask({ id: REPAIR_ID, kind: 'artificer', deps: [SCRIBE_ID], diagnosticJson: meta({
      dependencyTaskIds: [SCRIBE_ID],
      repairPayload: {
        requiredChanges: ['improve matcher'],
        concerns: ['scope too broad'],
        previousScore: 0.4,
        repairIteration: 1,
        sourceArtificerArtifactId: 'pi-art-old',
        sourceEvaluatorTaskId: 'evaluator-old-no-replay',
        // no diagnosticReplay — the rejecting round never ran a deterministic replay
      },
    }) });

    const repairPrompts: string[] = [];
    const artificerRepair = new ArtificerRunner(
      {
        stateManager,
        runtimeAdapter: scriptedAdapter(artificerOutput(GOOD_RULE_CODE, SCRIBE_ART, REPAIR_ID), repairPrompts, 'run-repair-y'),
        eventEmitter: emitter,
        artifactStore: store,
        validator: new DefaultArtificerValidator(),
      },
      { owner: 'rr-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000, effectiveConfig: flagsOffConfig() },
    );
    const result = await artificerRepair.run(REPAIR_ID);
    expect(result.status).toBe('succeeded');
    expect(repairPrompts).toHaveLength(1);
    // No dynamic evidence block (assert on the resolved-evidence header, not
    // the instruction paragraph which always names the block), but evaluator
    // semantic feedback still present.
    expect(repairPrompts[0]).not.toContain('Deterministic Replay Evidence (resolved by reference from evaluator artifact');
    expect(repairPrompts[0]).toContain('Required changes');
  });
});
