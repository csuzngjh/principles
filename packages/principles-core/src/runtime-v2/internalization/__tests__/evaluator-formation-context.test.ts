/**
 * PRI-843 — Evaluator Formation Context Connection (production-path tests).
 *
 * Two layers:
 *   1. Prompt contract (unit): conditional injection keeps a no-formation run
 *      byte-identical to the pre-PRI-843 shape; a formation run carries the
 *      bounded projection and the system-channel addendum.
 *   2. Golden replay (real production components — RuntimeStateManager +
 *      SqlitePIArtifactStore + real EvaluatorRunner; only the LLM adapter is
 *      scripted):
 *        Case A  Principle/Rule consistent with the pain → approved
 *        Case B  Rule deviates from Principle (no mismatch marker) → repair
 *                seeded as before — the mismatch route must not hijack it
 *        Case C  Principle does not address the Pain (marked concern) →
 *                needs_human_review(principle_pain_mismatch), NO repair seed
 *
 * Plus the contract's guard rails: the hallucination guard (marker without
 * formation evidence is ignored), the contextHash coverage over formation
 * lineage ids, and restart-stable disposition (resume re-materializes the
 * same NHR without re-asking the LLM).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import {
  EvaluatorPromptBuilder,
  EVALUATOR_PROTOCOL_INSTRUCTION,
  EVALUATOR_FORMATION_EVIDENCE_ADDENDUM,
  EVALUATOR_PROMPT_CONTRACT_VERSION,
  PRINCIPLE_PAIN_MISMATCH_MARKER,
} from '../evaluator-prompt-builder.js';
import { HUMAN_REVIEW_REASON } from '../owner-review.js';
import type { FormationContext } from '../formation-context.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { createPITaskDiagnosticJson, hydratePITaskRecord } from '../pitask-metadata.js';
import { createProductionGateDeps } from '../../activation/production-gate-deps.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const DIAG_ID = 'diag-router-fc';
const DREAMER_ID = 'dreamer-fc';
const SCRIBE_ID = 'scribe-fc';
const ART_ID = 'artificer-fc';
const EVAL_ID = 'evaluator-fc';
const REPAIR_ID = 'artificer-repair-fc';
const DIAG_ART = 'pi-art-diag-router-fc';
const DREAMER_ART = 'pi-art-dreamer-fc';
const SCRIBE_ART = 'pi-art-scribe-fc';

const DIAGNOSIS_CONTENT = {
  valid: true,
  diagnosisId: 'diag-fc',
  summary: 'config contract guessed from example files',
  rootCause: 'agent inferred a configuration contract from example files instead of reading the authoritative one',
  violatedPrinciples: [
    { principleId: 'T-03', title: 'Evidence first', rationale: 'contracts must be read, not guessed' },
  ],
  evidence: [
    { sourceRef: 'trajectory://session-fc/turn-4', note: 'wrote a config without reading the contract' },
  ],
  recommendations: [
    { kind: 'principle', description: 'read the authoritative contract before mutating config' },
  ],
  confidence: 0.8,
};

const DREAMER_CONTENT = {
  valid: true,
  taskId: DREAMER_ID,
  candidates: [
    {
      candidateIndex: 0,
      badDecision: 'agent wrote config without validating the contract',
      betterDecision: 'resolve and read the authoritative contract before writing',
      rationale: 'guessing contracts produces silent drift',
      confidence: 0.4,
      riskLevel: 'high',
      strategicPerspective: 'defensive',
    },
    {
      candidateIndex: 1,
      badDecision: 'agent kept two sources of truth',
      betterDecision: 'keep one authoritative contract per surface',
      rationale: 'duplicate contracts drift apart',
      confidence: 0.9,
      riskLevel: 'low',
      strategicPerspective: 'evidence-first',
    },
  ],
  sourcePainId: 'pain-fc-1',
  contextRefs: ['pi-art-pain-fc-1'],
  generatedAt: '2026-09-19T00:00:00.000Z',
};

/** Scribe principle artifact — the AUTHORITATIVE dreamer lineage carrier. */
function scribeContent(withDreamerLineage: boolean): Record<string, unknown> {
  return {
    principleId: 'contract-first',
    principleDraft: {
      title: 'Contract before mutation',
      statement: 'Read the authoritative configuration contract before mutating any config surface.',
      rationale: 'Guessed contracts drift silently from owner intent.',
      applicability: ['config mutation'],
      antiPatterns: ['inferring contracts from example files'],
      confidence: 0.8,
    },
    intentContract: {
      ownerIntent: 'the agent must not guess configuration contracts',
      targetBehavior: 'read the authoritative contract before mutating config',
      forbiddenBehavior: 'inferring a contract from examples and writing anyway',
      evidenceSource: 'pain-fc-1 / diag-fc rootCause',
      validationExpectation: 'rule blocks config writes that skip the contract read',
    },
    ...(withDreamerLineage ? { sourceTrace: { dreamerArtifactId: DREAMER_ART, philosopherArtifactId: 'pi-art-phil-fc' } } : {}),
  };
}

/** v1 (non-code-bearing) artificer artifact — keeps the deterministic replay out of scope. */
function artificerOutput(): Record<string, unknown> {
  return {
    taskId: ART_ID,
    sourceScribeArtifactId: SCRIBE_ART,
    implementationSummary: 'contract-first gate',
    sourceTrace: { scribeArtifactId: SCRIBE_ART },
    risks: [],
    goldenTraceCases: [
      { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/app/config.json' }, expectedDecision: 'block' },
      { caseId: 'pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/app/src/a.ts' }, expectedDecision: 'allow' },
    ],
    affectedTools: ['write_file'],
    generatedAt: '2026-09-19T00:00:00.000Z',
  };
}

type EvaluatorDecision = 'approved' | 'needs_revision' | 'rejected';

function evaluatorOutput(decision: EvaluatorDecision, concerns: string[], requiredChanges: string[]): Record<string, unknown> {
  return {
    taskId: EVAL_ID,
    sourceArtificerArtifactId: `pi-art-${ART_ID}-seed`,
    evaluation: {
      decision,
      summary: 'pri-843 golden replay',
      score: decision === 'approved' ? 0.9 : 0.6,
      strengths: [],
      concerns,
      requiredChanges,
    },
    sourceTrace: { artificerArtifactId: `pi-art-${ART_ID}-seed`, scribeArtifactId: SCRIBE_ART },
    risks: [],
    generatedAt: '2026-09-19T00:00:00.000Z',
  };
}

/** Minimal in-budget FormationContext for builder-level unit tests. */
function unitFormationContext(): FormationContext {
  return {
    version: 'formation-context.v1',
    dreamerProposals: [
      {
        candidateIndex: 1,
        priorityRank: 1,
        badDecision: 'kept two sources of truth',
        betterDecision: 'keep one authoritative contract',
        rationale: 'duplicate contracts drift',
        confidence: 0.9,
        riskLevel: 'low',
        strategicPerspective: null,
      },
    ],
    dreamerContextRefs: [],
    sourceDiagnosis: {
      artifactId: DIAG_ART,
      taskId: DIAG_ID,
      stage: 'diag_router',
      rootCause: DIAGNOSIS_CONTENT.rootCause,
      summary: DIAGNOSIS_CONTENT.summary,
      violatedPrinciples: [],
      evidence: [{ sourceRef: 'trajectory://session-fc/turn-4', note: 'wrote without reading' }],
      recommendations: [],
      confidence: 0.8,
      omittedFields: [],
    },
    provenance: {
      sourceDreamerArtifactId: DREAMER_ART,
      sourceDreamerTaskId: DREAMER_ID,
      sourceDiagnosisArtifactId: DIAG_ART,
      sourceDiagnosisTaskId: DIAG_ID,
      sourcePainId: 'pain-fc-1',
      lineageArtifactIds: [DIAG_ART],
    },
    truncationNotes: [],
  };
}

// ── Layer 1: prompt contract (builder unit) ─────────────────────────────────

describe('PRI-843 — evaluator prompt contract (conditional formation injection)', () => {
  const builder = new EvaluatorPromptBuilder();
  const baseInput = {
    taskId: EVAL_ID,
    contextHash: 'ctx-fc',
    sourceArtificerArtifactId: 'pi-art-artificer-fc-seed',
    artificerArtifact: { taskId: ART_ID },
    scribeArtifact: scribeContent(true),
  };

  it('prompt contract version is v5', () => {
    expect(EVALUATOR_PROMPT_CONTRACT_VERSION).toBe('evaluator-output-v1.prompt.v5');
  });

  it('without formationContext the payload keeps the pre-PRI-843 shape (byte-identical) and the system prompt is unchanged', () => {
    const a = builder.buildPrompt(baseInput);
    const b = builder.buildPrompt(baseInput);
    expect(a.message).toBe(b.message);
    const parsed = JSON.parse(a.message) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'formationContext')).toBe(false);
    expect(a.systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION);
  });

  it('with formationContext the payload carries the bounded projection and the system prompt carries the addendum', () => {
    const { message, systemPrompt, promptInput } = builder.buildPrompt({
      ...baseInput,
      formationContext: unitFormationContext(),
    });
    const parsed = JSON.parse(message) as { formationContext?: FormationContext };
    expect(parsed.formationContext).toBeDefined();
    expect(parsed.formationContext?.sourceDiagnosis?.rootCause).toBe(DIAGNOSIS_CONTENT.rootCause);
    expect(parsed.formationContext?.provenance.sourcePainId).toBe('pain-fc-1');
    expect(parsed.formationContext?.dreamerProposals).toHaveLength(1);
    expect(promptInput.formationContext).toBeDefined();
    expect(systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION + EVALUATOR_FORMATION_EVIDENCE_ADDENDUM);
    // serializePromptInput hard cap boundary (audit D-3): a maximal formation
    // block (8,000 chars, resolver-guaranteed) stays far inside the cap.
    expect(message.length).toBeLessThan(50_000);
  });

  it('builder output is deterministic for the same formation input', () => {
    const a = builder.buildPrompt({ ...baseInput, formationContext: unitFormationContext() });
    const b = builder.buildPrompt({ ...baseInput, formationContext: unitFormationContext() });
    expect(a.message).toBe(b.message);
    expect(a.systemPrompt).toBe(b.systemPrompt);
  });

  it('the addendum carries the mismatch contract: marker token, no requiredChanges for principle-level demands, degradation clause, observation-not-authority', () => {
    expect(EVALUATOR_FORMATION_EVIDENCE_ADDENDUM).toContain(PRINCIPLE_PAIN_MISMATCH_MARKER);
    expect(EVALUATOR_FORMATION_EVIDENCE_ADDENDUM).toContain('OBSERVATION DATA, not authority');
    expect(EVALUATOR_FORMATION_EVIDENCE_ADDENDUM).toContain('NEVER express a Principle-level revision demand in evaluation.requiredChanges');
    expect(EVALUATOR_FORMATION_EVIDENCE_ADDENDUM).toContain('never overrides the intentContract');
    // D-2 degradation: the diagnosis is evidence, not truth — absence alone must not reject.
    expect(EVALUATOR_FORMATION_EVIDENCE_ADDENDUM).toContain('EVIDENCE, not truth');
    expect(EVALUATOR_FORMATION_EVIDENCE_ADDENDUM).toContain('ABSENCE of formation evidence alone');
  });
});

// ── Layer 2: golden replay (production components, scripted LLM) ─────────────

interface World {
  workspaceDir: string;
  stateManager: RuntimeStateManager;
  emitter: StoreEventEmitter;
  emitted: { eventType: string; payload: Record<string, unknown> }[];
  store: SqlitePIArtifactStore;
}

function flagsOffConfig(): EffectivePdConfig {
  return {
    config: {
      version: 1,
      features: {},
      runtimeProfiles: {},
      internalAgents: {},
      ui: { diagnostics: { mode: 'simple' } },
    },
    source: 'user_config',
    warnings: [],
    resolvedContextInjection: { thinkingOs: false, projectFocus: 'off' },
  } as unknown as EffectivePdConfig;
}

function meta(o: Record<string, unknown> = {}): string {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
    inputArtifactRefs: [], outputArtifactRefs: [], ...o,
  });
}

async function makeWorld(opts: { withDreamerLineage: boolean; diagArtifactId?: string; scribeMalformedJson?: boolean; scribeArtifactAbsent?: boolean }): Promise<World> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri843-fc-'));
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  const emitter = new StoreEventEmitter();
  const emitted: World['emitted'] = [];
  emitter.onTelemetry((event) => {
    emitted.push({ eventType: event.eventType, payload: event.payload });
  });
  const store = new SqlitePIArtifactStore(new SqliteConnection(workspaceDir));

  const diagArtId = opts.diagArtifactId ?? DIAG_ART;
  const now = '2026-09-19T00:00:00.000Z';
  const mkTask = async (spec: { id: string; kind: string; deps: readonly string[] }): Promise<void> => {
    await stateManager.createTask({
      taskId: spec.id, taskKind: spec.kind, status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: meta({ dependencyTaskIds: spec.deps }),
    });
    await stateManager.acquireLease({ taskId: spec.id, owner: 'pri843-test', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(spec.id);
  };
  const upsert = (spec: {
    artifactId: string;
    sourceTaskId: string;
    content: unknown;
    lineage: readonly string[];
  }): Promise<unknown> =>
    store.upsertArtifact({
      artifactId: spec.artifactId, artifactKind: 'principle', sourceTaskId: spec.sourceTaskId,
      lineageArtifactIds: [...spec.lineage],
      validationStatus: 'pending', contentJson: JSON.stringify(spec.content), createdAt: now, updatedAt: now,
    });

  await mkTask({ id: DIAG_ID, kind: 'diag_router', deps: [] });
  await upsert({ artifactId: diagArtId, sourceTaskId: DIAG_ID, content: DIAGNOSIS_CONTENT, lineage: [] });
  await mkTask({ id: DREAMER_ID, kind: 'dreamer', deps: [DIAG_ID] });
  await upsert({ artifactId: DREAMER_ART, sourceTaskId: DREAMER_ID, content: DREAMER_CONTENT, lineage: [diagArtId] });
  await mkTask({ id: SCRIBE_ID, kind: 'scribe', deps: [DREAMER_ID] });
  if (opts.scribeArtifactAbsent) {
    // The artificer's sourceTrace still points at SCRIBE_ART — the artifact
    // itself is missing, exercising the evaluator's unresolvable-scribe path.
  } else if (opts.scribeMalformedJson) {
    await store.upsertArtifact({
      artifactId: SCRIBE_ART, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
      lineageArtifactIds: [DREAMER_ART],
      validationStatus: 'pending', contentJson: '{"principleId": "contract-first", BROKEN',
      createdAt: now, updatedAt: now,
    });
  } else {
    await upsert({ artifactId: SCRIBE_ART, sourceTaskId: SCRIBE_ID, content: scribeContent(opts.withDreamerLineage), lineage: [DREAMER_ART] });
  }
  await mkTask({ id: ART_ID, kind: 'artificer', deps: [SCRIBE_ID] });
  await upsert({ artifactId: `pi-art-${ART_ID}-seed`, sourceTaskId: ART_ID, content: artificerOutput(), lineage: [SCRIBE_ART] });
  await stateManager.createTask({
    taskId: EVAL_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: meta({ dependencyTaskIds: [ART_ID] }),
  });

  return { workspaceDir, stateManager, emitter, emitted, store };
}

function closeWorld(world: World): void {
  void world.stateManager.close();
  try { fs.rmSync(world.workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
}

interface CapturedPrompt {
  message: string;
  systemPrompt: string;
}

function scriptedAdapter(payload: unknown, prompts: CapturedPrompt[], runId: string): PDRuntimeAdapter {
  return {
    startRun: async (req: { inputPayload: unknown; systemPrompt?: unknown }) => {
      prompts.push({ message: String(req.inputPayload), systemPrompt: typeof req.systemPrompt === 'string' ? req.systemPrompt : '' });
      return { runId, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    },
    pollRun: async () => ({ status: 'succeeded', runId }),
    fetchOutput: async () => ({ runId, payload }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

function reviewEvaluator(world: World, opts: {
  payload: unknown;
  prompts: CapturedPrompt[];
  seeds: string[];
}): EvaluatorRunner {
  const { payload, prompts, seeds } = opts;
  return new EvaluatorRunner({
    stateManager: world.stateManager,
    runtimeAdapter: scriptedAdapter(payload, prompts, 'eval-fc'),
    eventEmitter: world.emitter, artifactStore: world.store, validator: new DefaultEvaluatorValidator(),
    isRepairLoopEnabled: () => true,
    seedArtificerRepairTask: async (params) => {
      seeds.push(params.repairPayload.requiredChanges.join(';'));
      await world.stateManager.createTask({
        taskId: REPAIR_ID, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
        diagnosticJson: meta({ dependencyTaskIds: params.inheritedDependencyTaskIds, repairPayload: params.repairPayload }),
      });
      return REPAIR_ID;
    },
  }, {
    owner: 'pri843-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5000,
    gateDeps: createProductionGateDeps(), effectiveConfig: flagsOffConfig(),
  });
}

describe('PRI-843 — evaluator formation context golden replay (production path)', () => {
  let world: World;

  beforeEach(async () => {
    world = await makeWorld({ withDreamerLineage: true });
  });

  afterEach(() => {
    closeWorld(world);
  });

  it('Case A: pain-consistent chain → evaluator prompt carries the formation evidence; approved validates the scribe bearer; no human review', async () => {
    const prompts: CapturedPrompt[] = [];
    const seeds: string[] = [];
    const result = await reviewEvaluator(world, {
      payload: evaluatorOutput('approved', [], []),
      prompts, seeds,
    }).run(EVAL_ID);

    // The connection itself: pain/diagnosis/lineage reach the evaluator prompt.
    expect(prompts).toHaveLength(1);
    const parsed = JSON.parse(prompts[0]?.message ?? '{}') as { formationContext?: FormationContext };
    expect(parsed.formationContext).toBeDefined();
    expect(parsed.formationContext?.sourceDiagnosis?.rootCause).toBe(DIAGNOSIS_CONTENT.rootCause);
    expect(parsed.formationContext?.sourceDiagnosis?.evidence[0]?.sourceRef).toBe('trajectory://session-fc/turn-4');
    expect(parsed.formationContext?.dreamerProposals).toHaveLength(2);
    expect(parsed.formationContext?.provenance.sourceDreamerArtifactId).toBe(DREAMER_ART);
    expect(parsed.formationContext?.provenance.sourcePainId).toBe('pain-fc-1');
    expect(prompts[0]?.systemPrompt).toContain('FORMATION EVIDENCE');
    // Resolver observability (rc-9): the resolver's formation_context_resolved
    // event arrives under the runner-prefixed, union-registered name.
    expect(world.emitted.some((e) => e.eventType === 'evaluator_formation_context_resolved')).toBe(true);

    // Governance unchanged: approved → scribe bearer validated, task succeeded.
    expect(result.status).toBe('succeeded');
    const task = await world.stateManager.getTask(EVAL_ID);
    expect(task?.status).toBe('succeeded');
    const bearer = await world.store.getArtifactById(SCRIBE_ART);
    expect(bearer?.validationStatus).toBe('validated');
    expect(seeds).toHaveLength(0);
  });

  it('Case B: rule defect without a mismatch finding → repair seeded exactly as before (the mismatch route must not hijack it)', async () => {
    const prompts: CapturedPrompt[] = [];
    const seeds: string[] = [];
    const result = await reviewEvaluator(world, {
      payload: evaluatorOutput('needs_revision', ['gate too narrow'], ['Widen the match to sibling backup paths']),
      prompts, seeds,
    }).run(EVAL_ID);

    expect(seeds).toHaveLength(1);
    expect(result.status).toBe('succeeded');
    const task = await world.stateManager.getTask(EVAL_ID);
    expect(task?.status).not.toBe('needs_human_review');
    // Formation evidence was still injected — the reviewer simply found no principle-level gap.
    expect(JSON.parse(prompts[0]?.message ?? '{}').formationContext).toBeDefined();
  });

  it('Case C: Principle does not address the Pain (marked concern) → needs_human_review(principle_pain_mismatch), no repair seed, disposition durable', async () => {
    const prompts: CapturedPrompt[] = [];
    const seeds: string[] = [];
    const concern = `${PRINCIPLE_PAIN_MISMATCH_MARKER} Principle covers only a minor facet — diagnosis rootCause "${DIAGNOSIS_CONTENT.rootCause}" (evidence trajectory://session-fc/turn-4) is not addressed`;
    await reviewEvaluator(world, {
      payload: evaluatorOutput('needs_revision', [concern], ['Tighten the path guard']),
      prompts, seeds,
    }).run(EVAL_ID);

    // The death-loop guard: NO artificer repair task for a principle-level finding.
    expect(seeds).toHaveLength(0);
    const task = await world.stateManager.getTask(EVAL_ID);
    expect(task?.status).toBe('needs_human_review');
    const pi = task ? hydratePITaskRecord(task) : null;
    expect(pi?.humanReviewContext?.reasonCode).toBe(HUMAN_REVIEW_REASON.principlePainMismatch);
    expect(pi?.humanReviewContext?.reasonCode).toBe('principle_pain_mismatch');
    // Durable disposition (intent carries it — crash-resume replays the same effect).
    expect(pi?.completionIntent?.effect ?? pi?.completionIntent?.selectedEffect).toBe('needs_human_review');
    expect(pi?.completionIntent?.effectReasonCode).toBe('principle_pain_mismatch');
    expect(world.emitted.some((e) => e.eventType === 'evaluator_governance_effect_principle_pain_mismatch_selected')).toBe(true);
  });

  it('Case C (approved verdict): a marked finding preempts approved effects too — bearer stays pending, Owner decides', async () => {
    const prompts: CapturedPrompt[] = [];
    const seeds: string[] = [];
    await reviewEvaluator(world, {
      payload: evaluatorOutput('approved', [`${PRINCIPLE_PAIN_MISMATCH_MARKER} rule is fine but the principle misses the pain (pain-fc-1)`], []),
      prompts, seeds,
    }).run(EVAL_ID);

    expect(seeds).toHaveLength(0);
    const task = await world.stateManager.getTask(EVAL_ID);
    expect(task?.status).toBe('needs_human_review');
    const bearer = await world.store.getArtifactById(SCRIBE_ART);
    expect(bearer?.validationStatus).toBe('pending');
  });

  it('hallucination guard: without formation evidence the marker is ignored (legacy chain keeps the pre-PRI-843 flow)', async () => {
    const legacy = await makeWorld({ withDreamerLineage: false });
    try {
      const prompts: CapturedPrompt[] = [];
      const seeds: string[] = [];
      await reviewEvaluator(legacy, {
        payload: evaluatorOutput('needs_revision', [`${PRINCIPLE_PAIN_MISMATCH_MARKER} hallucinated marker without evidence`], ['Fix the gate']),
        prompts, seeds,
      }).run(EVAL_ID);

      // Degradation is observable in behavior (rc-9): the prompt keeps the
      // legacy shape — no formation block, no addendum — and the resolver's
      // skip event arrives under its union-registered name.
      expect(JSON.parse(prompts[0]?.message ?? '{}').formationContext).toBeUndefined();
      expect(prompts[0]?.systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION);
      expect(legacy.emitted.some((e) => e.eventType === 'evaluator_formation_context_skipped')).toBe(true);
      // The marker cannot route without evidence: normal repair flow, no NHR.
      expect(seeds).toHaveLength(1);
      const task = await legacy.stateManager.getTask(EVAL_ID);
      expect(task?.status).not.toBe('needs_human_review');
    } finally {
      closeWorld(legacy);
    }
  });

  it('degraded path: unreadable scribe contentJson (malformed JSON) keeps the legacy prompt shape and skips the resolver observably', async () => {
    const broken = await makeWorld({ withDreamerLineage: true, scribeMalformedJson: true });
    try {
      const prompts: CapturedPrompt[] = [];
      const seeds: string[] = [];
      await reviewEvaluator(broken, {
        payload: evaluatorOutput('needs_revision', ['gate too narrow'], ['Fix the gate']),
        prompts, seeds,
      }).run(EVAL_ID);

      expect(JSON.parse(prompts[0]?.message ?? '{}').formationContext).toBeUndefined();
      expect(prompts[0]?.systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION);
      expect(broken.emitted.some((e) => e.eventType === 'evaluator_formation_context_skipped')).toBe(true);
      // The evaluation itself proceeds on the degraded (no-formation) basis.
      expect(seeds).toHaveLength(1);
    } finally {
      closeWorld(broken);
    }
  });

  it('degraded path: unresolvable scribe artifact (lineage points nowhere) keeps the legacy prompt shape and skips the resolver observably', async () => {
    const broken = await makeWorld({ withDreamerLineage: false, scribeArtifactAbsent: true });
    try {
      const prompts: CapturedPrompt[] = [];
      const seeds: string[] = [];
      await reviewEvaluator(broken, {
        payload: evaluatorOutput('needs_revision', ['gate too narrow'], ['Fix the gate']),
        prompts, seeds,
      }).run(EVAL_ID);

      expect(JSON.parse(prompts[0]?.message ?? '{}').formationContext).toBeUndefined();
      expect(prompts[0]?.systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION);
      expect(broken.emitted.some((e) => e.eventType === 'evaluator_scribe_artifact_unresolvable')).toBe(true);
      expect(broken.emitted.some((e) => e.eventType === 'evaluator_formation_context_skipped')).toBe(true);
      expect(seeds).toHaveLength(1);
    } finally {
      closeWorld(broken);
    }
  });

  it('contextHash covers the formation lineage: differing diagnosis artifact identity ⇒ differing context hash', async () => {
    const worldA = await makeWorld({ withDreamerLineage: true, diagArtifactId: 'pi-art-diag-fc-A' });
    const worldB = await makeWorld({ withDreamerLineage: true, diagArtifactId: 'pi-art-diag-fc-B' });
    try {
      const runnerFor = (w: World): EvaluatorRunner => reviewEvaluator(w, { payload: evaluatorOutput('approved', [], []), prompts: [], seeds: [] });
      const ctxA = await runnerFor(worldA).buildContext(EVAL_ID);
      const ctxB = await runnerFor(worldB).buildContext(EVAL_ID);
      expect(ctxA.formationContext).toBeDefined();
      expect(ctxB.formationContext).toBeDefined();
      expect(ctxA.contextHash).not.toBe(ctxB.contextHash);
      expect(ctxA.sourceScribeArtifactId).toBe(SCRIBE_ART);
    } finally {
      closeWorld(worldA);
      closeWorld(worldB);
    }
  });

  it('restart-stable: after a requeue the resumed run re-materializes the same NHR without re-asking the LLM or seeding repair', async () => {
    const prompts: CapturedPrompt[] = [];
    const seeds: string[] = [];
    const runner = () => reviewEvaluator(world, {
      payload: evaluatorOutput('needs_revision', [`${PRINCIPLE_PAIN_MISMATCH_MARKER} principle misses pain-fc-1`], ['Tighten the guard']),
      prompts, seeds,
    });
    await runner().run(EVAL_ID);
    expect(prompts).toHaveLength(1);

    // Simulated restart: task requeued, fresh runner instance resumes.
    await world.stateManager.updateTask(EVAL_ID, { status: 'pending', leaseOwner: null, leaseExpiresAt: null });
    await runner().run(EVAL_ID);

    const task = await world.stateManager.getTask(EVAL_ID);
    const pi = task ? hydratePITaskRecord(task) : null;
    expect(task?.status).toBe('needs_human_review');
    expect(pi?.humanReviewContext?.reasonCode).toBe('principle_pain_mismatch');
    expect(pi?.completionIntent?.status).toBe('applied');
    expect(prompts).toHaveLength(1); // no LLM re-ask
    expect(seeds).toHaveLength(0); // no repair seeded
  });
});
