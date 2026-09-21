/**
 * runRuleHostPipeline unit tests (PRI-429).
 *
 * Covers the atomic capability contract (ArtificerL2 + Evaluator both run or
 * neither runs) and exact sourcePainId matching (D fix: pain-1 must NOT match
 * pain-10).
 *
 * ERR refs considered:
 *   - ERR-001: parsed JSON treated as unknown
 *   - ERR-005/007: no `as` bypass; type narrowing via typeof + Object.hasOwn
 *   - ERR-009: missing sourcePainId = no match (fail loud)
 *   - ERR-013: Object.hasOwn for untrusted key checks
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/class-methods-use-this, @typescript-eslint/require-await */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runRuleHostPipeline, backfillScribeIdentity } from '../../src/services/rulehost-pipeline-runner.js';
import type { CodeRuleCapability } from '../../src/services/rulehost-pipeline-runner.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus, PIArtifactStore, RuntimeCapabilities, RuntimeHealth, RuntimeArtifactRef, ContextItem, StructuredRunOutput, StartRunInput } from '@principles/core/runtime-v2';
import { RuntimeStateManager, createPITaskDiagnosticJson, SqliteApprovalQueueStore } from '@principles/core/runtime-v2';
import { addPrincipleToLedger, updatePrinciple } from '@principles/core/principle-tree-ledger';
import { saveHostToolDeclaration } from '@principles/host-runtime';

type StageFactory = (taskId: string, priorArtifactId?: string) => unknown;
type EvaluatorFactory = (taskId: string, artificerArtifactId: string) => unknown;

class ScriptedAdapter implements PDRuntimeAdapter {
  readonly startRunCalls: { taskId: string }[] = [];
  readonly startRunInputs = new Map<string, StartRunInput>();
  artifactStore: PIArtifactStore | null = null;
  constructor(private readonly factories: { dreamer: StageFactory; philosopher: StageFactory; scribe: StageFactory; artificer: StageFactory; evaluator: EvaluatorFactory }) {}

  private kindFor(taskId: string): 'dreamer' | 'philosopher' | 'scribe' | 'artificer' | 'evaluator' {
    if (taskId.startsWith('dreamer')) return 'dreamer';
    if (taskId.includes('philosopher')) return 'philosopher';
    if (taskId.includes('scribe')) return 'scribe';
    if (taskId.includes('artificer')) return 'artificer';
    return 'evaluator';
  }

  private async priorArtifactId(priorKind: string): Promise<string | undefined> {
    const calls = this.startRunCalls.filter((c) => this.kindFor(c.taskId) === priorKind);
    const last = calls[calls.length - 1];
    if (!last || !this.artifactStore) return undefined;
    const arts = await this.artifactStore.listBySourceTaskId(last.taskId);
    return arts[0]?.artifactId;
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    this.startRunCalls.push({ taskId: input.taskRef.taskId });
    const runId = `run-${input.taskRef.taskId}`;
    this.startRunInputs.set(runId, input);
    return { runId, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  }
  async pollRun(_runId: string): Promise<RunStatus> { return { status: 'succeeded', runId: 'run-x' }; }
  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    const taskId = runId.replace(/^run-/, '');
    const kind = this.kindFor(taskId);
    let payload: unknown;
    if (kind === 'dreamer') payload = this.factories.dreamer(taskId);
    else if (kind === 'philosopher') payload = this.factories.philosopher(taskId, await this.priorArtifactId('dreamer'));
    else if (kind === 'scribe') payload = this.factories.scribe(taskId, await this.priorArtifactId('philosopher'));
    else if (kind === 'artificer') payload = this.factories.artificer(taskId, await this.priorArtifactId('scribe'));
    else {
      let artificerArtifactId = await this.priorArtifactId('artificer');
      if (!artificerArtifactId) {
        const inputPayload = this.startRunInputs.get(runId)?.inputPayload;
        if (typeof inputPayload === 'string') {
          const parsed: unknown = JSON.parse(inputPayload);
          if (parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, 'sourceArtificerArtifactId')) {
            const candidate = Reflect.get(parsed, 'sourceArtificerArtifactId');
            if (typeof candidate === 'string') artificerArtifactId = candidate;
          }
        }
      }
      payload = this.factories.evaluator(taskId, requireLineage(artificerArtifactId, 'sourceArtificerArtifactId'));
    }
    return { runId, payload };
  }
  async cancelRun(_runId: string): Promise<void> { /* noop */ }
  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: false,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: false,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }
  async healthCheck(): Promise<RuntimeHealth> {
    return { healthy: true, degraded: false, warnings: [], lastCheckedAt: new Date().toISOString() };
  }
  async fetchArtifacts(_runId: string): Promise<RuntimeArtifactRef[]> { return []; }
  async appendContext(_runId: string, _items: ContextItem[]): Promise<void> { /* noop */ }
  async refreshCapabilities(): Promise<RuntimeCapabilities> { return this.getCapabilities(); }
  kind(): 'test-double' { return 'test-double'; }
}

// ── Output factories ─────────────────────────────────────────────────────────

function dreamerOut(taskId: string, painId: string): unknown {
  return {
    valid: true, taskId,
    candidates: [{ candidateIndex: 0, badDecision: 'Wrote to /etc/passwd', betterDecision: 'Block system path writes', rationale: 'OS damage risk', confidence: 0.85, riskLevel: 'low' as const, strategicPerspective: 'safety' }],
    sourcePainId: painId, contextRefs: [], generatedAt: new Date().toISOString(),
  };
}

function requireLineage(id: string | undefined, field: string): string {
  if (!id) throw new Error(`missing required lineage field: ${field}`);
  return id;
}

function philosopherOut(taskId: string, priorId?: string): unknown {
  return {
    taskId, sourceDreamerArtifactId: requireLineage(priorId, 'sourceDreamerArtifactId'),
    thesis: 'System path writes must be blocked',
    principleCandidate: { title: 'Block system path writes', rationale: 'OS corruption risk', scope: 'write ops', confidence: 0.9 },
    risks: [], generatedAt: new Date().toISOString(),
  };
}

function scribeOut(taskId: string, priorId?: string): unknown {
  return {
    taskId, sourcePhilosopherArtifactId: requireLineage(priorId, 'sourcePhilosopherArtifactId'),
    principleDraft: { title: 'Block system path writes', statement: 'Writes to /etc, /boot, /sys must be blocked.', rationale: 'OS corruption risk', applicability: ['write_file'], antiPatterns: ['Hardcoded allow'], confidence: 0.9 },
    sourceTrace: { philosopherArtifactId: requireLineage(priorId, 'sourceTrace.philosopherArtifactId') },
    risks: [], generatedAt: new Date().toISOString(),
  };
}

// PRI-780: v2-only generation — the pipeline requires an Owner-labelled pack
// and the artificer output must satisfy the v2 contract (case parity incl.
// ruleContext + verbatim evidenceRefs).
const PIPE_RULE_CONTEXT = {
  version: 2 as const,
  history: { status: 'available' as const, truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
};
const PIPE_POS_CASE = { caseId: 'pos-1', kind: 'positive' as const, toolName: 'write_file', params: { path: '/project/f.txt' }, expectedDecision: 'allow' as const, ruleContext: PIPE_RULE_CONTEXT };
const PIPE_NEG_CASE = { caseId: 'neg-1', kind: 'negative' as const, toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' as const, ruleContext: PIPE_RULE_CONTEXT };
const PIPE_PACK = {
  sourceNegativeCase: PIPE_NEG_CASE,
  ownerDesiredOutcome: 'block system path writes',
  positiveCounterexamples: [PIPE_POS_CASE],
  evidenceRefs: ['pain://pipe-1'],
  redactionNotes: [],
};

function artificerV2(taskId: string, priorId?: string): unknown {
  return {
    taskId, sourceScribeArtifactId: requireLineage(priorId, 'sourceScribeArtifactId'),
    requiresContextVersion: 2,
    evidenceRefs: ['pain://pipe-1'],
    implementationPlan: { summary: 'Block /etc writes', targetSurface: 'rule-host', changes: ['matcher'], tests: ['unit'], rolloutNotes: ['shadow'], confidence: 0.85 },
    implementationCode: 'function evaluate(input, helpers) { const p = String(input?.action?.paramsSummary?.path ?? input?.action?.normalizedPath ?? ""); if (p.startsWith("/etc")) return { decision: "block", matched: true, reason: "system path" }; const ctx = input?.context; if (ctx && ctx.facts && ctx.facts.priorReadOfTarget === "no") { return { decision: "block", matched: true, reason: "no prior read" }; } return { decision: "allow", matched: false, reason: "ok" }; }',
    implementationSummary: 'Block system path writes',
    goldenTraceCases: [PIPE_POS_CASE, PIPE_NEG_CASE],
    affectedTools: ['write_file'],
    sourceTrace: { scribeArtifactId: requireLineage(priorId, 'sourceTrace.scribeArtifactId') },
    risks: [], generatedAt: new Date().toISOString(),
  };
}

function evaluatorApproved(taskId: string, artificerArtifactId: string): unknown {
  return {
    taskId, sourceArtificerArtifactId: artificerArtifactId,
    evaluation: { decision: 'approved', summary: 'approved', score: 0.9, strengths: [], concerns: [], requiredChanges: [] },
    sourceTrace: { artificerArtifactId },
    risks: [], generatedAt: new Date().toISOString(),
    codeReview: { intentConsistency: { aligned: true, explanation: 'ok' }, scopePrecision: { verdict: 'precise' as const, explanation: 'ok' }, traceCoverage: { sufficient: true, gaps: [], explanation: 'ok' } },
    adversarialCases: [{ caseId: 'adv-1', attackType: 'boundary' as const, toolName: 'write_file', params: { path: '/etc/shadow' }, expectedDecision: 'block' as const, rationale: 'system path' }],
    adversarialResult: { passed: true, failedCases: [] },
  };
}

function evaluatorRejected(taskId: string, artificerArtifactId: string): unknown {
  return {
    taskId, sourceArtificerArtifactId: artificerArtifactId,
    evaluation: { decision: 'rejected', summary: 'rejected: code too narrow', score: 0.3, strengths: [], concerns: ['misses /boot path'], requiredChanges: ['add /boot matcher'] },
    sourceTrace: { artificerArtifactId },
    risks: [], generatedAt: new Date().toISOString(),
    codeReview: { intentConsistency: { aligned: false, explanation: 'misses /boot' }, scopePrecision: { verdict: 'imprecise' as const, explanation: 'narrow' }, traceCoverage: { sufficient: false, gaps: ['/boot'], explanation: 'missing' } },
    adversarialCases: [{ caseId: 'adv-1', attackType: 'boundary' as const, toolName: 'write_file', params: { path: '/boot/grub' }, expectedDecision: 'block' as const, rationale: 'system path' }],
    adversarialResult: { passed: false, failedCases: [{ caseId: 'adv-1', errorType: 'wrong_decision', message: 'expected block, got allow' }] },
  };
}

function evaluatorNeedsRevision(taskId: string, artificerArtifactId: string): unknown {
  return {
    taskId, sourceArtificerArtifactId: artificerArtifactId,
    evaluation: { decision: 'needs_revision', summary: 'needs revision: adversarial replay failed', score: 0.4, strengths: [], concerns: ['adversarial case failed'], requiredChanges: ['fix matcher'] },
    sourceTrace: { artificerArtifactId },
    risks: [], generatedAt: new Date().toISOString(),
    codeReview: { intentConsistency: { aligned: false, explanation: 'misses system paths' }, scopePrecision: { verdict: 'too_narrow' as const, explanation: 'narrow' }, traceCoverage: { sufficient: false, gaps: [], explanation: 'missing' } },
    adversarialCases: [{ caseId: 'adv-1', attackType: 'boundary' as const, toolName: 'write_file', params: { path: '/etc/shadow' }, expectedDecision: 'block' as const, rationale: 'system path' }],
    adversarialResult: { passed: false, failedCases: [{ caseId: 'adv-1', attackType: 'boundary' as const, actualDecision: 'allow', expectedDecision: 'block', rationale: 'system path' }] },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir = '';

function makeTmpDir(): string {
  // mkdtempSync's random suffix keeps the path unpredictable (CodeQL
  // js/insecure-temporary-file: the pipeline language tests WRITE
  // .pd/config.yaml under this dir).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pipe-'));
  // PRI-661: the pipeline's evaluator replay resolves the production gate
  // context from durable workspace provenance — seed a declaration like every
  // real host does on startup.
  saveHostToolDeclaration(dir, {
    version: 1,
    hostKind: 'testhost',
    mappings: [
      { rawToolName: 'Write', canonicalKind: 'write' },
      { rawToolName: 'Edit', canonicalKind: 'write' },
      { rawToolName: 'Bash', canonicalKind: 'execute' },
    ],
    declaredAt: new Date().toISOString(),
  });
  return dir;
}

function makeAdapter(opts?: { evaluator?: EvaluatorFactory }): ScriptedAdapter {
  return new ScriptedAdapter({
    dreamer: (taskId) => dreamerOut(taskId, 'pain-test-001'),
    philosopher: philosopherOut,
    scribe: scribeOut,
    artificer: artificerV2,
    evaluator: opts?.evaluator ?? evaluatorApproved,
  });
}

/**
 * Seed a dreamer task with sourcePainId embedded as a TOP-LEVEL key in
 * diagnosticJson (outside the pi_metadata envelope). This mirrors the pattern
 * from source-trace-locator.test.ts and PainSignalBridge.
 */
async function seedDreamerWithId(
  sm: RuntimeStateManager,
  taskId: string,
  painId: string,
  channel: 'prompt' | 'code_tool_hook' | 'defer_archive' = 'code_tool_hook',
  candidateId?: string,
): Promise<void> {
  const baseMetadata = JSON.parse(createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel, timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [],
  })) as Record<string, unknown>;
  const diagnosticJson = JSON.stringify({ ...baseMetadata, sourcePainId: painId, ...(candidateId ? { candidateId } : {}) });
  await sm.createTask({ taskId, taskKind: 'dreamer', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson });
}

/** Seed a dreamer task with raw diagnosticJson (for missing/wrong-type tests). */
async function seedDreamerRaw(sm: RuntimeStateManager, taskId: string, diagnosticJson: string): Promise<void> {
  await sm.createTask({ taskId, taskKind: 'dreamer', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runRuleHostPipeline (PRI-429) — atomic capability + exact pain match', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } tmpDir = ''; }
  });

  // ── Test 1: Capability ON + approved → candidate_ready_for_owner_review ──
  it('capability ON + evaluator approved → candidate_ready_for_owner_review; scribe identity backfilled on the rule path too (EP002-R4 follow-up #2)', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-seeded-001', 'pain-test-001', 'code_tool_hook', 'cand-001');
    await sm.close();
    addPrincipleToLedger(path.join(tmpDir, '.state'), {
      id: 'ledger-principle-001', version: 1, text: 'test ledger principle', triggerPattern: '', action: '',
      status: 'candidate', evaluability: 'weak_heuristic', priority: 'P1', scope: 'general',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0, derivedFromPainIds: ['cand-001'],
      ruleIds: [], conflictsWithPrincipleIds: [], createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    });

    const adapter = makeAdapter();
    const capability: CodeRuleCapability = { enabled: true, artificerAdapter: adapter };
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-test-001', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      codeRuleCapability: capability,
      behaviorExamplePack: PIPE_PACK,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.decision, JSON.stringify(result)).toBe('candidate_ready_for_owner_review');
    expect(result.stages.map((s) => s.name)).toEqual(['pain_lookup', 'dreamer', 'philosopher', 'scribe', 'adversarial_loop']);
    expect(result.ruleArtifactId).not.toBeNull();
    // P1 #1 fix: candidate should be auto-enqueued into the ApprovalQueue
    expect(result.approvalId).not.toBeNull();

    // EP002-R4 follow-up #2: the scribe artifact carries the LEDGER UUID (not
    // a title) so the evaluator propagates it into the rule artifact and the
    // Console groups the approval by an id the detail page can resolve.
    const verify = new RuntimeStateManager({ workspaceDir: tmpDir });
    await verify.initialize();
    try {
      const scribeArt = await verify.piArtifactStore.getArtifactById(
        (await verify.piArtifactStore.listBySourceTaskId(result.stages.find((s) => s.name === 'scribe')!.taskId!))
          .find((a) => a.artifactKind === 'principle')!.artifactId,
      );
      expect(scribeArt?.sourcePrincipleId).toBe('ledger-principle-001');
      const ruleArt = await verify.piArtifactStore.getArtifactById(result.ruleArtifactId!);
      expect(ruleArt?.sourcePrincipleId).toBe('ledger-principle-001');
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('adversarial feedback loop drives a second artificer round before creating a candidate', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-feedback-001', 'pain-feedback-001');
    await sm.close();

    let adapter: ScriptedAdapter;
    let artificerCallCount = 0;
    const artificerPrompts: string[] = [];
    adapter = new ScriptedAdapter({
      dreamer: (taskId) => dreamerOut(taskId, 'pain-feedback-001'),
      philosopher: philosopherOut,
      scribe: scribeOut,
      artificer: (taskId, priorId) => {
        artificerCallCount++;
        const runId = `run-${taskId}`;
        const inputPayload = adapter.startRunInputs.get(runId)?.inputPayload;
        if (typeof inputPayload === 'string') artificerPrompts.push(inputPayload);

        const base = artificerV2(taskId, priorId);
        if (artificerCallCount === 1) {
          // Round 1: code fails the adversarial replay, forcing needs_revision.
          return {
            ...base,
            implementationCode: 'function evaluate() { return { decision: "allow", matched: false, reason: "bug" }; }',
          };
        }
        // Round 2: fixed code passes the evaluator.
        return base;
      },
      evaluator: (taskId, artificerArtifactId) => {
        if (artificerCallCount === 1) {
          return evaluatorNeedsRevision(taskId, artificerArtifactId);
        }
        return evaluatorApproved(taskId, artificerArtifactId);
      },
    });

    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir,
      painId: 'pain-feedback-001',
      runtimeAdapter: adapter,
      codeRuleCapability: { enabled: true, artificerAdapter: adapter },
      behaviorExamplePack: PIPE_PACK,
      channel: 'code_tool_hook',
      pollIntervalMs: 5,
      timeoutMs: 1000,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(artificerCallCount).toBe(2);
    expect(artificerPrompts).toHaveLength(2);
    expect(artificerPrompts[1]).toContain('Prior adversarial replay failures');
    expect(result.decision, JSON.stringify(result)).toBe('candidate_ready_for_owner_review');
    expect(result.ruleArtifactId).toMatch(/^pi-rule-/);
    // Owner Decision Experience v1 Phase A: this seed carries no candidateId and
    // no ledger principle, so identity binding is unverified (candidate_unresolved)
    // and the governance publication boundary refuses the approval enqueue — the
    // two-round adversarial loop itself is unaffected.
    expect(result.approvalId).toBeNull();
    expect(result.degradationReason ?? '').toContain('identity_binding_unverified');
  }, 60_000);

  // ── Test 2: Capability OFF (explicitly disabled) → text_principle_only ──
  it('capability OFF (explicitly disabled) → text_principle_only + prompt approval enqueue + identity backfill (PRI-804)', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-seeded-002', 'pain-test-001', 'code_tool_hook', 'cand-002');
    await sm.close();
    // PRI-804(a): seed the ledger with the principle this chain's candidate maps
    // to, mirroring what the intake bridge creates in production workspaces.
    addPrincipleToLedger(path.join(tmpDir, '.state'), {
      id: 'ledger-principle-002', version: 1, text: 'test ledger principle', triggerPattern: '', action: '',
      status: 'candidate', evaluability: 'weak_heuristic', priority: 'P1', scope: 'general',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0, derivedFromPainIds: ['cand-002'],
      ruleIds: [], conflictsWithPrincipleIds: [], createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    });

    const adapter = makeAdapter();
    const capability: CodeRuleCapability = { enabled: false, disabledReason: 'artificer agent disabled in config' };
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-test-001', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      codeRuleCapability: capability,
      behaviorExamplePack: PIPE_PACK,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.decision).toBe('text_principle_only');
    expect(result.ruleArtifactId).toBeNull();
    // Scribe ran, so a principle artifact should exist.
    expect(result.principleArtifactId).not.toBeNull();
    expect(result.degradationReason).toContain('code_rule_capability_off');
    // Adversarial loop stage should be skipped (not present or skipped status).
    const advStage = result.stages.find((s) => s.name === 'adversarial_loop');
    expect(advStage?.status).toBe('skipped');

    // PRI-804: the text principle must NOT dead-end — it is enqueued into the
    // EXISTING approval queue on the prompt channel for Owner Console review.
    expect(result.approvalId).not.toBeNull();
    expect(result.approvalId).toBe(`apr_prompt_${result.principleArtifactId}`);

    // Verify the persisted approval row, the PRI-804(a) identity backfill, and
    // the terminal validation marking (real store, real SQLite, real ledger).
    const verify = new RuntimeStateManager({ workspaceDir: tmpDir });
    await verify.initialize();
    try {
      const approvalStore = new SqliteApprovalQueueStore(verify.connection);
      const record = await approvalStore.getById(result.approvalId!);
      expect(record).not.toBeNull();
      expect(record!.status).toBe('pending');
      expect(record!.channel).toBe('prompt');
      expect(record!.artifactId).toBe(result.principleArtifactId);
      const artifact = await verify.piArtifactStore.getArtifactById(result.principleArtifactId!);
      expect(artifact?.sourcePrincipleId).toBe('ledger-principle-002');
      expect(artifact?.validationStatus).toBe('validated');
    } finally {
      await verify.close();
    }
  }, 60_000);

  // ── Test 3: Capability ON + evaluator rejected → generation_rejected ──
  it('capability ON + evaluator rejected → generation_rejected', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-seeded-003', 'pain-test-001');
    await sm.close();

    const adapter = makeAdapter({ evaluator: evaluatorRejected });
    const capability: CodeRuleCapability = { enabled: true, artificerAdapter: adapter };
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-test-001', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      codeRuleCapability: capability,
      behaviorExamplePack: PIPE_PACK,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.decision).toBe('generation_rejected');
    expect(result.ruleArtifactId).toBeNull();
  }, 60_000);

  // ── Test 4: Capability OFF by default (not provided) → text_principle_only ──
  it('capability OFF by default (not provided) → text_principle_only', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-seeded-004', 'pain-test-001');
    await sm.close();

    const adapter = makeAdapter();
    // No codeRuleCapability provided — defaults to OFF.
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-test-001', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.decision).toBe('text_principle_only');
    expect(result.ruleArtifactId).toBeNull();
    expect(result.degradationReason).toContain('code_rule_capability');
  }, 60_000);

  // ── Test 5: Exact sourcePainId match — pain-1 must NOT match pain-10 ──
  it('exact sourcePainId match: pain-1 does NOT match pain-10', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    // Seed dreamer for pain-10 but query for pain-1 — must NOT match.
    await seedDreamerWithId(sm, 'dreamer-seeded-pain-10', 'pain-10');
    await sm.close();

    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-1', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('no_dreamer_task_seeded');
  }, 60_000);

  // ── Test 6: No dreamer task at all → generation_rejected ──
  it('no dreamer task seeded for pain → generation_rejected', async () => {
    tmpDir = makeTmpDir();
    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-nonexistent', runtimeAdapter: adapter,
      pollIntervalMs: 5, timeoutMs: 1000,
    });

    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('no_dreamer_task_seeded');
    expect(result.stages[0]!.name).toBe('pain_lookup');
    expect(result.stages[0]!.status).toBe('failed');
  });

  // ── Test 7: Missing or wrong-type sourcePainId → no match ──
  it('missing or wrong-type sourcePainId in diagnosticJson → no match', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    // Seed a dreamer task WITHOUT sourcePainId (only pi_metadata).
    await seedDreamerRaw(sm, 'dreamer-no-painid-001', JSON.stringify({ pi_metadata: { channel: 'prompt' } }));
    // Seed a dreamer task with WRONG-TYPE sourcePainId (number, not string).
    await seedDreamerRaw(sm, 'dreamer-wrong-type-001', JSON.stringify({ pi_metadata: { channel: 'prompt' }, sourcePainId: 12345 }));
    await sm.close();

    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: '12345', runtimeAdapter: adapter,
      pollIntervalMs: 5, timeoutMs: 1000,
    });

    // Neither task should match — missing sourcePainId and wrong-type sourcePainId
    // are both skipped (not silently matched).
    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('no_dreamer_task_seeded');
  }, 60_000);

  // ── PRI-866: comparison boundary normalizes BOTH sides via the canonical reader ──
  it('matches a historical row whose stored sourcePainId carries surrounding whitespace', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    // Pre-existing rows may carry untrimmed sourcePainId (writer-side drift).
    await seedDreamerWithId(sm, 'dreamer-padded-stored', ' pain-whitespace-1 ');
    await sm.close();

    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-whitespace-1', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.stages[0]).toMatchObject({
      name: 'pain_lookup',
      status: 'succeeded',
      taskId: 'dreamer-padded-stored',
    });
  }, 60_000);

  it('matches when the queried painId itself carries surrounding whitespace', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-padded-query', 'pain-whitespace-2');
    await sm.close();

    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: ' pain-whitespace-2 ', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.stages[0]).toMatchObject({
      name: 'pain_lookup',
      status: 'succeeded',
      taskId: 'dreamer-padded-query',
    });
  }, 60_000);

  it('blank query never matches and unresolvable rows are skipped, not crashed', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    // Rows the canonical reader resolves to null (absent / wrong-type key) —
    // malformed JSON itself cannot be inserted (the store validates it).
    await seedDreamerRaw(sm, 'dreamer-no-key-866', JSON.stringify({ pi_metadata: { channel: 'code_tool_hook' } }));
    await seedDreamerRaw(sm, 'dreamer-wrong-type-866', JSON.stringify({ pi_metadata: { channel: 'code_tool_hook' }, sourcePainId: 12345 }));
    await seedDreamerWithId(sm, 'dreamer-normal-866', 'pain-not-blank');
    await sm.close();

    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: '   ', runtimeAdapter: makeAdapter(),
      pollIntervalMs: 5, timeoutMs: 1000,
    });

    // A blank query normalizes to '' — it must not match any stored pain id,
    // and unresolvable rows are skipped via the canonical reader (rc-9: the
    // caller still reports the loud no-match reason).
    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('no_dreamer_task_seeded');
  }, 60_000);

  it('rejects ambiguous lineage when multiple runnable Dreamer tasks have the same sourcePainId', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-ambiguous-a', 'pain-ambiguous');
    await seedDreamerWithId(sm, 'dreamer-ambiguous-b', 'pain-ambiguous');
    await sm.close();

    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir,
      painId: 'pain-ambiguous',
      runtimeAdapter: makeAdapter(),
      pollIntervalMs: 5,
      timeoutMs: 1000,
    });

    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('ambiguous_dreamer_tasks_for_pain');
    expect(result.stages[0]?.status).toBe('failed');
  }, 60_000);

  it('selects the Dreamer task matching the requested activation channel', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-prompt', 'pain-multi-channel', 'prompt');
    await seedDreamerWithId(sm, 'dreamer-code-hook', 'pain-multi-channel', 'code_tool_hook');
    await sm.close();

    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir,
      painId: 'pain-multi-channel',
      runtimeAdapter: adapter,
      channel: 'code_tool_hook',
      pollIntervalMs: 5,
      timeoutMs: 1000,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.stages[0]).toMatchObject({
      name: 'pain_lookup',
      status: 'succeeded',
      taskId: 'dreamer-code-hook',
    });
  }, 60_000);

  it('uses the sole pain-linked Dreamer seed when its source channel differs from the target channel', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-prompt-seed', 'pain-cross-channel', 'prompt');
    await sm.close();

    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir,
      painId: 'pain-cross-channel',
      runtimeAdapter: adapter,
      channel: 'code_tool_hook',
      pollIntervalMs: 5,
      timeoutMs: 1000,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.stages[0]).toMatchObject({
      name: 'pain_lookup',
      status: 'succeeded',
      taskId: 'dreamer-prompt-seed',
    });
  }, 60_000);

  it('resumes from a succeeded Dreamer seed instead of trying to lease it again', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-resume', 'pain-resume');
    await sm.close();

    const firstAdapter = makeAdapter();
    await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-resume', runtimeAdapter: firstAdapter,
      pollIntervalMs: 5, timeoutMs: 1000,
      onStoreReady: (store) => { firstAdapter.artifactStore = store; },
    });

    const resumedAdapter = makeAdapter();
    const resumed = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-resume', runtimeAdapter: resumedAdapter,
      pollIntervalMs: 5, timeoutMs: 1000,
      onStoreReady: (store) => { resumedAdapter.artifactStore = store; },
    });

    expect(resumed.stages.slice(0, 2)).toEqual([
      { name: 'pain_lookup', status: 'succeeded', taskId: 'dreamer-resume' },
      { name: 'dreamer', taskId: 'dreamer-resume', status: 'succeeded' },
    ]);
    expect(resumed.degradationReason).not.toContain('lease');
  }, 60_000);

  // ── Test 8 (E fix): retried status is NOT terminal — bounded retry succeeds ──
  it('retried status triggers bounded retry and eventually succeeds (E fix)', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-retry-001', 'pain-retry-001');
    await sm.close();

    // Adapter that returns retried on first dreamer call, then succeeds.
    let dreamerCallCount = 0;
    const adapter = new ScriptedAdapter({
      dreamer: (taskId) => {
        dreamerCallCount++;
        if (dreamerCallCount === 1) {
          // First call: return a payload that will cause the runner to mark
          // the task as retried. We simulate this by throwing — the base
          // runner catches errors and may mark as retried.
          throw new Error('transient LLM error');
        }
        return dreamerOut(taskId, 'pain-retry-001');
      },
      philosopher: philosopherOut,
      scribe: scribeOut,
      artificer: artificerV2,
      evaluator: evaluatorApproved,
    });
    const capability: CodeRuleCapability = { enabled: true, artificerAdapter: adapter };

    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-retry-001', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      maxStageRetries: 2,
      codeRuleCapability: capability,
      behaviorExamplePack: PIPE_PACK,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    // The retry contract is exact: one transient failure, one fresh successful
    // attempt, then the full pipeline succeeds.
    const dreamerStage = result.stages.find((s) => s.name === 'dreamer');
    expect(dreamerCallCount).toBe(2);
    expect(dreamerStage?.status).toBe('succeeded');
    expect(result.decision).toBe('candidate_ready_for_owner_review');
    // Owner Decision Experience v1 Phase A: this seed carries NO candidateId,
    // so the chain cannot bind a ledger principle (candidate_unresolved). The
    // rule artifact is produced and preserved, but the governance publication
    // boundary REFUSES to create an Owner approval subject for it.
    expect(result.approvalId).toBeNull();
    expect(result.degradationReason ?? '').toContain('identity_binding_unverified');
    expect(result.degradationReason ?? '').toContain('candidate_unresolved');
    expect(result.ruleArtifactId).not.toBeNull();
  }, 60_000);

  // ── Test 9 (E fix): retried status exhausted → stage marked 'degraded' ──
  it('retried status exhausted marks stage as degraded, not failed (E fix)', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-exhaust-001', 'pain-exhaust-001');
    await sm.close();

    // Adapter that always throws on dreamer — simulating persistent transient
    // errors. The runner will mark the task as retried each time until
    // maxStageRetries is exhausted.
    const adapter = new ScriptedAdapter({
      dreamer: () => { throw new Error('persistent transient error'); },
      philosopher: philosopherOut,
      scribe: scribeOut,
      artificer: artificerV2,
      evaluator: evaluatorApproved,
    });

    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-exhaust-001', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      maxStageRetries: 1, // Only 1 retry to keep the test fast
    });

    // Pipeline must reject — dreamer never succeeded.
    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('dreamer_failed');
    // The stage must be precisely degraded after the initial attempt + one retry.
    const dreamerStage = result.stages.find((s) => s.name === 'dreamer');
    expect(adapter.startRunCalls.filter((call) => call.taskId === 'dreamer-exhaust-001')).toHaveLength(2);
    expect(dreamerStage?.status).toBe('degraded');
    // The reason must be present (Runtime Contract Rule 9: no silent degradation).
    expect(dreamerStage?.reason).toBeTruthy();
  }, 60_000);
});

// ── PRI-714 (review fix #3): language wiring ─────────────────────────────────
//
// The PR's original fault class was "the parameter exists but is not wired".
// These regressions drive the REAL pipeline and assert the LANGUAGE DIRECTIVE
// on the actual systemPrompt handed to adapter.startRun (PRI-633: the
// instruction left the payload for the system channel):
//   - explicit `principles.outputLanguage: 'en'` in the workspace config
//     overrides the zh-CN default;
//   - no config → the zh-CN default applies.
// Deleting the pipeline's language resolution makes these fail.

function writeLanguageConfig(dir: string, outputLanguage?: 'en'): void {
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  // Full valid-config shape (mirrors pd-config-loader.test.ts) so validation
  // keeps `principles` intact instead of degrading to defaults.
  const config: Record<string, unknown> = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      correction_observer: { category: 'quiet', enabled: false },
      gfi: { category: 'quiet', enabled: false },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'openclaw.default' },
        dreamer: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
        philosopher: { enabled: false },
        evaluator: { enabled: false },
        rolloutReviewer: { enabled: false },
        correctionObserver: { enabled: false },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };
  if (outputLanguage !== undefined) config.principles = { outputLanguage };
  // JSON is valid YAML — same trick the shared executor tests use.
  fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), JSON.stringify(config));
}

function collectStartRunInputs(adapter: ScriptedAdapter): Array<{ taskId: string; outputSchemaRef?: string; payload: string; systemPrompt?: string }> {
  const inputs: Array<{ taskId: string; outputSchemaRef?: string; payload: string; systemPrompt?: string }> = [];
  for (const input of adapter.startRunInputs.values()) {
    inputs.push({
      taskId: input.taskRef.taskId,
      outputSchemaRef: input.outputSchemaRef,
      payload: typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload),
      systemPrompt: input.systemPrompt,
    });
  }
  return inputs;
}

describe('runRuleHostPipeline — outputLanguage reaches adapter.startRun messages (PRI-714 review fix)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } tmpDir = ''; }
  });

  it('explicit principles.outputLanguage=en overrides the zh-CN default on stage messages', async () => {
    tmpDir = makeTmpDir();
    writeLanguageConfig(tmpDir, 'en');
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-lang-en-001', 'pain-lang-en');
    await sm.close();

    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-lang-en', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      codeRuleCapability: { enabled: true, artificerAdapter: adapter },
      behaviorExamplePack: PIPE_PACK,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });
    expect(result.decision, JSON.stringify(result)).toBe('candidate_ready_for_owner_review');

    const inputs = collectStartRunInputs(adapter);
    // Dreamer: dreamer-subject field list, English directive on the system channel.
    const dreamer = inputs.find((i) => i.taskId.startsWith('dreamer'));
    expect(dreamer).toBeDefined();
    expect(dreamer?.systemPrompt).toContain('LANGUAGE DIRECTIVE');
    expect(dreamer?.systemPrompt).toContain('English');
    expect(dreamer?.systemPrompt).toContain('(candidates[].badDecision, candidates[].betterDecision, candidates[].rationale, candidates[].strategicPerspective)');
    expect(dreamer?.payload).toContain('dreamer-lang-en-001');
    expect(dreamer?.payload).not.toContain('LANGUAGE DIRECTIVE');
    // Philosopher: philosopher-subject field list, English directive.
    const philosopher = inputs.find((i) => i.taskId.includes('philosopher'));
    expect(philosopher).toBeDefined();
    expect(philosopher?.systemPrompt).toContain('LANGUAGE DIRECTIVE');
    expect(philosopher?.systemPrompt).toContain('English');
    expect(philosopher?.systemPrompt).toContain('(thesis, principleCandidate.title, principleCandidate.rationale, principleCandidate.scope, risks[])');
    // Evaluator: review-subject explicit nested paths + PRI-630 ledger echo rule.
    const evaluator = inputs.find((i) => i.outputSchemaRef === 'evaluator-output-v1');
    expect(evaluator).toBeDefined();
    expect(evaluator?.systemPrompt).toContain('LANGUAGE DIRECTIVE');
    expect(evaluator?.systemPrompt).toContain('English');
    expect(evaluator?.systemPrompt).toContain('codeReview.traceCoverage.gaps');
    expect(evaluator?.systemPrompt).toContain('adversarialCases[].rationale');
    expect(evaluator?.systemPrompt).toContain('requirementLedger[].statement MUST be copied verbatim');
    // The explicit en must have fully replaced the zh-CN default everywhere.
    for (const i of inputs) {
      expect(i.systemPrompt ?? '', 'Simplified Chinese leaked into an en-configured pipeline').not.toContain('Simplified Chinese');
      expect(i.payload, 'Simplified Chinese leaked into an en-configured pipeline').not.toContain('Simplified Chinese');
    }
  }, 60_000);

  it('no config file resolves the zh-CN default on the dreamer message', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-lang-zh-001', 'pain-lang-zh');
    await sm.close();

    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-lang-zh', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      codeRuleCapability: { enabled: true, artificerAdapter: adapter },
      behaviorExamplePack: PIPE_PACK,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });
    expect(result.decision, JSON.stringify(result)).toBe('candidate_ready_for_owner_review');

    const inputs = collectStartRunInputs(adapter);
    const dreamer = inputs.find((i) => i.taskId.startsWith('dreamer'));
    expect(dreamer).toBeDefined();
    expect(dreamer?.systemPrompt).toContain('LANGUAGE DIRECTIVE');
    expect(dreamer?.systemPrompt).toContain('Simplified Chinese');
    expect(dreamer?.payload).toContain('dreamer-lang-zh-001');
  }, 60_000);
});

// ── Owner Decision Experience v1 Phase A — identity fix-forward (SPEC §9) ────
//
// §9.4 deterministic acceptance slice, exercised against the REAL production
// path (real RuntimeStateManager, real SQLite, real ledger adapter):
//   success / ledger missing / ambiguous / conflict / write failure / replay.
// Failure slices must prove: NO approval enqueue, NO activation, NO duplicate
// ledger — while the generated artifacts stay preserved for later replay.

describe('runRuleHostPipeline — Phase A governance publication boundary (identity fix-forward)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } tmpDir = ''; }
  });

  function seedLedger(dir: string, id: string, candidateId: string): void {
    addPrincipleToLedger(path.join(dir, '.state'), {
      id, version: 1, text: `principle ${id}`, triggerPattern: '', action: '',
      status: 'candidate', evaluability: 'weak_heuristic', priority: 'P1', scope: 'general',
      valueScore: 0, adherenceRate: 0, painPreventedCount: 0, derivedFromPainIds: [candidateId],
      ruleIds: [], conflictsWithPrincipleIds: [], createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    });
  }

  async function countApprovalsForArtifact(dir: string, artifactId: string): Promise<number> {
    const verify = new RuntimeStateManager({ workspaceDir: dir });
    await verify.initialize();
    try {
      const rows = verify.connection.getDb()
        .prepare('SELECT COUNT(*) AS n FROM approvals WHERE artifact_id = ?').all(artifactId);
      const first = rows[0] as { n: number } | undefined;
      return first?.n ?? 0;
    } finally {
      await verify.close();
    }
  }

  async function countActivations(dir: string): Promise<number> {
    const verify = new RuntimeStateManager({ workspaceDir: dir });
    await verify.initialize();
    try {
      const rows = verify.connection.getDb().prepare('SELECT COUNT(*) AS n FROM activations').all();
      const first = rows[0] as { n: number } | undefined;
      return first?.n ?? 0;
    } finally {
      await verify.close();
    }
  }

  async function ledgerPrincipleCount(dir: string): Promise<number> {
    const ledgerPath = path.join(dir, '.state', 'principle_training_state.json');
    if (!fs.existsSync(ledgerPath)) return 0; // no ledger file yet = zero principles
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as { _tree?: { principles?: Record<string, unknown> } };
    return Object.keys(parsed._tree?.principles ?? {}).length;
  }

  it('ledger_missing: rule artifact preserved, but NO approval subject, NO activation, ledger untouched', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-id-missing', 'pain-id-missing', 'code_tool_hook', 'cand-no-ledger');
    await sm.close();
    // Deliberately NO ledger principle for cand-no-ledger.

    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-id-missing', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      codeRuleCapability: { enabled: true, artificerAdapter: adapter },
      behaviorExamplePack: PIPE_PACK,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.decision, JSON.stringify(result)).toBe('candidate_ready_for_owner_review');
    // The generation chain produced and PRESERVED its artifacts…
    expect(result.ruleArtifactId).not.toBeNull();
    // …but the publication boundary refused to create an Owner approval subject.
    expect(result.approvalId).toBeNull();
    expect(result.degradationReason ?? '').toContain('identity_binding_unverified');
    expect(result.degradationReason ?? '').toContain('ledger_missing');
    expect(await countApprovalsForArtifact(tmpDir, result.ruleArtifactId!)).toBe(0);
    expect(await countActivations(tmpDir)).toBe(0);
    expect(await ledgerPrincipleCount(tmpDir)).toBe(0);
  }, 60_000);

  it('ledger_ambiguous: two ledger targets for one candidate refuse publication and refuse a silent first-match binding', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-id-ambiguous', 'pain-id-ambiguous', 'code_tool_hook', 'cand-ambiguous');
    await sm.close();
    seedLedger(tmpDir, 'ledger-A', 'cand-ambiguous');
    seedLedger(tmpDir, 'ledger-B', 'cand-ambiguous');

    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-id-ambiguous', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      codeRuleCapability: { enabled: true, artificerAdapter: adapter },
      behaviorExamplePack: PIPE_PACK,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.decision).toBe('candidate_ready_for_owner_review');
    expect(result.approvalId).toBeNull();
    expect(result.degradationReason ?? '').toContain('ledger_ambiguous');
    expect(await countApprovalsForArtifact(tmpDir, result.ruleArtifactId!)).toBe(0);
    // The scribe artifact must NOT be silently bound to the first match.
    const verify = new RuntimeStateManager({ workspaceDir: tmpDir });
    await verify.initialize();
    try {
      const scribeTaskId = result.stages.find((s) => s.name === 'scribe')!.taskId!;
      const scribeArt = (await verify.piArtifactStore.listBySourceTaskId(scribeTaskId)).find((a) => a.artifactKind === 'principle');
      expect(scribeArt?.sourcePrincipleId).toBeUndefined();
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('identity_conflict: an existing binding to a different ledger target is never overwritten (§9.1.7)', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-id-conflict', 'pain-id-conflict', 'code_tool_hook', 'cand-conflict');
    await sm.close();
    seedLedger(tmpDir, 'ledger-original', 'cand-conflict');

    const adapter = makeAdapter();
    const first = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-id-conflict', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      codeRuleCapability: { enabled: true, artificerAdapter: adapter },
      behaviorExamplePack: PIPE_PACK,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });
    expect(first.approvalId).not.toBeNull();

    // Repoint the candidate: detach it from the original principle so the
    // chain now resolves to a DIFFERENT (still unique) target. Otherwise the
    // plural lookup would correctly report ledger_ambiguous, not a conflict.
    updatePrinciple(path.join(tmpDir, '.state'), 'ledger-original', { derivedFromPainIds: [] });
    seedLedger(tmpDir, 'ledger-replacement', 'cand-conflict');
    const verify = new RuntimeStateManager({ workspaceDir: tmpDir });
    await verify.initialize();
    try {
      const scribeTaskId = first.stages.find((s) => s.name === 'scribe')!.taskId!;
      const binding = await backfillScribeIdentity({
        stateManager: verify,
        artifactStore: verify.piArtifactStore,
        scribeTaskId,
        dreamerTaskId: 'dreamer-id-conflict',
        workspaceDir: tmpDir,
        now: new Date().toISOString(),
      });
      expect(binding).toEqual({ status: 'identity_conflict', existingPrincipleId: 'ledger-original', resolvedPrincipleId: 'ledger-replacement' });
      const scribeArt = (await verify.piArtifactStore.listBySourceTaskId(scribeTaskId)).find((a) => a.artifactKind === 'principle');
      expect(scribeArt?.sourcePrincipleId).toBe('ledger-original');
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('binding_write_failed / binding_readback_failed: store failures are structured, never silently accepted', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-id-wf', 'pain-id-wf', 'code_tool_hook', 'cand-wf');
    await sm.close();
    seedLedger(tmpDir, 'ledger-wf', 'cand-wf');

    // Run once through the real path so a REAL scribe artifact exists.
    const adapter = makeAdapter();
    const run = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-id-wf', runtimeAdapter: adapter,
      channel: 'prompt', pollIntervalMs: 5, timeoutMs: 1000,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });
    expect(run.decision).toBe('text_principle_only');

    const verify = new RuntimeStateManager({ workspaceDir: tmpDir });
    await verify.initialize();
    const scribeTaskId = run.stages.find((s) => s.name === 'scribe')!.taskId!;
    try {
      // The real run already bound + verified — replay must be idempotent.
      const idempotent = await backfillScribeIdentity({
        stateManager: verify, artifactStore: verify.piArtifactStore, scribeTaskId,
        dreamerTaskId: 'dreamer-id-wf', workspaceDir: tmpDir, now: new Date().toISOString(),
      });
      expect(idempotent).toEqual({ status: 'already_bound', principleId: 'ledger-wf' });

      // Write failure: upsert throws.
      const throwingStore = new Proxy(verify.piArtifactStore, {
        get(target, prop, receiver) {
          if (prop === 'upsertArtifact') {
            return async () => { throw new Error('sqlite locked (simulated)'); };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      // For the write-failure slice we need an UNBOUND artifact: use a second,
      // unbound scribe-shaped artifact created directly in the store.
      const taskId2 = 'scribe-unbound-task';
      await verify.createTask({ taskId: taskId2, taskKind: 'scribe', status: 'succeeded', attemptCount: 0, maxAttempts: 3, diagnosticJson: JSON.stringify({ pi_metadata: { channel: 'prompt', dependencyTaskIds: [], timeoutMs: 1000 } }) });
      await verify.piArtifactStore.createArtifact({
        artifactId: 'pi-art-unbound-1', artifactKind: 'principle', sourceTaskId: taskId2,
        lineageArtifactIds: [], validationStatus: 'pending', contentJson: '{}',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      const failed = await backfillScribeIdentity({
        stateManager: verify, artifactStore: throwingStore, scribeTaskId: taskId2,
        dreamerTaskId: 'dreamer-id-wf', workspaceDir: tmpDir, now: new Date().toISOString(),
      });
      expect(failed.status).toBe('binding_write_failed');

      // Read-back failure: upsert "succeeds" but the store returns a row without
      // the binding (write lost / wrong row).
      const staleStore = new Proxy(verify.piArtifactStore, {
        get(target, prop, receiver) {
          if (prop === 'getArtifactById') {
            return async () => null;
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const stale = await backfillScribeIdentity({
        stateManager: verify, artifactStore: staleStore, scribeTaskId: taskId2,
        dreamerTaskId: 'dreamer-id-wf', workspaceDir: tmpDir, now: new Date().toISOString(),
      });
      expect(stale.status).toBe('binding_readback_failed');
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('text path: unverified binding preserves the principle artifact but creates NO approval (candidate_unresolved)', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    // No candidateId on the seed — candidate_unresolved.
    await seedDreamerWithId(sm, 'dreamer-text-noid', 'pain-text-noid', 'prompt');
    await sm.close();

    const adapter = makeAdapter();
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-text-noid', runtimeAdapter: adapter,
      channel: 'prompt', pollIntervalMs: 5, timeoutMs: 1000,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.decision).toBe('text_principle_only');
    expect(result.principleArtifactId).not.toBeNull();
    expect(result.approvalId).toBeNull();
    expect(result.degradationReason ?? '').toContain('identity_binding_unverified');
    expect(result.degradationReason ?? '').toContain('candidate_unresolved');
    expect(await countApprovalsForArtifact(tmpDir, result.principleArtifactId!)).toBe(0);
    // The artifact is still marked validated — preserved, publishable later.
    const verify = new RuntimeStateManager({ workspaceDir: tmpDir });
    await verify.initialize();
    try {
      const artifact = await verify.piArtifactStore.getArtifactById(result.principleArtifactId!);
      expect(artifact?.validationStatus).toBe('validated');
      expect(artifact?.sourcePrincipleId).toBeUndefined();
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('replay after identity repair publishes: seed ledger mid-flight is unnecessary — repair-then-rerun enqueues (§9.1.8)', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-repair', 'pain-repair', 'prompt', 'cand-repair');
    await sm.close();

    const adapter1 = makeAdapter();
    const refused = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-repair', runtimeAdapter: adapter1,
      channel: 'prompt', pollIntervalMs: 5, timeoutMs: 1000,
      onStoreReady: (store) => { adapter1.artifactStore = store; },
    });
    expect(refused.approvalId).toBeNull();

    // Identity repair: the ledger entry for the candidate appears (e.g. intake
    // completed or the ledger was restored). Replay publishes.
    seedLedger(tmpDir, 'ledger-repaired', 'cand-repair');
    const adapter2 = makeAdapter();
    // Run 2 RESUMES run 1's succeeded dreamer seed (no new dreamer startRun) —
    // pre-register that call so the scripted philosopher can resolve its
    // sourceDreamerArtifactId lineage from the shared store.
    adapter2.startRunCalls.push({ taskId: 'dreamer-repair' });
    const published = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-repair', runtimeAdapter: adapter2,
      channel: 'prompt', pollIntervalMs: 5, timeoutMs: 1000,
      onStoreReady: (store) => { adapter2.artifactStore = store; },
    });
    expect(published.approvalId, JSON.stringify(published, null, 1)).not.toBeNull();
    expect(published.principleArtifactId).not.toBe(refused.principleArtifactId);
    // Exactly one ledger principle exists — the pipeline never creates one.
    expect(await ledgerPrincipleCount(tmpDir)).toBe(1);
  }, 60_000);
});
