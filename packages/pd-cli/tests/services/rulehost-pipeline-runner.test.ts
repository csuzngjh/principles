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
import { runRuleHostPipeline } from '../../src/services/rulehost-pipeline-runner.js';
import type { CodeRuleCapability } from '../../src/services/rulehost-pipeline-runner.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus, PIArtifactStore, RuntimeCapabilities, RuntimeHealth, RuntimeArtifactRef, ContextItem, StructuredRunOutput, StartRunInput } from '@principles/core/runtime-v2';
import { RuntimeStateManager, createPITaskDiagnosticJson } from '@principles/core/runtime-v2';
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

function artificerV2(taskId: string, priorId?: string): unknown {
  return {
    taskId, sourceScribeArtifactId: requireLineage(priorId, 'sourceScribeArtifactId'),
    implementationPlan: { summary: 'Block /etc writes', targetSurface: 'rule-host', changes: ['matcher'], tests: ['unit'], rolloutNotes: ['shadow'], confidence: 0.85 },
    implementationCode: 'function evaluate(input, helpers) { const p = String(input?.action?.paramsSummary?.path ?? input?.action?.normalizedPath ?? ""); if (p.startsWith("/etc")) return { decision: "block", matched: true, reason: "system path" }; const ctx = input?.context; if (ctx && ctx.facts && ctx.facts.priorReadOfTarget === "no") { return { decision: "block", matched: true, reason: "no prior read" }; } return { decision: "allow", matched: false, reason: "ok" }; }',
    implementationSummary: 'Block system path writes',
    goldenTraceCases: [
      { caseId: 'pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/project/f.txt' }, expectedDecision: 'allow' },
      { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
    ],
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
  const dir = path.join(os.tmpdir(), `pd-pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
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
): Promise<void> {
  const baseMetadata = JSON.parse(createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel, timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [],
  })) as Record<string, unknown>;
  const diagnosticJson = JSON.stringify({ ...baseMetadata, sourcePainId: painId });
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
  it('capability ON + evaluator approved → candidate_ready_for_owner_review', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-seeded-001', 'pain-test-001');
    await sm.close();

    const adapter = makeAdapter();
    const capability: CodeRuleCapability = { enabled: true, artificerAdapter: adapter };
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-test-001', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      codeRuleCapability: capability,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    expect(result.decision, JSON.stringify(result)).toBe('candidate_ready_for_owner_review');
    expect(result.stages.map((s) => s.name)).toEqual(['pain_lookup', 'dreamer', 'philosopher', 'scribe', 'adversarial_loop']);
    expect(result.ruleArtifactId).not.toBeNull();
    // P1 #1 fix: candidate should be auto-enqueued into the ApprovalQueue
    expect(result.approvalId).not.toBeNull();
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
    // P1 #1 fix: candidate should be auto-enqueued into the ApprovalQueue
    expect(result.approvalId).not.toBeNull();
  }, 60_000);

  // ── Test 2: Capability OFF (explicitly disabled) → text_principle_only ──
  it('capability OFF (explicitly disabled) → text_principle_only', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-seeded-002', 'pain-test-001');
    await sm.close();

    const adapter = makeAdapter();
    const capability: CodeRuleCapability = { enabled: false, disabledReason: 'artificer agent disabled in config' };
    const result = await runRuleHostPipeline({
      workspaceDir: tmpDir, painId: 'pain-test-001', runtimeAdapter: adapter,
      channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000,
      codeRuleCapability: capability,
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
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    // The retry contract is exact: one transient failure, one fresh successful
    // attempt, then the full pipeline succeeds.
    const dreamerStage = result.stages.find((s) => s.name === 'dreamer');
    expect(dreamerCallCount).toBe(2);
    expect(dreamerStage?.status).toBe('succeeded');
    expect(result.decision).toBe('candidate_ready_for_owner_review');
    // P1 #1 fix: candidate should be auto-enqueued into the ApprovalQueue
    expect(result.approvalId).not.toBeNull();
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
