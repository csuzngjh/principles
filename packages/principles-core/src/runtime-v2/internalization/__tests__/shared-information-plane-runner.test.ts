/**
 * PR B — Shared Information Plane runner-level regression (SPEC §38/§40).
 *
 * Proves through REAL runners + REAL CandidateLineage (durable artifact rows in
 * an isolated temp SQLite — never a hand-stuffed available Map):
 *
 *   T-A  Normal Artificer, context_manifest_budget ON:
 *        ARTIFICER_MANIFEST tier2 (`dreamer.raw.candidates.0.*`) resolves from
 *        the durable Dreamer artifact through CandidateLineage ancestry, and
 *        the focused prompt does NOT leak repair/replay namespaces.
 *
 *   T-B  Evaluator Stage 2 (progressive_evaluator + context_manifest_budget ON):
 *        Stage 2's REQUIRED tier2 (`diagnostician.raw.evidence`,
 *        `dreamer.raw.candidates`) resolve from the durable ancestry chain —
 *        not silently absent (information floor §34/§35).
 *
 *   T-C  Artificer REPAIR round with the same flags ON:
 *        the replay evidence reaches the repair prompt through the
 *        ARTIFICER_REPAIR_MANIFEST RELATED channel (PR-A resolver reused, ≤16
 *        bound inherited) instead of the PR-A string channel, and the loop
 *        still closes FAIL → Repair → PASS → pi-rule.
 *
 * Flags-OFF behaviour is pinned by evaluator-artificer-repair-replay.test.ts
 * (PR A) which must keep passing unchanged (T-D).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { EvaluatorRunner, type SeedArtificerRepairParams } from '../evaluator-runner.js';
import { ArtificerRunner } from '../artificer-runner.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import { DefaultArtificerValidator } from '../artificer-output.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { createProductionGateDeps } from '../../activation/production-gate-deps.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let emitter: StoreEventEmitter;
let emitted: { eventType: string; payload: Record<string, unknown> }[];
let store: SqlitePIArtifactStore;

const DIAG_ID = 'diag-sip';
const DREAM_ID = 'dreamer-sip';
const PHIL_ID = 'philosopher-sip';
const SCRIBE_ID = 'scribe-sip';
const ART1_ID = 'artificer-sip1';
const EVAL1_ID = 'evaluator-sip1';
const REPAIR_ID = 'artificer-repair-sip';
const EVAL2_ID = 'evaluator-sip2';

const DIAG_ART = 'pi-art-diag-sip';
const DREAM_ART = 'pi-art-dream-sip';
const PHIL_ART = 'pi-art-phil-sip';
const SCRIBE_ART = 'pi-art-scribe-sip';
const ART1_ART = 'pi-art-art1-sip';

/** Marker resolvable ONLY through tier2 ancestry raw reads (T-A/T-B). */
const BETTER_DECISION_MARKER = 'ALWAYS-READ-BEFORE-WRITE-SIP-MARKER';
const PAIN_EVIDENCE_MARKER = 'PAIN-EVIDENCE-WITHOUT-READ-SIP-MARKER';
/** Field present ONLY in the full scribe contentJson — focused mode must not leak it. */
const SCRIBE_RAW_ONLY_MARKER = 'SCRIBE-RAW-ONLY-SIP-MARKER';

/** Round-2 RuleCode (identical to the PR-A regression fixture): risk-path
 * dominance + read-before-write via context facts. The adversarial generator
 * varies `context.facts`, so the second branch is what makes the real
 * deterministic replay pass. */
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

const BAD_RULE_CODE = `function evaluate(input, helpers) {
  if (input.action.paramsSummary.includes('/etc/passwd')) {
    return { decision: 'block', matched: true, reason: 'risk path' };
  }
  return { decision: 'allow', matched: false, reason: 'safe path' };
}`;

const GOLDEN_TRACE_CASES = [
  { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
  { caseId: 'pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/workspace/src/a.ts' }, expectedDecision: 'allow' },
];

function flagsConfig(allOn: boolean): EffectivePdConfig {
  return {
    config: {
      version: 1,
      features: {
        artifact_summary_redundancy: { category: 'quiet', enabled: allOn },
        context_manifest_budget: { category: 'quiet', enabled: allOn },
        progressive_evaluator: { category: 'quiet', enabled: allOn },
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

const FLAGS_ON = flagsConfig(true);

/** Layer 0 envelope matching the ArtifactSummary shape written under
 * artifact_summary_redundancy (artifact-summary.ts). */
function summaryEnvelope(runnerKind: string, headline: string, fields: Record<string, string>): unknown {
  return {
    schemaVersion: 1,
    runnerKind,
    headline,
    fields,
    derivedFrom: 'structured_output',
    omittedFields: [],
  };
}

// eslint-disable-next-line @typescript-eslint/max-params -- compact regression-fixture DSL: positional (id, kind, content) reads better at 20 call sites than an options object; same rule tolerance as attach-summary-envelope.ts
async function upsertArtifact(artifactId: string, sourceTaskId: string, lineageArtifactIds: string[], content: unknown): Promise<void> {
  const now = new Date().toISOString();
  await store.upsertArtifact({
    artifactId, artifactKind: 'principle', sourceTaskId,
    lineageArtifactIds, validationStatus: 'validated',
    contentJson: JSON.stringify(content),
    createdAt: now, updatedAt: now,
  });
}

/**
 * Durable ancestry chain: diagnostician → dreamer → philosopher → scribe.
 *
 * The final diagnostic node defaults to the REAL split-pipeline identity:
 * taskKind `diag_router` (SplitDiagnosticianRunner stage C — the task that
 * owns the durable DiagnosticianOutputV1 artifact on the default chain). The
 * manifest namespace `diagnostician` resolves to it via SEMANTIC_STAGE_ALIASES.
 * Pass `'diagnostician'` to model the legacy monolithic identity (same output
 * contract, pre-PRI-373 workspaces).
 */
async function seedInternalizationChain(diagKind: 'diag_router' | 'diagnostician' = 'diag_router'): Promise<void> {
  const mk = async (id: string, kind: string, deps: string[]): Promise<void> => {
    await stateManager.createTask({
      taskId: id, taskKind: kind, status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: deps, channel: 'prompt', timeoutMs: 300_000,
        inputArtifactRefs: [], outputArtifactRefs: [],
      }),
    });
    await stateManager.acquireLease({ taskId: id, owner: 'sip-test', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(id);
  };

  await mk(DIAG_ID, diagKind, []);
  await upsertArtifact(DIAG_ART, DIAG_ID, [], {
    valid: true, diagnosisId: 'diag-sip-1',
    summary: 'Agent wrote a controlled file without reading it first.',
    rootCause: 'Tooling: write path skipped the read-before-write check.',
    violatedPrinciples: [], evidence: [{ ref: 'pain-1', summary: PAIN_EVIDENCE_MARKER }],
    recommendations: [{ kind: 'internalize', description: 'read before write' }],
    confidence: 0.9,
    // NOTE: no Layer 0 `summary` envelope on this node. DiagnosticianOutputV1
    // already owns a top-level `summary` STRING, and `attachSummaryEnvelope`
    // refuses to overwrite an existing `summary` key (base-peer-runner
    // `artifact_summary_skipped`) — so `diagnostician.summary.*` is expected
    // absent in production too. It stays declared (the Evaluator needs the
    // pain context) and is carried by the information floor, not hidden.
  });

  await mk(DREAM_ID, 'dreamer', [DIAG_ID]);
  await upsertArtifact(DREAM_ART, DREAM_ID, [DIAG_ART], {
    valid: true, taskId: DREAM_ID, contextRefs: [], generatedAt: new Date().toISOString(),
    candidates: [
      {
        candidateIndex: 0,
        badDecision: 'wrote the file without reading it',
        betterDecision: BETTER_DECISION_MARKER,
        rationale: 'reading first keeps edits consistent with on-disk state',
        confidence: 0.85,
        riskLevel: 'low',
        strategicPerspective: 'safety',
      },
      {
        candidateIndex: 1,
        badDecision: 'ignored the diff',
        betterDecision: 'compare before write',
        rationale: 'diff-aware writes reduce churn',
        confidence: 0.6,
        riskLevel: 'medium',
        strategicPerspective: 'correctness',
      },
    ],
    // Layer 0 envelope (artifact_summary_redundancy ON). The Evaluator's
    // `dreamer.summary.*` resolves from THIS node via the ancestry channel —
    // its direct predecessor (the artificer) cannot answer it.
    summary: summaryEnvelope('dreamer', BETTER_DECISION_MARKER, {
      badDecision: 'wrote the file without reading it',
      betterDecision: BETTER_DECISION_MARKER,
      rationale: 'reading first keeps edits consistent with on-disk state',
      riskLevel: 'low',
      strategicPerspective: 'safety',
    }),
  });

  await mk(PHIL_ID, 'philosopher', [DREAM_ID]);
  await upsertArtifact(PHIL_ART, PHIL_ID, [DREAM_ART], {
    thesis: 'read before write', principleCandidate: { title: 'Read before write', scope: 'file tools', confidence: 0.8 },
  });

  await mk(SCRIBE_ID, 'scribe', [PHIL_ID]);
  const scribeStatement = 'Read a file before writing it.';
  await upsertArtifact(SCRIBE_ART, SCRIBE_ID, [PHIL_ART], {
    principleId: 'pri-sip-read-before-write',
    principleDraft: { statement: scribeStatement, applicability: ['file tools'], antiPatterns: ['blind overwrite'] },
    sourceTrace: {},
    // Marker that exists ONLY in the full contentJson — a focused manifest
    // injection must never carry it (information-floor guard, SPEC §37).
    scratchNote: SCRIBE_RAW_ONLY_MARKER,
    summary: summaryEnvelope('scribe', scribeStatement, {
      principleText: scribeStatement,
      scope: '["file tools"]',
      exceptions: '["blind overwrite"]',
    }),
  });
}

function meta(o: Record<string, unknown> = {}): string {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
    inputArtifactRefs: [], outputArtifactRefs: [], ...o,
  });
}

/** Scripted LLM adapter; records prompts and returns queued outputs in order. */
function scriptedAdapter(outputs: unknown[], prompts: string[], runId: string): PDRuntimeAdapter {
  let call = 0;
  return {
    startRun: async (req: { inputPayload: unknown }) => {
      prompts.push(String(req.inputPayload));
      return { runId: `${runId}-${call++}`, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    },
    pollRun: async () => ({ status: 'succeeded', runId }),
    fetchOutput: async () => ({ runId, payload: outputs.shift() }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

function artificerOutput(implementationCode: string, scribeArtifactId: string, taskId: string): unknown {
  return {
    taskId,
    sourceScribeArtifactId: scribeArtifactId,
    implementationSummary: 'read-before-write guard',
    sourceTrace: { scribeArtifactId },
    risks: [],
    implementationCode,
    goldenTraceCases: GOLDEN_TRACE_CASES,
    affectedTools: ['write_file'],
    generatedAt: new Date().toISOString(),
  };
}

/** Artificer artifact content with the Layer 0 envelope the runner itself
 * attaches under artifact_summary_redundancy (see attach-summary-envelope). */
function artificerArtifactContent(output: unknown, scribeArtifactId: string): unknown {
  return {
    ...(output as Record<string, unknown>),
    summary: summaryEnvelope('artificer', '1 affected tools / read-before-write guard', {
      changedFiles: '["write_file"]',
      apiSurface: 'read-before-write guard',
      risks: '[]',
    }),
    // Direct-predecessor forwarding: the scribe's summary, one edge up.
    predecessorSummary: {
      artifactId: scribeArtifactId,
      runnerKind: 'scribe',
      contentHash: 'test-hash',
      summary: summaryEnvelope('scribe', 'Read a file before writing it.', {
        principleText: 'Read a file before writing it.',
        scope: '["file tools"]',
        exceptions: '["blind overwrite"]',
      }),
    },
  };
}

/** `evaluationExtra` is merged INSIDE `evaluation` (where the schema and the
 * PRI-630 convergence validator read them); `extra` stays top-level. */
// eslint-disable-next-line @typescript-eslint/max-params -- compact regression-fixture DSL: positional (id, kind, content) reads better at 20 call sites than an options object; same rule tolerance as attach-summary-envelope.ts
function evaluatorOutput(
  taskId: string,
  artificerArtifactId: string,
  decision: 'approved' | 'needs_revision',
  extra: Record<string, unknown> = {},
  evaluationExtra: Record<string, unknown> = {},
): unknown {
  return {
    taskId,
    sourceArtificerArtifactId: artificerArtifactId,
    evaluation: {
      decision,
      summary: 'sip regression',
      score: decision === 'approved' ? 0.9 : 0.6,
      strengths: [],
      concerns: decision === 'needs_revision' ? ['paramsSummary misuse'] : [],
      requiredChanges: decision === 'needs_revision' ? ['Fix the paramsSummary string-method crash'] : [],
      ...evaluationExtra,
    },
    sourceTrace: { artificerArtifactId, scribeArtifactId: SCRIBE_ART },
    risks: [],
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

/** PRI-630 convergence block: round 2 adjudicates round 1's requirement. */
const ROUND2_CONVERGENCE = {
  priorRequirementStatuses: [{ id: 'req-1', status: 'resolved' }],
  requirementLedger: [{ id: 'req-1', statement: 'Fix the paramsSummary string-method crash', status: 'resolved' }],
} as const;

// eslint-disable-next-line @typescript-eslint/max-params -- compact regression-fixture DSL: positional (id, kind, content) reads better at 20 call sites than an options object; same rule tolerance as attach-summary-envelope.ts
function makeArtificerRunner(outputs: unknown[], prompts: string[], runId: string, config: EffectivePdConfig): ArtificerRunner {
  return new ArtificerRunner(
    {
      stateManager,
      runtimeAdapter: scriptedAdapter(outputs, prompts, runId),
      eventEmitter: emitter,
      artifactStore: store,
      validator: new DefaultArtificerValidator(),
    },
    { owner: 'sip-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000, effectiveConfig: config },
  );
}

// eslint-disable-next-line @typescript-eslint/max-params -- compact regression-fixture DSL: positional (id, kind, content) reads better at 20 call sites than an options object; same rule tolerance as attach-summary-envelope.ts
function makeEvaluatorRunner(
  outputs: unknown[],
  prompts: string[],
  runId: string,
  config: EffectivePdConfig,
  seeder?: (params: SeedArtificerRepairParams) => Promise<string>,
): EvaluatorRunner {
  return new EvaluatorRunner(
    {
      stateManager,
      runtimeAdapter: scriptedAdapter(outputs, prompts, runId),
      eventEmitter: emitter,
      artifactStore: store,
      validator: new DefaultEvaluatorValidator(),
      isRepairLoopEnabled: () => true,
      ...(seeder !== undefined ? { seedArtificerRepairTask: seeder } : {}),
    },
    {
      owner: 'sip-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000,
      gateDeps: createProductionGateDeps(), // REAL deterministic replay — no stubs
      effectiveConfig: config,
    },
  );
}

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sip-'));
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

describe('PR B T-A: normal Artificer resolves tier2 through durable CandidateLineage (flags ON)', () => {
  it('focused prompt carries dreamer.raw.candidates.0.* from the durable ancestry — and no repair/replay pollution', async () => {
    await seedInternalizationChain();
    await stateManager.createTask({
      taskId: ART1_ID, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: meta({ dependencyTaskIds: [SCRIBE_ID] }),
    });

    const prompts: string[] = [];
    const artificer = makeArtificerRunner(
      [artificerOutput(GOOD_RULE_CODE, SCRIBE_ART, ART1_ID)], prompts, 'run-sip-art', FLAGS_ON,
    );
    const result = await artificer.run(ART1_ID);
    expect(result.status).toBe('succeeded');

    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;
    if (prompt === undefined) return;

    // tier2 resolved from the DURABLE Dreamer artifact via CandidateLineage:
    // the path key and the actual raw value both reach the prompt.
    expect(prompt).toContain('dreamer.raw.candidates.0.betterDecision');
    expect(prompt).toContain(BETTER_DECISION_MARKER);
    expect(prompt).toContain('dreamer.raw.candidates.0.rationale');

    // tier1 resolved from the Layer 0 summary envelope on the scribe artifact.
    expect(prompt).toContain('scribe.summary.principleText');
    expect(prompt).toContain('Read a file before writing it.');

    // Information floor: focused mode must NOT leak fields outside the manifest
    // (the legacy full-contentJson injection would have carried scratchNote).
    expect(prompt).not.toContain(SCRIBE_RAW_ONLY_MARKER);
    // Normal Artificer is not polluted by repair-only namespaces (SPEC §30).
    expect(prompt).not.toContain('replay.raw');
    expect(prompt).not.toContain('repair.summary');

    // No information-floor degradation fired: resolution was healthy.
    // (emitEvent prefixes event types with the runnerName.)
    expect(emitted.some((e) => e.eventType === 'artificer_manifest_resolution_insufficient')).toBe(false);
    expect(emitted.some((e) => e.eventType === 'artificer_required_context_evidence_unresolved')).toBe(false);
  });
});

/** Shared T-B family setup: durable Round-1 Artificer artifact + Evaluator task. */
async function seedEvaluatorChain(): Promise<void> {
  await stateManager.createTask({
    taskId: ART1_ID, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: meta({ dependencyTaskIds: [SCRIBE_ID] }),
  });
  await stateManager.acquireLease({ taskId: ART1_ID, owner: 'sip-test', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(ART1_ID);
  await upsertArtifact(
    ART1_ART, ART1_ID, [SCRIBE_ART],
    artificerArtifactContent(artificerOutput(GOOD_RULE_CODE, SCRIBE_ART, ART1_ID), SCRIBE_ART),
  );

  await stateManager.createTask({
    taskId: EVAL1_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: meta({ dependencyTaskIds: [ART1_ID] }),
  });
}

describe('PR B T-B: Evaluator Stage2 resolves required tier2 raw evidence (flags ON)', () => {
  it('Stage2 prompt carries diagnostician.raw.evidence + dreamer.raw.candidates from the real split lineage', async () => {
    // Default split-pipeline identity: the diag artifact node is taskKind
    // `diag_router` (SplitDiagnosticianRunner stage C) — the manifest
    // namespace `diagnostician` must resolve to it via SEMANTIC_STAGE_ALIASES.
    await seedInternalizationChain('diag_router');
    await seedEvaluatorChain();

    // Stage 1 output: contract-valid, but flagged (painCoverage.fullyCovered=false)
    // → Stage 2 must run. Stage 2 output: approved → real replay passes → pi-rule.
    const stage1Output = evaluatorOutput(EVAL1_ID, ART1_ART, 'approved', {
      painCoverage: { fullyCovered: false },
      compressionFidelity: { missingDimensions: [] },
    });
    const stage2Output = evaluatorOutput(EVAL1_ID, ART1_ART, 'approved');

    const prompts: string[] = [];
    const evaluator = makeEvaluatorRunner([stage1Output, stage2Output], prompts, 'run-sip-eval', FLAGS_ON);
    const result = await evaluator.run(EVAL1_ID);
    expect(result.status).toBe('succeeded');

    // Two LLM calls = Stage 2 actually ran (not just Stage 1).
    expect(prompts.length).toBe(2);
    const [stage1Prompt, stage2Prompt] = prompts as [string, string];

    // Stage 1 stayed summary-level: no tier2 raw path and no raw-only value.
    // (`dreamer.summary.betterDecision` legitimately carries the same marker
    // string — the discriminator is the RAW path/value, not the marker alone.)
    expect(stage1Prompt).not.toContain('dreamer.raw.candidates');
    expect(stage1Prompt).not.toContain('diagnostician.raw.evidence');
    expect(stage1Prompt).not.toContain(PAIN_EVIDENCE_MARKER);
    // Stage 1 resolves ANCESTOR summaries (scribe/dreamer) + the read-time
    // projected diagnostician summary through the ancestry channel instead of
    // falling back — the namespace-unreachability that used to force
    // `manifest_resolution_insufficient` on every run is gone.
    expect(emitted.some((e) => e.eventType === 'evaluator_manifest_resolution_insufficient'
      && (e.payload as { manifestId?: string }).manifestId === 'evaluator.stage1.v1')).toBe(false);
    expect(stage1Prompt).toContain('dreamer.summary.betterDecision');
    expect(stage1Prompt).toContain(BETTER_DECISION_MARKER);
    // Pain context is genuinely present at Stage 1 (bounded read-time
    // projection of the diag_router DiagnosticianOutputV1) — never a
    // "known always absent" contract (review round).
    expect(stage1Prompt).toContain('diagnostician.summary.rootSymptom');
    expect(stage1Prompt).toContain('Agent wrote a controlled file without reading it first.');
    expect(stage1Prompt).toContain('diagnostician.summary.category');
    expect(stage1Prompt).toContain('internalize');

    // Stage 2 REQUIRED tier2 fields resolved from durable ancestry — the
    // split-chain diag_router node answers the `diagnostician` namespace.
    expect(stage2Prompt).toContain('dreamer.raw.candidates');
    expect(stage2Prompt).toContain(BETTER_DECISION_MARKER);
    expect(stage2Prompt).toContain('diagnostician.raw.evidence');
    expect(stage2Prompt).toContain(PAIN_EVIDENCE_MARKER);

    // Information floor: no silent required-evidence loss on Stage 2.
    expect(emitted.some((e) => e.eventType === 'evaluator_required_context_evidence_unresolved'
      && (e.payload as { manifestId?: string }).manifestId === 'evaluator.stage2.v1')).toBe(false);

    // The loop still closes: real replay passed → pi-rule assembled.
    const evalArtifacts = await store.listBySourceTaskId(EVAL1_ID);
    const ruleArtifact = evalArtifacts.find((a) => a.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    if (ruleArtifact) expect(ruleArtifact.artifactId).toContain('pi-rule-');
  });
});

describe('PR B T-B3: legacy monolithic diagnostician identity resolves the same namespace', () => {
  it('Stage2 evidence also resolves when the diag node taskKind is `diagnostician`', async () => {
    // Legacy (pre-split / old workspace) identity: durable DiagnosticianOutputV1
    // committed under taskKind `diagnostician`. The alias table must cover it.
    await seedInternalizationChain('diagnostician');
    await seedEvaluatorChain();

    const prompts: string[] = [];
    const evaluator = makeEvaluatorRunner(
      [
        evaluatorOutput(EVAL1_ID, ART1_ART, 'approved', {
          painCoverage: { fullyCovered: false },
          compressionFidelity: { missingDimensions: [] },
        }),
        evaluatorOutput(EVAL1_ID, ART1_ART, 'approved'),
      ],
      prompts, 'run-sip-eval-legacy', FLAGS_ON,
    );
    expect((await evaluator.run(EVAL1_ID)).status).toBe('succeeded');

    expect(prompts.length).toBe(2);
    const stage2Prompt = prompts[1] ?? '';
    expect(stage2Prompt).toContain('diagnostician.raw.evidence');
    expect(stage2Prompt).toContain(PAIN_EVIDENCE_MARKER);
    expect(emitted.some((e) => e.eventType === 'evaluator_required_context_evidence_unresolved'
      && (e.payload as { manifestId?: string }).manifestId === 'evaluator.stage2.v1')).toBe(false);
  });
});

/**
 * T-B2 — the information floor in its negative form (design §34/§35, review
 * round). Same run as T-B, but the durable diagnostician EVIDENCE is missing.
 * Stage 2 declares `diagnostician.raw.evidence` REQUIRED; since Stage 2 is the
 * deep-evidence stage there is NO safe legacy fallback that carries the
 * missing evidence — the runner must REFUSE the Stage-2 LLM round entirely and
 * fail loud. The scripted Stage-2 output WOULD approve; the assertion is that
 * it is never consumed.
 */
describe('PR B T-B2: Stage2 required evidence missing → no Stage2 LLM, fail loud (never a silent verdict)', () => {
  it('emits required_context_evidence_unresolved + abort, sends exactly ONE prompt, and assembles no pi-rule', async () => {
    await seedInternalizationChain('diag_router');
    // Strip ONLY the durable diagnostician evidence: the task node and the
    // artifact stay, so the lineage walk succeeds but cannot serve the
    // required raw path (a corruption short of a missing row).
    await upsertArtifact(DIAG_ART, DIAG_ID, [], {
      valid: true, diagnosisId: 'diag-sip-1',
      summary: 'Agent wrote a controlled file without reading it first.',
      rootCause: 'Tooling: write path skipped the read-before-write check.',
      violatedPrinciples: [], recommendations: [], confidence: 0.9,
    });
    await seedEvaluatorChain();

    const prompts: string[] = [];
    const evaluator = makeEvaluatorRunner(
      [
        evaluatorOutput(EVAL1_ID, ART1_ART, 'approved', { painCoverage: { fullyCovered: false } }),
        // WOULD approve — must NEVER be consumed (regression guard).
        evaluatorOutput(EVAL1_ID, ART1_ART, 'approved'),
      ],
      prompts, 'run-sip-eval-floor', FLAGS_ON,
    );
    const result = await evaluator.run(EVAL1_ID);

    // Fail loud, permanent, NO authoritative verdict.
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');

    // The gate FIRED (information floor) AND the abort is observable.
    const gate = emitted.find((e) => e.eventType === 'evaluator_required_context_evidence_unresolved');
    expect(gate).toBeDefined();
    expect(gate?.payload.manifestId).toBe('evaluator.stage2.v1');
    expect(gate?.payload.requiredPaths).toEqual(['diagnostician.raw.evidence']);
    const abort = emitted.find((e) => e.eventType === 'evaluator_stage2_required_evidence_unavailable');
    expect(abort).toBeDefined();
    expect(abort?.payload.requiredPaths).toEqual(['diagnostician.raw.evidence']);

    // Stage 2 LLM was NEVER sent: exactly 1 prompt (Stage 1 only).
    expect(prompts.length).toBe(1);

    // No authoritative verdict artifact of any kind was produced.
    const evalArtifacts = await store.listBySourceTaskId(EVAL1_ID);
    expect(evalArtifacts.find((a) => a.artifactKind === 'rule')).toBeUndefined();
    expect(evalArtifacts.find((a) => a.artifactKind === 'principle')).toBeUndefined();
  });
});

describe('PR B T-C: Artificer Repair receives replay evidence through the RELATED manifest channel (flags ON)', () => {
  it('repair prompt carries bounded replay evidence via ARTIFICER_REPAIR_MANIFEST; loop still closes to pi-rule', async () => {
    await seedInternalizationChain();

    // ── Round 1: real artificer emits the paramsSummary bug (flags ON) ──
    await stateManager.createTask({
      taskId: ART1_ID, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: meta({ dependencyTaskIds: [SCRIBE_ID] }),
    });
    const art1Prompts: string[] = [];
    const artificer1 = makeArtificerRunner(
      [artificerOutput(BAD_RULE_CODE, SCRIBE_ART, ART1_ID)], art1Prompts, 'run-sip-art1', FLAGS_ON,
    );
    expect((await artificer1.run(ART1_ID)).status).toBe('succeeded');
    const art1Artifacts = await store.listBySourceTaskId(ART1_ID);
    const art1Artifact = art1Artifacts.find((a) => a.artifactKind === 'principle');
    expect(art1Artifact).toBeDefined();
    if (!art1Artifact) return;

    // ── Evaluator needs_revision + REAL replay → durable failure evidence ──
    await stateManager.createTask({
      taskId: EVAL1_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: meta({ dependencyTaskIds: [ART1_ID] }),
    });
    const seededRepair: { payload?: Record<string, unknown> } = {};
    const eval1Prompts: string[] = [];
    // Progressive mode consumes TWO outputs: Stage 1 (flagged via painCoverage
    // → deterministic Stage 2 trigger) and Stage 2 (the final needs_revision).
    const evalNeedsRevision = evaluatorOutput(EVAL1_ID, art1Artifact.artifactId, 'needs_revision', {
      painCoverage: { fullyCovered: false },
      compressionFidelity: { missingDimensions: [] },
    });
    const evaluator1 = makeEvaluatorRunner(
      [evalNeedsRevision, evaluatorOutput(EVAL1_ID, art1Artifact.artifactId, 'needs_revision')],
      eval1Prompts, 'run-sip-eval1', FLAGS_ON,
      async (params) => {
        seededRepair.payload = params.repairPayload as unknown as Record<string, unknown>;
        await stateManager.createTask({
          taskId: REPAIR_ID, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
          diagnosticJson: meta({
            dependencyTaskIds: params.inheritedDependencyTaskIds,
            repairPayload: params.repairPayload,
          }),
        });
        return REPAIR_ID;
      },
    );
    expect((await evaluator1.run(EVAL1_ID)).status).toBe('succeeded');

    // RepairPayload stays a bounded control payload (no failedCases, SPEC §21).
    const repairPayload = seededRepair.payload;
    expect(repairPayload).toBeDefined();
    if (repairPayload === undefined) return;
    expect(repairPayload.diagnosticReplay).toEqual({ ran: true, passed: false, failedCaseCount: expect.any(Number) });
    expect(Object.hasOwn(repairPayload, 'failedCases')).toBe(false);

    // ── Repair round: replay evidence arrives via the manifest RELATED channel ──
    const repairPrompts: string[] = [];
    const artificerRepair = makeArtificerRunner(
      [artificerOutput(GOOD_RULE_CODE, SCRIBE_ART, REPAIR_ID)], repairPrompts, 'run-sip-repair', FLAGS_ON,
    );
    expect((await artificerRepair.run(REPAIR_ID)).status).toBe('succeeded');

    expect(repairPrompts).toHaveLength(1);
    const [repairPrompt] = repairPrompts;
    if (repairPrompt === undefined) return;

    // RELATED channel: manifest field paths + the concrete case details.
    expect(repairPrompt).toContain('replay.raw.traceFailures');
    expect(repairPrompt).toContain('replay.summary.failedCaseCount');
    expect(repairPrompt).toContain('repair.summary.requiredChanges');
    expect(repairPrompt).toContain('v2-unavailable');
    expect(repairPrompt).toContain('runtime_error');
    expect(repairPrompt).toContain('includes is not a function');
    // The PR-A string channel is NOT also injected (no double evidence).
    expect(repairPrompt).not.toContain('Deterministic Replay Evidence (resolved by reference from evaluator artifact');
    // PR-A resolver was reused (not duplicated) and resolved by reference.
    expect(emitted.some((e) => e.eventType === 'artificer_repair_replay_evidence_resolved')).toBe(true);
    // Required-evidence gate did not fire: the budget carried the evidence.
    expect(emitted.some((e) => e.eventType === 'required_context_evidence_unresolved'
      && (e.payload as { manifestId?: string }).manifestId === 'artificer.repair.v1')).toBe(false);

    // ── Round 2: evaluator approves the repaired code → pi-rule ──
    const repairArtifacts = await store.listBySourceTaskId(REPAIR_ID);
    const repairArtifact = repairArtifacts.find((a) => a.artifactKind === 'principle');
    expect(repairArtifact).toBeDefined();
    if (!repairArtifact) return;

    await stateManager.createTask({
      taskId: EVAL2_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: meta({ dependencyTaskIds: [REPAIR_ID] }),
    });
    const eval2Prompts: string[] = [];
    const evaluator2 = makeEvaluatorRunner(
      [evaluatorOutput(
        EVAL2_ID, repairArtifact.artifactId, 'approved',
        {
          // Not flagged and nothing undetermined → Stage 1 alone decides, so
          // this evaluator consumes exactly ONE LLM output (no Stage 2).
          painCoverage: { fullyCovered: true },
          compressionFidelity: { missingDimensions: [] },
          implementationFidelity: { score: 0.92 },
        },
        ROUND2_CONVERGENCE,
      )], eval2Prompts, 'run-sip-eval2', FLAGS_ON,
    );
    expect((await evaluator2.run(EVAL2_ID)).status).toBe('succeeded');

    const eval2Artifacts = await store.listBySourceTaskId(EVAL2_ID);
    const ruleArtifact = eval2Artifacts.find((a) => a.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    if (ruleArtifact) {
      expect(ruleArtifact.artifactId).toContain('pi-rule-');
      expect(ruleArtifact.validationStatus).toBe('validated');
    }
  });
});
