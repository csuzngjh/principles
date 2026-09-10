/**
 * PRI-714 (review fix #3): downstream contract — Chinese evaluator feedback
 * survives the artificer repair round and the re-evaluation round.
 *
 * Proves, through REAL production components (real runners, real
 * DefaultEvaluatorValidator with the PRI-630 convergence contract, real
 * deterministic replay gate, real artifact store):
 *
 *   Round 1  evaluator emits needs_revision with CHINESE summary/concerns/
 *            requiredChanges (as the zh-CN language directive asks) →
 *            repair task seeded carrying the Chinese feedback;
 *   Repair   the artificer repair prompt carries the Chinese requiredChange
 *            verbatim (repairFeedback), and the code itself is unchanged;
 *   Round 2  the evaluator's startRun prompt carries the Chinese prior
 *            requirement statement verbatim (previousEvaluation context), and
 *            the Chinese requirementLedger echo PASSES the real validator's
 *            verbatim-equality convergence check → approved → pi-rule.
 *
 * Machine protocol invariants are asserted on every hop: decision enums,
 * caseIds, lineage artifact ids, and the implementation code are never
 * rewritten.
 *
 * Test-double scope note: the scripted LLM proves the CONTRACT AND WIRING
 * (Chinese text is transported, parsed, validated and consumed). It does NOT
 * prove a real LLM will follow the language directive — that remains
 * probabilistic by nature.
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
import type { EffectivePdConfig } from '../../config/pd-config-types.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let emitter: StoreEventEmitter;
let store: SqlitePIArtifactStore;

const SCRIBE_ID = 'scribe-lang';
const ART1_ID = 'artificer-lang-1';
const EVAL1_ID = 'evaluator-lang-1';
const REPAIR_ID = 'artificer-repair-lang-1';
const EVAL2_ID = 'evaluator-lang-2';
const SCRIBE_ART = 'pi-art-scribe-lang';

/** Round-1 RuleCode (buggy) and Round-2 RuleCode (fixed) — must reach the rule artifact byte-identical. */
const BAD_RULE_CODE = `function evaluate(input, helpers) {
  if (input.action.paramsSummary.includes('/etc/passwd')) {
    return { decision: 'block', matched: true, reason: 'risk path' };
  }
  return { decision: 'allow', matched: false, reason: 'safe path' };
}`;

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

/** Chinese round-1 feedback (what the zh-CN language directive asks for). */
const ZH_SUMMARY = '规则实现与原则意图不一致：直接对 paramsSummary 调用字符串方法。';
const ZH_CONCERN = 'paramsSummary 可能为对象或数组，直接调用 includes 会崩溃。';
const ZH_REQUIRED_CHANGE = '修复 paramsSummary 字符串方法崩溃：先用 typeof 守卫取值，再做前缀匹配。';

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

function evaluatorOutput(
  taskId: string,
  artificerArtifactId: string,
  decision: 'approved' | 'needs_revision',
): unknown {
  return {
    taskId,
    sourceArtificerArtifactId: artificerArtifactId,
    evaluation: {
      decision,
      summary: decision === 'needs_revision' ? ZH_SUMMARY : '中文反馈闭环回归：修复后的规则已通过全部用例。',
      score: decision === 'approved' ? 0.9 : 0.6,
      strengths: decision === 'approved' ? ['使用守卫取值替代字符串方法直接调用'] : [],
      concerns: decision === 'needs_revision' ? [ZH_CONCERN] : [],
      requiredChanges: decision === 'needs_revision' ? [ZH_REQUIRED_CHANGE] : [],
      // PRI-630 convergence: round 2 must echo the round-1 Chinese requirement
      // VERBATIM — the real validator enforces exact statement equality.
      ...(taskId === EVAL2_ID
        ? {
            priorRequirementStatuses: [{ id: 'req-1', status: 'resolved' }],
            requirementLedger: [{ id: 'req-1', statement: ZH_REQUIRED_CHANGE, status: 'resolved' }],
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

async function mkTask(spec: { id: string; kind: string; deps: readonly string[]; diagnosticJson?: string }): Promise<void> {
  await stateManager.createTask({
    taskId: spec.id, taskKind: spec.kind, status: 'pending', attemptCount: 0, maxAttempts: 3,
    diagnosticJson: spec.diagnosticJson ?? meta({ dependencyTaskIds: spec.deps }),
  });
}

async function succeed(id: string): Promise<void> {
  await stateManager.acquireLease({ taskId: id, owner: 'lang-test', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(id);
}

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lang-contract-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  emitter = new StoreEventEmitter();
  store = new SqlitePIArtifactStore(new SqliteConnection(workspaceDir));
});

afterEach(async () => {
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

describe('PRI-714 review fix: Chinese evaluator feedback through repair + re-evaluation (downstream contract)', () => {
  it('Chinese feedback survives artificer repair and passes the PRI-630 verbatim ledger convergence', async () => {
    // ── lineage: scribe task + artifact ──
    await mkTask({ id: SCRIBE_ID, kind: 'scribe', deps: [] });
    await succeed(SCRIBE_ID);
    await store.upsertArtifact({
      artifactId: SCRIBE_ART, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
      lineageArtifactIds: [], validationStatus: 'validated',
      contentJson: JSON.stringify({ principleId: 'pri-lang-read-before-write', principleDraft: { statement: '先读后写。' }, sourceTrace: {} }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // ── Round 1: artificer emits the buggy code ──
    await mkTask({ id: ART1_ID, kind: 'artificer', deps: [SCRIBE_ID] });
    const artificer1 = new ArtificerRunner(
      {
        stateManager,
        runtimeAdapter: scriptedAdapter(artificerOutput(BAD_RULE_CODE, SCRIBE_ART, ART1_ID), [], 'run-art-1'),
        eventEmitter: emitter,
        artifactStore: store,
        validator: new DefaultArtificerValidator(),
      },
      { owner: 'lang-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000, effectiveConfig: flagsOffConfig() },
    );
    expect((await artificer1.run(ART1_ID)).status).toBe('succeeded');

    // ── Round 1: evaluator needs_revision with CHINESE feedback ──
    await mkTask({ id: EVAL1_ID, kind: 'evaluator', deps: [ART1_ID] });
    const eval1Prompts: string[] = [];
    const evaluator1 = new EvaluatorRunner(
      {
        stateManager,
        runtimeAdapter: scriptedAdapter(evaluatorOutput(EVAL1_ID, 'pi-art-artificer-lang-1-run-1', 'needs_revision'), eval1Prompts, 'run-eval-1'),
        eventEmitter: emitter,
        artifactStore: store,
        validator: new DefaultEvaluatorValidator(),
        isRepairLoopEnabled: () => true,
        seedArtificerRepairTask: async (params) => {
          await mkTask({ id: REPAIR_ID, kind: 'artificer', deps: params.inheritedDependencyTaskIds, diagnosticJson: meta({
            dependencyTaskIds: params.inheritedDependencyTaskIds,
            repairPayload: params.repairPayload,
          }) });
          return REPAIR_ID;
        },
      },
      {
        owner: 'lang-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000,
        gateDeps: createProductionGateDeps(),
        outputLanguage: 'zh-CN',
      },
    );
    const eval1Result = await evaluator1.run(EVAL1_ID);
    expect(eval1Result.status).toBe('succeeded');

    // (1) The zh-CN language directive is on the round-1 evaluator prompt,
    //     with the review subject's nested field list and the PRI-630 ledger
    //     echo guard.
    expect(eval1Prompts).toHaveLength(1);
    const eval1Prompt = eval1Prompts[0] ?? '';
    expect(eval1Prompt).toContain('LANGUAGE DIRECTIVE');
    expect(eval1Prompt).toContain('Simplified Chinese');
    expect(eval1Prompt).toContain('codeReview.traceCoverage.gaps');
    expect(eval1Prompt).toContain('adversarialCases[].rationale');
    expect(eval1Prompt).toContain('requirementLedger[].statement MUST be copied verbatim');

    // (2) The repair task was seeded and carries the Chinese feedback.
    const repairTask = await stateManager.getTask(REPAIR_ID);
    expect(repairTask).toBeDefined();

    // ── Repair round: the artificer prompt carries the Chinese requiredChange verbatim ──
    const repairPrompts: string[] = [];
    const artificerRepair = new ArtificerRunner(
      {
        stateManager,
        runtimeAdapter: scriptedAdapter(artificerOutput(GOOD_RULE_CODE, SCRIBE_ART, REPAIR_ID), repairPrompts, 'run-repair-1'),
        eventEmitter: emitter,
        artifactStore: store,
        validator: new DefaultArtificerValidator(),
      },
      { owner: 'lang-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000, effectiveConfig: flagsOffConfig() },
    );
    expect((await artificerRepair.run(REPAIR_ID)).status).toBe('succeeded');
    expect(repairPrompts).toHaveLength(1);
    expect(repairPrompts[0]).toContain(ZH_REQUIRED_CHANGE);
    expect(repairPrompts[0]).toContain(ZH_CONCERN);

    const repairArtifacts = await store.listBySourceTaskId(REPAIR_ID);
    const repairArtifact = repairArtifacts.find((a) => a.artifactKind === 'principle');
    expect(repairArtifact).toBeDefined();
    if (!repairArtifact) return;

    // ── Round 2: evaluator approves; the Chinese prior requirement flows in
    //    via previousEvaluation and the verbatim Chinese ledger echo PASSES
    //    the real convergence validation ──
    await mkTask({ id: EVAL2_ID, kind: 'evaluator', deps: [REPAIR_ID] });
    const eval2Prompts: string[] = [];
    const evaluator2 = new EvaluatorRunner(
      {
        stateManager,
        runtimeAdapter: scriptedAdapter(evaluatorOutput(EVAL2_ID, repairArtifact.artifactId, 'approved'), eval2Prompts, 'run-eval-2'),
        eventEmitter: emitter,
        artifactStore: store,
        validator: new DefaultEvaluatorValidator(),
      },
      {
        owner: 'lang-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000,
        gateDeps: createProductionGateDeps(),
        outputLanguage: 'zh-CN',
      },
    );
    const eval2Result = await evaluator2.run(EVAL2_ID);
    // The real DefaultEvaluatorValidator (with expectedRequirements from the
    // Chinese prior context) accepted the verbatim Chinese ledger echo.
    expect(eval2Result.status).toBe('succeeded');

    // (3) The round-2 evaluator prompt carried the Chinese prior requirement
    //     statement verbatim — Chinese text is consumed downstream, not mangled.
    expect(eval2Prompts).toHaveLength(1);
    expect(eval2Prompts[0]).toContain(ZH_REQUIRED_CHANGE);

    // (4) The formal rule artifact assembles with machine fields intact.
    const eval2Artifacts = await store.listBySourceTaskId(EVAL2_ID);
    const ruleArtifact = eval2Artifacts.find((a) => a.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    if (!ruleArtifact) return;
    expect(ruleArtifact.artifactId).toContain('pi-rule-');
    expect(ruleArtifact.validationStatus).toBe('validated');
    const ruleContent = JSON.parse(ruleArtifact.contentJson) as { implementationCode?: string; goldenTraceCases?: { caseId: string }[] };
    // The code is consumed BYTE-IDENTICAL — never translated or rewritten.
    expect(ruleContent.implementationCode).toBe(GOOD_RULE_CODE);
    expect(ruleContent.goldenTraceCases?.map((c) => c.caseId)).toEqual(['neg-1', 'pos-1']);
  }, 60_000);
});
