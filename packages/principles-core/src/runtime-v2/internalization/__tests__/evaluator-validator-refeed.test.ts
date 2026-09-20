/**
 * PRI-644 — evaluator consumes the existing validator-error re-feed.
 *
 * PRI-700 factor B already persists the verbatim validator rejections of each
 * failed attempt into task.diagnosticJson (`lastValidatorErrors`) and the
 * artificer is the only consumer. The evaluator's BUSINESS-layer rejections
 * (e.g. the repair round missing `requirementLedger`) therefore still burned
 * all retries with a byte-identical zero-information prompt → task death.
 *
 * Three layers here mirror the established artificer contract:
 *   1. Prompt contract (builder unit): conditional re-feed block; a run
 *      without priorValidatorErrors keeps the payload/system prompt
 *      byte-identical to the pre-PRI-644 shape.
 *   2. buildContext wiring (probe subclass, real stores): freshness gate
 *      `sourceAttemptCount === leasedAttempt - 1`; stale/no-lease records are
 *      suppressed with an observable event (rc-9), never silently re-fed.
 *      The re-feed NEVER participates in contextHash (same posture as
 *      artificer — replay/cache identity covers evidence, not feedback).
 *   3. Golden replay (production path — RuntimeStateManager + real
 *      EvaluatorRunner + DefaultEvaluatorValidator, only the LLM is
 *      scripted): attempt 1 rejected → attempt 2 prompt carries the verbatim
 *      rejection reasons; attempt 1 prompt has none.
 */
import { describe, it, expect, afterEach } from 'vitest';
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
  EVALUATOR_VALIDATOR_FEEDBACK_ADDENDUM,
} from '../evaluator-prompt-builder.js';
import type { LastValidatorErrors } from '../pitask-metadata.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { createProductionGateDeps } from '../../activation/production-gate-deps.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const SCRIBE_ID = 'scribe-644';
const ART_ID = 'artificer-644';
const EVAL_ID = 'evaluator-644';
const SCRIBE_ART = 'pi-art-scribe-644';

const REJECTION_TEXT =
  'evaluation.requirementLedger is required in a repair round (previous evaluation context was provided)';

function record(sourceAttemptCount: number, errors: readonly string[] = [REJECTION_TEXT]): LastValidatorErrors {
  return {
    recordedAt: '2026-09-20T00:00:00.000Z',
    errorCategory: 'output_invalid',
    errors,
    sourceAttemptCount,
  };
}

function unitRecord(): LastValidatorErrors {
  return record(1, [REJECTION_TEXT, "evaluation.decision must be one of 'approved' | 'needs_revision' | 'rejected'"]);
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

/** diagnosticJson envelope with a top-level lastValidatorErrors record. */
function metaWithValidatorErrors(diagnostic: LastValidatorErrors): string {
  const envelope = JSON.parse(meta({ dependencyTaskIds: [ART_ID] })) as Record<string, unknown>;
  envelope.lastValidatorErrors = diagnostic;
  return JSON.stringify(envelope);
}

function scribeContent(): Record<string, unknown> {
  return {
    principleId: 'refeed-644',
    principleDraft: {
      title: 'Feedback must reach the retry',
      statement: 'A rejected output shape must be re-fed verbatim into the next attempt.',
      rationale: 'Same-prompt retries are a deterministic death loop.',
      applicability: ['evaluator repair rounds'],
      antiPatterns: ['zero-information retry'],
      confidence: 0.8,
    },
  };
}

function artificerOutput(): Record<string, unknown> {
  return {
    taskId: ART_ID,
    sourceScribeArtifactId: SCRIBE_ART,
    implementationSummary: 'refeed gate',
    sourceTrace: { scribeArtifactId: SCRIBE_ART },
    risks: [],
    goldenTraceCases: [
      { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/app/config.json' }, expectedDecision: 'block' },
      { caseId: 'pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/app/src/a.ts' }, expectedDecision: 'allow' },
    ],
    affectedTools: ['write_file'],
    generatedAt: '2026-09-20T00:00:00.000Z',
  };
}

function evaluatorOutput(): Record<string, unknown> {
  return {
    taskId: EVAL_ID,
    sourceArtificerArtifactId: `pi-art-${ART_ID}-seed`,
    evaluation: {
      decision: 'approved',
      summary: 'pri-644 golden replay',
      score: 0.9,
      strengths: [],
      concerns: [],
      requiredChanges: [],
    },
    sourceTrace: { artificerArtifactId: `pi-art-${ART_ID}-seed`, scribeArtifactId: SCRIBE_ART },
    risks: [],
    generatedAt: '2026-09-20T00:00:00.000Z',
  };
}

/** Output rejected by DefaultEvaluatorValidator (decision not in enum). */
function rejectedEvaluatorOutput(): Record<string, unknown> {
  const out = evaluatorOutput();
  const evaluation = { ...(out.evaluation as Record<string, unknown>) };
  delete evaluation.summary;
  evaluation.decision = 'maybe';
  return { ...out, evaluation };
}

// ── Production world (real stores, scripted LLM only) ────────────────────────

interface World {
  workspaceDir: string;
  stateManager: RuntimeStateManager;
  emitter: StoreEventEmitter;
  emitted: { eventType: string; payload: Record<string, unknown> }[];
  store: SqlitePIArtifactStore;
}

let world: World | undefined;

async function makeWorld(evaluatorDiagnosticJson?: string): Promise<World> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri644-'));
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  const emitter = new StoreEventEmitter();
  const emitted: World['emitted'] = [];
  emitter.onTelemetry((event) => {
    emitted.push({ eventType: event.eventType, payload: event.payload });
  });
  const store = new SqlitePIArtifactStore(new SqliteConnection(workspaceDir));
  const now = '2026-09-20T00:00:00.000Z';

  const mkTask = async (spec: { id: string; kind: string; deps: readonly string[] }): Promise<void> => {
    await stateManager.createTask({
      taskId: spec.id, taskKind: spec.kind, status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: meta({ dependencyTaskIds: spec.deps }),
    });
    await stateManager.acquireLease({ taskId: spec.id, owner: 'pri644-test', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(spec.id);
  };
  const upsert = (spec: { artifactId: string; sourceTaskId: string; content: unknown; lineage: readonly string[] }): Promise<unknown> =>
    store.upsertArtifact({
      artifactId: spec.artifactId, artifactKind: 'principle', sourceTaskId: spec.sourceTaskId,
      lineageArtifactIds: [...spec.lineage],
      validationStatus: 'pending', contentJson: JSON.stringify(spec.content), createdAt: now, updatedAt: now,
    });

  await mkTask({ id: SCRIBE_ID, kind: 'scribe', deps: [] });
  await upsert({ artifactId: SCRIBE_ART, sourceTaskId: SCRIBE_ID, content: scribeContent(), lineage: [] });
  await mkTask({ id: ART_ID, kind: 'artificer', deps: [SCRIBE_ID] });
  await upsert({ artifactId: `pi-art-${ART_ID}-seed`, sourceTaskId: ART_ID, content: artificerOutput(), lineage: [SCRIBE_ART] });
  await stateManager.createTask({
    taskId: EVAL_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: evaluatorDiagnosticJson ?? meta({ dependencyTaskIds: [ART_ID] }),
  });

  return { workspaceDir, stateManager, emitter, emitted, store };
}

function closeWorld(): void {
  if (!world) return;
  void world.stateManager.close();
  try { fs.rmSync(world.workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
  world = undefined;
}

afterEach(() => {
  closeWorld();
});

interface CapturedPrompt {
  message: string;
  systemPrompt: string;
}

/** Scripted LLM returning one payload per invocation (queue order). */
function queuedAdapter(payloads: unknown[], prompts: CapturedPrompt[]): PDRuntimeAdapter {
  let next = 0;
  return {
    startRun: async (req: { inputPayload: unknown; systemPrompt?: unknown }) => {
      prompts.push({
        message: String(req.inputPayload),
        systemPrompt: typeof req.systemPrompt === 'string' ? req.systemPrompt : '',
      });
      return { runId: `pri644-run-${next}`, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
    },
    pollRun: async () => ({ status: 'succeeded', runId: 'pri644-run' }),
    fetchOutput: async () => ({ runId: 'pri644-run', payload: payloads[Math.min(next++, payloads.length - 1)] }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

function makeRunner(w: World, payloads: unknown[], prompts: CapturedPrompt[]): EvaluatorRunner {
  return new EvaluatorRunner({
    stateManager: w.stateManager,
    runtimeAdapter: queuedAdapter(payloads, prompts),
    eventEmitter: w.emitter,
    artifactStore: w.store,
    validator: new DefaultEvaluatorValidator(),
    isRepairLoopEnabled: () => false,
    seedArtificerRepairTask: async () => 'unused',
  }, {
    owner: 'pri644-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5000,
    gateDeps: createProductionGateDeps(), effectiveConfig: flagsOffConfig(),
  });
}

/** Exposes the protected leased-attempt so buildContext freshness can be probed directly. */
class ProbeEvaluatorRunner extends EvaluatorRunner {
  public setLeasedAttempt(attempt: number | undefined): void {
    this.currentLeasedAttempt = attempt;
  }
}

function makeProbe(w: World): ProbeEvaluatorRunner {
  return new ProbeEvaluatorRunner({
    stateManager: w.stateManager,
    runtimeAdapter: queuedAdapter([], []),
    eventEmitter: w.emitter,
    artifactStore: w.store,
    validator: new DefaultEvaluatorValidator(),
  }, {
    owner: 'pri644-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5000,
    gateDeps: createProductionGateDeps(), effectiveConfig: flagsOffConfig(),
  });
}

// ── Layer 1: prompt contract (builder unit) ──────────────────────────────────

describe('PRI-644 — evaluator prompt contract (conditional validator re-feed)', () => {
  const builder = new EvaluatorPromptBuilder();
  const baseInput = {
    taskId: EVAL_ID,
    contextHash: 'ctx-644',
    sourceArtificerArtifactId: 'pi-art-artificer-644-seed',
    artificerArtifact: { taskId: ART_ID },
    scribeArtifact: scribeContent(),
  };

  it('without priorValidatorErrors the payload has no key and the system prompt is byte-identical (first attempt untouched)', () => {
    const a = builder.buildPrompt(baseInput);
    const parsed = JSON.parse(a.message) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'priorValidatorErrors')).toBe(false);
    expect(a.systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION);
    expect(a.systemPrompt).not.toContain('PRIOR OUTPUT-CONTRACT REJECTIONS');
  });

  it('with priorValidatorErrors the payload carries the record verbatim and the system prompt gains the re-feed block', () => {
    const { message, systemPrompt, promptInput } = builder.buildPrompt({
      ...baseInput,
      priorValidatorErrors: unitRecord(),
    });
    const parsed = JSON.parse(message) as Record<string, unknown>;
    expect(parsed.priorValidatorErrors).toEqual(unitRecord());
    expect(message).toContain(REJECTION_TEXT);
    expect(promptInput.priorValidatorErrors?.errors).toHaveLength(2);
    expect(systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION + EVALUATOR_VALIDATOR_FEEDBACK_ADDENDUM);
    expect(systemPrompt).toContain('PRIOR OUTPUT-CONTRACT REJECTIONS');
  });

  it('the re-feed coexists with the formation addendum in stable order (protocol + formation + validator)', () => {
    const { systemPrompt } = builder.buildPrompt({
      ...baseInput,
      formationContext: undefined,
      priorValidatorErrors: unitRecord(),
    });
    expect(systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION + EVALUATOR_VALIDATOR_FEEDBACK_ADDENDUM);
    const withFormation = builder.buildPrompt(baseInput);
    expect(withFormation.systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION);
  });

  it('the addendum pins the evaluator-specific duties: verbatim reasons, ledger echo obligation, no re-judging of the plan', () => {
    expect(EVALUATOR_VALIDATOR_FEEDBACK_ADDENDUM).toContain('PRIOR OUTPUT-CONTRACT REJECTIONS');
    expect(EVALUATOR_VALIDATOR_FEEDBACK_ADDENDUM).toContain('priorValidatorErrors.errors');
    expect(EVALUATOR_VALIDATOR_FEEDBACK_ADDENDUM).toContain('requirementLedger');
    expect(EVALUATOR_VALIDATOR_FEEDBACK_ADDENDUM).toContain('NOT re-judge');
  });
});

// ── Layer 2: buildContext freshness wiring ──────────────────────────────────

describe('PRI-644 — evaluator buildContext consumes lastValidatorErrors with freshness gating', () => {
  it('fresh record (sourceAttemptCount === leasedAttempt - 1) is carried onto the context, no suppression event', async () => {
    world = await makeWorld(metaWithValidatorErrors(record(2)));
    const runner = new ProbeEvaluatorRunner({
      stateManager: world.stateManager,
      runtimeAdapter: queuedAdapter([], []),
      eventEmitter: world.emitter,
      artifactStore: world.store,
      validator: new DefaultEvaluatorValidator(),
    }, {
      owner: 'pri644-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5000,
      gateDeps: createProductionGateDeps(), effectiveConfig: flagsOffConfig(),
    });
    runner.setLeasedAttempt(3);
    const context = await runner.buildContext(EVAL_ID);
    expect(context.priorValidatorErrors?.sourceAttemptCount).toBe(2);
    expect(context.priorValidatorErrors?.errors).toEqual([REJECTION_TEXT]);
    expect(world.emitted.filter((e) => e.eventType === 'evaluator_prior_validator_errors_suppressed')).toHaveLength(0);
  });

  it('stale record is NOT re-fed and emits an observable suppression event with reason stale_source_attempt', async () => {
    world = await makeWorld(metaWithValidatorErrors(record(1)));
    const runner = new ProbeEvaluatorRunner({
      stateManager: world.stateManager,
      runtimeAdapter: queuedAdapter([], []),
      eventEmitter: world.emitter,
      artifactStore: world.store,
      validator: new DefaultEvaluatorValidator(),
    }, {
      owner: 'pri644-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5000,
      gateDeps: createProductionGateDeps(), effectiveConfig: flagsOffConfig(),
    });
    runner.setLeasedAttempt(5);
    const context = await runner.buildContext(EVAL_ID);
    expect(context.priorValidatorErrors).toBeUndefined();
    const suppressed = world.emitted.filter((e) => e.eventType === 'evaluator_prior_validator_errors_suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.payload).toMatchObject({
      sourceAttemptCount: 1,
      currentAttempt: 5,
      reason: 'stale_source_attempt',
      errorCount: 1,
    });
  });

  it('record present without lease context is suppressed with reason no_lease_context (restart-safe)', async () => {
    world = await makeWorld(metaWithValidatorErrors(record(1)));
    const runner = new ProbeEvaluatorRunner({
      stateManager: world.stateManager,
      runtimeAdapter: queuedAdapter([], []),
      eventEmitter: world.emitter,
      artifactStore: world.store,
      validator: new DefaultEvaluatorValidator(),
    }, {
      owner: 'pri644-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5000,
      gateDeps: createProductionGateDeps(), effectiveConfig: flagsOffConfig(),
    });
    const context = await runner.buildContext(EVAL_ID);
    expect(context.priorValidatorErrors).toBeUndefined();
    const suppressed = world.emitted.filter((e) => e.eventType === 'evaluator_prior_validator_errors_suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.payload).toMatchObject({ reason: 'no_lease_context' });
  });

  it('no record → no field, no event (first attempt untouched)', async () => {
    world = await makeWorld();
    const runner = new ProbeEvaluatorRunner({
      stateManager: world.stateManager,
      runtimeAdapter: queuedAdapter([], []),
      eventEmitter: world.emitter,
      artifactStore: world.store,
      validator: new DefaultEvaluatorValidator(),
    }, {
      owner: 'pri644-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5000,
      gateDeps: createProductionGateDeps(), effectiveConfig: flagsOffConfig(),
    });
    runner.setLeasedAttempt(1);
    const context = await runner.buildContext(EVAL_ID);
    expect(context.priorValidatorErrors).toBeUndefined();
    expect(world.emitted.filter((e) => e.eventType === 'evaluator_prior_validator_errors_suppressed')).toHaveLength(0);
  });

  it('the re-feed never participates in contextHash (same posture as artificer: identity covers evidence, not feedback)', async () => {
    const plainWorld = await makeWorld();
    const fedWorld = await makeWorld(metaWithValidatorErrors(record(2)));
    try {
      const plain = makeProbe(plainWorld);
      plain.setLeasedAttempt(1);
      const contextWithout = await plain.buildContext(EVAL_ID);

      const fed = makeProbe(fedWorld);
      fed.setLeasedAttempt(3);
      const contextWith = await fed.buildContext(EVAL_ID);
      expect(contextWith.priorValidatorErrors).toBeDefined();
      expect(contextWith.contextHash).toBe(contextWithout.contextHash);
    } finally {
      void plainWorld.stateManager.close();
      void fedWorld.stateManager.close();
      try { fs.rmSync(plainWorld.workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
      try { fs.rmSync(fedWorld.workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
    }
  });
});

// ── Layer 3: golden replay — rejection feeds the next attempt ───────────────

describe('PRI-644 — golden replay: validator rejection re-feeds attempt N+1 (production path)', () => {
  it('attempt 2 prompt carries the verbatim attempt-1 rejection reasons; attempt 1 prompt carries none', async () => {
    world = await makeWorld();
    const prompts: CapturedPrompt[] = [];
    const runner = makeRunner(world, [rejectedEvaluatorOutput(), evaluatorOutput()], prompts);

    const first = await runner.run(EVAL_ID);
    expect(first.status).toBe('retried');
    // The task itself waits in retry_wait for attempt 2.
    expect((await world.stateManager.getTask(EVAL_ID))?.status).toBe('retry_wait');
    // Producer side: the rejection was persisted with the attempt-1 source tag.
    const afterFirst = await world.stateManager.getTask(EVAL_ID);
    const persisted = JSON.parse(afterFirst?.diagnosticJson ?? '{}') as { lastValidatorErrors?: LastValidatorErrors };
    expect(persisted.lastValidatorErrors).toBeDefined();
    expect(persisted.lastValidatorErrors?.sourceAttemptCount).toBe(1);
    expect(persisted.lastValidatorErrors?.errors.length).toBeGreaterThan(0);

    // Retry backoff must not gate the second lease in this test.
    await world.stateManager.updateTask(EVAL_ID, { leaseExpiresAt: '2000-01-01T00:00:00.000Z' });

    const second = await runner.run(EVAL_ID);
    expect(second.status).toBe('succeeded');

    expect(prompts).toHaveLength(2);
    const p1 = JSON.parse(prompts[0]?.message ?? '{}') as Record<string, unknown>;
    const p2 = JSON.parse(prompts[1]?.message ?? '{}') as Record<string, unknown>;
    // attempt 1: zero-information prompt (no feedback yet)
    expect(Object.hasOwn(p1, 'priorValidatorErrors')).toBe(false);
    expect(prompts[0]?.systemPrompt).not.toContain('PRIOR OUTPUT-CONTRACT REJECTIONS');
    // attempt 2: the SAME rejection reasons that killed attempt 1, verbatim.
    const fed = p2.priorValidatorErrors as LastValidatorErrors;
    expect(fed).toBeDefined();
    expect(fed.sourceAttemptCount).toBe(1);
    expect(fed.errors).toEqual(persisted.lastValidatorErrors?.errors);
    for (const errorText of fed.errors) {
      expect(prompts[1]?.message).toContain(errorText);
    }
    expect(prompts[1]?.systemPrompt).toContain('PRIOR OUTPUT-CONTRACT REJECTIONS');
    // feedback is ephemeral prompt context, NOT cache identity:
    expect(p2.contextHash).toBe(p1.contextHash);
    expect(p2.promptContractVersion).toBe('evaluator-output-v1.prompt.v6');
  });
});

// keep the formation-order test honest if both addenda coexist
describe('PRI-644/PRI-843 addendum coexistence', () => {
  it('formation + validator addenda both render in protocol → formation → validator order', () => {
    const builder = new EvaluatorPromptBuilder();
    const { systemPrompt } = builder.buildPrompt({
      taskId: EVAL_ID,
      contextHash: 'ctx-644',
      sourceArtificerArtifactId: 'pi-art-artificer-644-seed',
      artificerArtifact: { taskId: ART_ID },
      formationContext: undefined,
      priorValidatorErrors: unitRecord(),
    });
    // without formationContext the formation addendum stays out (PRI-843 discipline)
    expect(systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION + EVALUATOR_VALIDATOR_FEEDBACK_ADDENDUM);
    expect(EVALUATOR_FORMATION_EVIDENCE_ADDENDUM).not.toBe(EVALUATOR_VALIDATOR_FEEDBACK_ADDENDUM);
  });
});
