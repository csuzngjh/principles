/**
 * PRI-861 — painReasonSummary producer echo (production-path tests).
 *
 * Gap (PRI-855 CIL-003): RuleHostWriter.buildApprovalContext reads
 * `painReasonSummary` from the rule artifact contentJson, but the production
 * v2 assembler never wrote it — the Owner approval card always showed the
 * generic fallback trigger reason.
 *
 * Fix contract (PRI-855 audit option B — connection before creation):
 * assembleRuleArtifact ECHOES the same bounded
 * `resolveFormationContext().sourceDiagnosis.summary` projection the PRI-843
 * prompt path already uses. It never re-derives or re-summarizes the diagnosis
 * (P4: the diagnosis artifact stays the single source of truth) and inherits
 * the projection's FORMATION_FIELD_MAX_CHARS clamp. When the formation chain
 * is absent the field stays absent (PRI-530 design: show only what exists)
 * with an observable skip event (rc-9) — assembly itself never blocks on it.
 *
 * Every test runs REAL production components (RuntimeStateManager +
 * SqlitePIArtifactStore + EvaluatorRunner + deterministic replay gate +
 * RuleHostWriter); only the LLM adapter is scripted.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { createProductionGateDeps } from '../../activation/production-gate-deps.js';
import { RuleHostWriter } from '../../activation/writers/rule-host-writer.js';
import type { WriterInput } from '../../activation/activation-types.js';
import { FORMATION_FIELD_MAX_CHARS } from '../formation-context.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DIAG_ID = 'diag-pr861';
const DREAMER_ID = 'dreamer-pr861';
const SCRIBE_ID = 'scribe-pr861';
const ART_ID = 'artificer-pr861';
const EVAL_ID = 'evaluator-pr861';
const DIAG_ART = 'pi-art-diag-pr861';
const DREAMER_ART = 'pi-art-dreamer-pr861';
const SCRIBE_ART = 'pi-art-scribe-pr861';
const ART_ART = 'pi-art-artificer-pr861-seed';

const SHORT_SUMMARY = 'agent wrote config from guessed contracts instead of the authoritative one';
const LONG_SUMMARY = 'x'.repeat(FORMATION_FIELD_MAX_CHARS + 100);

function diagnosisContent(summary: string): Record<string, unknown> {
  return {
    valid: true,
    diagnosisId: 'diag-pr861',
    summary,
    rootCause: 'agent inferred a configuration contract from example files instead of reading the authoritative one',
    violatedPrinciples: [
      { principleId: 'T-03', title: 'Evidence first', rationale: 'contracts must be read, not guessed' },
    ],
    evidence: [
      { sourceRef: 'trajectory://session-pr861/turn-4', note: 'wrote a config without reading the contract' },
    ],
    recommendations: [
      { kind: 'principle', description: 'read the authoritative contract before mutating config' },
    ],
    confidence: 0.8,
  };
}

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
  ],
  sourcePainId: 'pain-pr861',
  contextRefs: ['pi-art-pain-pr861'],
  generatedAt: '2026-09-20T00:00:00.000Z',
};

/** Scribe principle artifact — the authoritative dreamer-lineage carrier (PRI-843 contract). */
function scribeContent(withDreamerLineage: boolean): Record<string, unknown> {
  return {
    principleId: 'contract-first-pr861',
    principleDraft: {
      title: 'Contract before mutation',
      statement: 'Read the authoritative configuration contract before mutating any config surface.',
      rationale: 'Guessed contracts drift silently from owner intent.',
      applicability: ['config mutation'],
      antiPatterns: ['inferring contracts from example files'],
      confidence: 0.8,
    },
    ...(withDreamerLineage
      ? { sourceTrace: { dreamerArtifactId: DREAMER_ART } }
      : { sourceTrace: {} }),
  };
}

// v2 code-bearing artificer payload — identical shape to the PRI-714 harness,
// whose GOOD_RULE_CODE + cases pass the real deterministic replay gate.
const RULE_CONTEXT = {
  version: 2 as const,
  history: { status: 'available' as const, truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
};
const NEG_CASE = { caseId: 'neg-1', kind: 'negative' as const, toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' as const, ruleContext: RULE_CONTEXT };
const POS_CASE = { caseId: 'pos-1', kind: 'positive' as const, toolName: 'write_file', params: { path: '/workspace/src/a.ts' }, expectedDecision: 'allow' as const, ruleContext: RULE_CONTEXT };

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

function artificerV2Content(): Record<string, unknown> {
  return {
    taskId: ART_ID,
    sourceScribeArtifactId: SCRIBE_ART,
    requiresContextVersion: 2,
    evidenceRefs: ['pain://pr861-1'],
    implementationSummary: 'read-before-write guard',
    sourceTrace: { scribeArtifactId: SCRIBE_ART },
    risks: [],
    implementationCode: GOOD_RULE_CODE,
    goldenTraceCases: [NEG_CASE, POS_CASE],
    affectedTools: ['write_file'],
    generatedAt: '2026-09-20T00:00:00.000Z',
  };
}

function evaluatorApprovedPayload(): Record<string, unknown> {
  return {
    taskId: EVAL_ID,
    sourceArtificerArtifactId: ART_ART,
    evaluation: {
      decision: 'approved',
      summary: '规则与原则一致，全部用例通过。',
      score: 0.9,
      strengths: ['守卫取值替代字符串方法直接调用'],
      concerns: [],
      requiredChanges: [],
    },
    sourceTrace: { artificerArtifactId: ART_ART, scribeArtifactId: SCRIBE_ART },
    risks: [],
    generatedAt: '2026-09-20T00:00:00.000Z',
  };
}

// ── World (durable lineage, production stores) ───────────────────────────────

interface World {
  workspaceDir: string;
  stateManager: RuntimeStateManager;
  emitter: StoreEventEmitter;
  emitted: { eventType: string; payload: Record<string, unknown> }[];
  store: SqlitePIArtifactStore;
  evaluator: EvaluatorRunner;
}

function meta(o: Record<string, unknown> = {}): string {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
    inputArtifactRefs: [], outputArtifactRefs: [], ...o,
  });
}

async function makeWorld(opts: { lineage: 'full' | 'none' | 'broken-diag'; summary?: string }): Promise<World> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri861-echo-'));
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  const emitter = new StoreEventEmitter();
  const emitted: World['emitted'] = [];
  emitter.onTelemetry((event) => {
    emitted.push({ eventType: event.eventType, payload: event.payload });
  });
  const store = new SqlitePIArtifactStore(new SqliteConnection(workspaceDir));

  const withDiag = opts.lineage === 'full';
  const withDreamer = opts.lineage !== 'none';
  const now = '2026-09-20T00:00:00.000Z';
  const mkTask = async (spec: { id: string; kind: string; deps: readonly string[] }): Promise<void> => {
    await stateManager.createTask({
      taskId: spec.id, taskKind: spec.kind, status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: meta({ dependencyTaskIds: spec.deps }),
    });
    await stateManager.acquireLease({ taskId: spec.id, owner: 'pri861-test', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded(spec.id);
  };
  const upsert = (spec: { artifactId: string; sourceTaskId: string; content: unknown; lineage: readonly string[] }): Promise<unknown> =>
    store.upsertArtifact({
      artifactId: spec.artifactId, artifactKind: 'principle', sourceTaskId: spec.sourceTaskId,
      lineageArtifactIds: [...spec.lineage],
      validationStatus: 'pending', contentJson: JSON.stringify(spec.content), createdAt: now, updatedAt: now,
    });

  if (withDreamer) {
    if (withDiag) {
      await mkTask({ id: DIAG_ID, kind: 'diag_router', deps: [] });
      await upsert({ artifactId: DIAG_ART, sourceTaskId: DIAG_ID, content: diagnosisContent(opts.summary ?? SHORT_SUMMARY), lineage: [] });
    }
    await mkTask({ id: DREAMER_ID, kind: 'dreamer', deps: withDiag ? [DIAG_ID] : [] });
    await upsert({ artifactId: DREAMER_ART, sourceTaskId: DREAMER_ID, content: DREAMER_CONTENT, lineage: withDiag ? [DIAG_ART] : [] });
  }
  await mkTask({ id: SCRIBE_ID, kind: 'scribe', deps: withDreamer ? [DREAMER_ID] : [] });
  await upsert({ artifactId: SCRIBE_ART, sourceTaskId: SCRIBE_ID, content: scribeContent(withDreamer), lineage: withDreamer ? [DREAMER_ART] : [] });
  await mkTask({ id: ART_ID, kind: 'artificer', deps: [SCRIBE_ID] });
  await upsert({ artifactId: ART_ART, sourceTaskId: ART_ID, content: artificerV2Content(), lineage: [SCRIBE_ART] });
  await stateManager.createTask({
    taskId: EVAL_ID, taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: meta({ dependencyTaskIds: [ART_ID] }),
  });

  const runtimeAdapter: PDRuntimeAdapter = {
    startRun: async (req: { inputPayload: unknown }) => ({
      runId: 'run-pr861',
      runtimeKind: 'test-double',
      startedAt: new Date().toISOString(),
      inputPayload: req.inputPayload,
    }),
    pollRun: async () => ({ status: 'succeeded', runId: 'run-pr861' }),
    fetchOutput: async () => ({ runId: 'run-pr861', payload: evaluatorApprovedPayload() }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;

  const evaluator = new EvaluatorRunner(
    {
      stateManager,
      runtimeAdapter,
      eventEmitter: emitter,
      artifactStore: store,
      validator: new DefaultEvaluatorValidator(),
    },
    {
      owner: 'pri861-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000,
      gateDeps: createProductionGateDeps(),
    },
  );

  return { workspaceDir, stateManager, emitter, emitted, store, evaluator };
}

function closeWorld(world: World): void {
  void world.stateManager.close();
  try { fs.rmSync(world.workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
}

/** Real consumer: approval card built by the production RuleHostWriter reader. */
function approvalTriggerReason(artifact: {
  artifactId: string; artifactKind: 'rule'; sourceTaskId: string; contentJson: string;
  validationStatus: 'validated'; createdAt: string; updatedAt: string;
}): string | undefined {
  const writer = new RuleHostWriter({ gateDeps: createProductionGateDeps() });
  return writer.buildApprovalContext(
    {} as unknown as WriterInput,
    { ...artifact, lineageArtifactIds: [] },
  ).triggerReason;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PRI-861 — painReasonSummary echo into the production rule artifact', () => {
  let world: World;

  afterEach(() => {
    closeWorld(world);
  });

  it('full formation lineage: rule contentJson carries the projected diagnosis summary and the approval card shows it', async () => {
    world = await makeWorld({ lineage: 'full' });
    const result = await world.evaluator.run(EVAL_ID);
    expect(result.status).toBe('succeeded');

    const ruleArtifact = (await world.store.listBySourceTaskId(EVAL_ID)).find((a) => a.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    if (!ruleArtifact) return;
    expect(ruleArtifact.artifactId).toContain('pi-rule-');

    const ruleContent = JSON.parse(ruleArtifact.contentJson) as Record<string, unknown>;
    // Echo contract: byte-equal to the bounded projection of the diagnosis
    // artifact — not a fresh derivation, not a rewrite.
    expect(ruleContent.painReasonSummary).toBe(SHORT_SUMMARY);

    // AC3 — real consumer: the production reader path surfaces it as the
    // Owner-visible trigger reason (no more generic fallback).
    expect(approvalTriggerReason({
      artifactId: ruleArtifact.artifactId,
      artifactKind: 'rule',
      sourceTaskId: ruleArtifact.sourceTaskId,
      contentJson: ruleArtifact.contentJson,
      validationStatus: 'validated',
      createdAt: ruleArtifact.createdAt,
      updatedAt: ruleArtifact.updatedAt,
    })).toBe(SHORT_SUMMARY);
  }, 60_000);

  it('long diagnosis summary is echoed already-clamped (bounded projection inherited, never full text)', async () => {
    world = await makeWorld({ lineage: 'full', summary: LONG_SUMMARY });
    const result = await world.evaluator.run(EVAL_ID);
    expect(result.status).toBe('succeeded');

    const ruleArtifact = (await world.store.listBySourceTaskId(EVAL_ID)).find((a) => a.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    if (!ruleArtifact) return;
    const ruleContent = JSON.parse(ruleArtifact.contentJson) as Record<string, unknown>;
    const echoed = ruleContent.painReasonSummary;
    expect(typeof echoed).toBe('string');
    expect((echoed as string).length).toBeLessThanOrEqual(FORMATION_FIELD_MAX_CHARS);
    expect(echoed).toBe(`${LONG_SUMMARY.slice(0, FORMATION_FIELD_MAX_CHARS - 1)}…`);
  }, 60_000);

  it('legacy chain without dreamer lineage: field absent, skip event observable, assembly unaffected, reader keeps fallback', async () => {
    world = await makeWorld({ lineage: 'none' });
    const result = await world.evaluator.run(EVAL_ID);
    expect(result.status).toBe('succeeded');

    const ruleArtifact = (await world.store.listBySourceTaskId(EVAL_ID)).find((a) => a.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    if (!ruleArtifact) return;

    // Negative control: absence stays absence — no fabrication, no placeholder.
    const ruleContent = JSON.parse(ruleArtifact.contentJson) as Record<string, unknown>;
    expect(Object.hasOwn(ruleContent, 'painReasonSummary')).toBe(false);

    // rc-9: the degradation is observable at the decision point.
    const skipped = world.emitted.filter((e) => e.eventType === 'evaluator_pain_reason_summary_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.payload.reason).toBe('no_dreamer_lineage_on_scribe');
    expect(typeof skipped[0]?.payload.nextAction).toBe('string');

    // Reader fallback semantics unchanged (locked behavior, PRI-185).
    expect(approvalTriggerReason({
      artifactId: ruleArtifact.artifactId,
      artifactKind: 'rule',
      sourceTaskId: ruleArtifact.sourceTaskId,
      contentJson: ruleArtifact.contentJson,
      validationStatus: 'validated',
      createdAt: ruleArtifact.createdAt,
      updatedAt: ruleArtifact.updatedAt,
    })).toBe('RuleHost candidate requires human approval before activation.');
  }, 60_000);

  it('dreamer lineage present but diagnosis unresolvable: field absent, skip event names the diagnosis gap, assembly succeeds', async () => {
    // The PRI-838 degradation the echo must survive: the resolver finds the
    // dreamer but the dreamer task has no diagnostic-stage dependency, so it
    // returns a context WITHOUT sourceDiagnosis (never throws).
    world = await makeWorld({ lineage: 'broken-diag' });
    const result = await world.evaluator.run(EVAL_ID);
    expect(result.status).toBe('succeeded');

    const ruleArtifact = (await world.store.listBySourceTaskId(EVAL_ID)).find((a) => a.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    if (!ruleArtifact) return;
    const ruleContent = JSON.parse(ruleArtifact.contentJson) as Record<string, unknown>;
    expect(Object.hasOwn(ruleContent, 'painReasonSummary')).toBe(false);

    const skipped = world.emitted.filter((e) => e.eventType === 'evaluator_pain_reason_summary_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.payload.reason).toBe('diagnosis_summary_unavailable');
    expect(typeof skipped[0]?.payload.nextAction).toBe('string');
  }, 60_000);
});
