/**
 * Cross-Package Acceptance Test — PRI-408 (P1/P2 fixes)
 *
 * UNSPLIPPABLE end-to-end test crossing pd-cli + principles-core packages:
 *   pain → RuleHost pipeline → candidate → auto-enqueue (P1 #1)
 *   → Owner edit approval (P1 #2) → Owner approve → dispatch with approval binding (P1 #3)
 *   → activation observable → deactivate → behavior restored
 *   → include-deactivated shows the record (P2 #5)
 *
 * Uses real SQLite stores, real pipeline runner, real approval queue, real
 * activation dispatcher. The only scripted part is the LLM stage outputs
 * (dreamer/philosopher/scribe/artificer/evaluator) — same pattern as the
 * existing pipeline runner tests.
 *
 * This test exists because the original story-a-acceptance.test.ts started
 * from a pre-built principle artifact and only checked that activation
 * records existed. It did NOT exercise:
 * - The pipeline → auto-enqueue chain (P1 #1)
 * - The edit entry point (P1 #2)
 * - The approval binding security boundary (P1 #3)
 * - The include-deactivated query (P2 #5)
 *
 * ERR checklist:
 * - ERR-001: All pipeline output treated as unknown, validated at runtime
 * - ERR-002: Every failure path carries reason + nextAction
 * - ERR-004/008: Lineage fields from same source, mismatch tested
 * - ERR-009: Required fields fail loud
 * - ERR-025: Production-path test, not demo helper
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  runRuleHostPipeline,
  createSandboxGateDeps,
} from '../../src/services/rulehost-pipeline-runner.js';
import { RuleHost } from '../../../openclaw-plugin/src/core/rule-host.js';
import { OPENCLAW_TOOL_SEMANTIC_MAPPINGS } from '../../../openclaw-plugin/src/constants/tool-semantics.js';
import { saveHostToolDeclaration } from '@principles/host-runtime';
import type { CodeRuleCapability } from '../../src/services/rulehost-pipeline-runner.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus, PIArtifactStore, RuntimeCapabilities, RuntimeHealth, RuntimeArtifactRef, ContextItem, StructuredRunOutput, StartRunInput } from '@principles/core/runtime-v2';
import {
  RuntimeStateManager,
  SqliteApprovalQueueStore,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
  ActivationDispatcher,
  ApprovalCompletionService,
  PromptWriter,
  DeferArchiveWriter,
  RuleHostWriter,
  createProductionGateDeps,
  makeIdempotencyKey,
  createPITaskDiagnosticJson,
} from '@principles/core/runtime-v2';
import type { PIArtifactSnapshot, RuleHostInput } from '@principles/core/runtime-v2';

// ── Scripted adapter (same pattern as rulehost-pipeline-runner.test.ts) ──────

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

function requireLineage(id: string | undefined, field: string): string {
  if (!id) throw new Error(`missing required lineage field: ${field}`);
  return id;
}

// ── Scripted LLM stage outputs ───────────────────────────────────────────────

function dreamerOut(taskId: string, painId: string): unknown {
  return {
    valid: true, taskId,
    candidates: [{ candidateIndex: 0, badDecision: 'Wrote to /etc/passwd', betterDecision: 'Block system path writes', rationale: 'OS damage risk', confidence: 0.85, riskLevel: 'low' as const, strategicPerspective: 'safety' }],
    sourcePainId: painId, contextRefs: [], generatedAt: new Date().toISOString(),
  };
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

// ── Test workspace helpers ───────────────────────────────────────────────────

let tmpDir = '';

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `pd-xpkg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  // PRI-661: the pipeline's evaluator replay resolves the production gate
  // context from durable workspace provenance. Seed the declaration the real
  // OpenClaw host would persist on startup (same mapping constants), so the
  // generation-time replay and the activation gate see the same registry.
  saveHostToolDeclaration(dir, {
    version: 1,
    hostKind: 'openclaw',
    mappings: OPENCLAW_TOOL_SEMANTIC_MAPPINGS,
    declaredAt: new Date().toISOString(),
  });
  return dir;
}

async function seedDreamerWithId(sm: RuntimeStateManager, taskId: string, painId: string): Promise<void> {
  const baseMetadata = JSON.parse(createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'code_tool_hook', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [],
  })) as Record<string, unknown>;
  const diagnosticJson = JSON.stringify({ ...baseMetadata, sourcePainId: painId });
  await sm.createTask({ taskId, taskKind: 'dreamer', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson });
}

function makeAdapter(): ScriptedAdapter {
  return new ScriptedAdapter({
    dreamer: (taskId) => dreamerOut(taskId, 'pain-xpkg-001'),
    philosopher: philosopherOut,
    scribe: scribeOut,
    artificer: artificerV2,
    evaluator: evaluatorApproved,
  });
}

// ── Cross-Package Acceptance Test ────────────────────────────────────────────

describe('Cross-Package Acceptance Test (PRI-408 P1/P2 fixes) — unsplippable chain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tmpDir = '';
    }
  });

  it('pain → pipeline → auto-enqueue → edit → approve → activate → observe → deactivate → restore', async () => {
    // ── Step 1: Set up workspace and seed pain signal ──────────────────────
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-xpkg-001', 'pain-xpkg-001');
    await sm.close();

    // ── Step 2: Run RuleHost pipeline → candidate + auto-enqueue (P1 #1) ───
    const adapter = makeAdapter();
    const capability: CodeRuleCapability = { enabled: true, artificerAdapter: adapter };
    const pipelineResult = await runRuleHostPipeline({
      workspaceDir: tmpDir,
      painId: 'pain-xpkg-001',
      runtimeAdapter: adapter,
      channel: 'code_tool_hook',
      pollIntervalMs: 5,
      timeoutMs: 5000,
      codeRuleCapability: capability,
      onStoreReady: (store) => { adapter.artifactStore = store; },
    });

    // Verify pipeline produced a candidate
    expect(pipelineResult.decision, JSON.stringify(pipelineResult)).toBe('candidate_ready_for_owner_review');
    expect(pipelineResult.ruleArtifactId).not.toBeNull();
    const originalArtifactId = pipelineResult.ruleArtifactId!;

    // P1 #1 fix: candidate must be auto-enqueued into the ApprovalQueue
    expect(pipelineResult.approvalId).not.toBeNull();
    const approvalId = pipelineResult.approvalId!;

    // ── Step 3: Verify the approval is in the queue with pending status ────
    const sm2 = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm2.initialize();
    const approvalStore = new SqliteApprovalQueueStore(sm2.connection);
    const stateStore = new SqliteActivationStateStore(sm2.connection);
    const artifactStore = new SqlitePIArtifactStore(sm2.connection);

    const approvalRecord = await approvalStore.getById(approvalId);
    expect(approvalRecord).not.toBeNull();
    expect(approvalRecord!.status).toBe('pending');
    expect(approvalRecord!.artifactId).toBe(originalArtifactId);
    expect(approvalRecord!.channel).toBe('code_tool_hook');

    // ── Step 4: Owner edits the approval to swap to a revised artifact (P1 #2)
    // Create a revised artifact (simulating owner revision of the rule code)
    const revisedArtifactId = 'art-rule-revised-001';
    const originalArtifact = await artifactStore.getArtifactById(originalArtifactId);
    expect(originalArtifact).not.toBeNull();

    // Store the revised artifact
    const revisedContentJson = JSON.stringify({
      ...JSON.parse(originalArtifact!.contentJson),
      implementationCode: 'function evaluate(input, helpers) { const p = String(input?.action?.paramsSummary?.path ?? input?.action?.normalizedPath ?? ""); return (p.startsWith("/etc") || p.startsWith("/boot")) ? { decision: "block", matched: true, reason: "system path blocked (revised)" } : { decision: "allow", matched: false, reason: "ok" }; }',
      revisionNote: 'Owner expanded coverage to include /boot path',
    });
    await artifactStore.upsertArtifact({
      artifactId: revisedArtifactId,
      artifactKind: 'rule',
      sourceTaskId: originalArtifact!.sourceTaskId,
      sourcePrincipleId: originalArtifact!.sourcePrincipleId,
      sourceRuleId: originalArtifact!.sourceRuleId,
      lineageArtifactIds: [originalArtifactId],
      validationStatus: 'validated',
      contentJson: revisedContentJson,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Edit the approval to swap to the revised artifact
    const editResult = await approvalStore.edit({
      approvalId,
      editedBy: 'owner-001',
      newArtifactId: revisedArtifactId,
      editReason: 'Expanded /boot path coverage after review',
      now: new Date().toISOString(),
    });
    expect(editResult.ok).toBe(true);
    if (editResult.ok) {
      expect(editResult.record.artifactId).toBe(revisedArtifactId);
      expect(editResult.record.previousArtifactId).toBe(originalArtifactId);
      expect(editResult.record.editedBy).toBe('owner-001');
    }

    // ── Step 5: Owner approves the edited approval ─────────────────────────
    const approveResult = await approvalStore.approve(approvalId, 'owner-001', 'Approved after edit');
    expect(approveResult.ok).toBe(true);

    // ── Step 6: Dispatch activation with approval binding (P1 #3) ──────────
    const revisedArtifact = await artifactStore.getArtifactById(revisedArtifactId);
    expect(revisedArtifact).not.toBeNull();
    const revisedSnapshot: PIArtifactSnapshot = {
      artifactId: revisedArtifact!.artifactId,
      artifactKind: revisedArtifact!.artifactKind,
      sourceTaskId: revisedArtifact!.sourceTaskId,
      sourcePrincipleId: revisedArtifact!.sourcePrincipleId,
      sourceRuleId: revisedArtifact!.sourceRuleId,
      lineageArtifactIds: revisedArtifact!.lineageArtifactIds,
      validationStatus: revisedArtifact!.validationStatus,
      contentJson: revisedArtifact!.contentJson,
      createdAt: revisedArtifact!.createdAt,
      updatedAt: revisedArtifact!.updatedAt,
    };

    const artifactReadModel = {
      getArtifactById: async (id: string): Promise<PIArtifactSnapshot | null> => {
        if (id === revisedArtifactId) return revisedSnapshot;
        const rec = await artifactStore.getArtifactById(id);
        return rec ? {
          artifactId: rec.artifactId,
          artifactKind: rec.artifactKind,
          sourceTaskId: rec.sourceTaskId,
          sourcePrincipleId: rec.sourcePrincipleId,
          sourceRuleId: rec.sourceRuleId,
          lineageArtifactIds: rec.lineageArtifactIds,
          validationStatus: rec.validationStatus,
          contentJson: rec.contentJson,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
        } : null;
      },
    };

    const dispatcher = new ActivationDispatcher(
      artifactReadModel,
      stateStore,
      {
        writers: [
          new PromptWriter(),
          new RuleHostWriter({ gateDeps: createProductionGateDeps() }),
          new DeferArchiveWriter(),
        ],
        approvalQueueStore: approvalStore,
      },
    );

    const completionService = new ApprovalCompletionService(
      approvalStore,
      dispatcher,
      stateStore,
    );

    const completionResult = await completionService.completeApproval({
      approvalId,
      actor: { kind: 'human', userId: 'owner-001' },
      now: new Date().toISOString(),
    });

    expect(completionResult.ok).toBe(true);
    if (completionResult.ok) {
      expect(completionResult.decision.decision).toBe('activated');
      expect(completionResult.activationId).toBeDefined();
    }

    // ── Step 7: Verify activation is observable ────────────────────────────
    const idempotencyKey = makeIdempotencyKey(revisedArtifactId, 'code_tool_hook');
    const activationRecord = await stateStore.getActivationStatus(idempotencyKey);
    expect(activationRecord).not.toBeNull();
    expect(activationRecord!.artifactId).toBe(revisedArtifactId);
    expect(activationRecord!.channel).toBe('code_tool_hook');
    expect(activationRecord!.deactivatedAt).toBeNull();
    // PRI-489: Owner approval creates a SHADOW activation first (not live).
    // Shadow activations are observation-only — they record would-block into
    // shadowDecisions but never actually block the tool call. The only
    // shadow -> live transition requires the Owner decision service.
    expect(activationRecord!.action).toBe('code_tool_hook_shadow_activate');

    // Verify via listCodeToolHookActivations (P2 #5: default excludes deactivated)
    const activeActivations = await stateStore.listCodeToolHookActivations();
    const ourActivation = activeActivations.find(a => a.artifactId === revisedArtifactId);
    expect(ourActivation).toBeDefined();
    expect(ourActivation!.deactivatedAt).toBeNull();
    expect(ourActivation!.action).toBe('code_tool_hook_shadow_activate');

    // ── Step 7a: Verify shadow activation does NOT block (PRI-489) ────────
    // Shadow mode is observation-only. The RuleHost loads the activation but
    // records shadowDecisions instead of blocking. evaluate() must return
    // undefined (no block) for shadow activations, even for /etc/passwd.
    const makeRuleHostInput = (targetPath: string): RuleHostInput => ({
      action: { toolName: 'write_file', normalizedPath: targetPath, paramsSummary: { path: targetPath } },
      workspace: { isRiskPath: targetPath.startsWith('/etc') },
      session: { currentGfi: 0 },
      evolution: { epTier: 0 },
      derived: { estimatedLineChanges: 1, bashRisk: 'safe' },
    });
    const shadowRuleHost = new RuleHost(
      path.join(tmpDir, '.state'),
      { warn: () => {} },
      { workspaceDir: tmpDir },
    );
    try {
      const report = shadowRuleHost.evaluateDetailed(makeRuleHostInput('/etc/passwd'));
      expect(report.liveDecision).toBeUndefined();
      expect(report.shadowDecisions).toContainEqual(
        expect.objectContaining({ activationId: activationRecord!.activationId }),
      );
    } finally {
      shadowRuleHost.dispose();
    }

    // ── Step 7b: Promote shadow → live (PRI-489) ──────────────────────────
    // This lower-level store call verifies the persistence transition only;
    // production callers must enter through RuleCodeOwnerDecisionService.
    const activationId = activationRecord!.activationId;
    const promoteResult = await stateStore.promoteActivation(activationId, new Date().toISOString());
    expect(promoteResult).toBe(true);

    // Verify the action is now live
    const liveActivationRecord = await stateStore.getActivationStatus(idempotencyKey);
    expect(liveActivationRecord).not.toBeNull();
    expect(liveActivationRecord!.action).toBe('code_tool_hook_live_activate');
    expect(liveActivationRecord!.promotedAt).not.toBeNull();

    // ── Step 7c: Verify the rule actually blocks in live mode (P1 #4) ────
    // The production RuleHost gate loads all active rules, compiles their code,
    // and calls evaluate() on each tool call. This step simulates that:
    // 1. Load active rules from the activation state store
    // 2. Compile the rule code in the production vm sandbox
    // 3. Call evaluate() with system-path and normal-path inputs
    // 4. Verify the rule blocks system paths and allows normal paths
    const ruleHost = new RuleHost(
      path.join(tmpDir, '.state'),
      { warn: () => {} },
      { workspaceDir: tmpDir },
    );
    const blockResult = ruleHost.evaluate(makeRuleHostInput('/etc/passwd'));
    expect(blockResult).toBeDefined();
    expect(blockResult.decision).toBe('block');
    expect(blockResult.matched).toBe(true);
    expect(ruleHost.evaluate(makeRuleHostInput('/project/src/main.ts'))).toBeUndefined();

    // ── Step 8: Owner deactivates (rollback) ───────────────────────────────
    const deactivateResult = await stateStore.deactivateActivation(activationId, new Date().toISOString());
    expect(deactivateResult).toBe(true);

    // ── Step 9: Verify behavior is restored (P1 #4: gate-level verification) ─
    // After deactivation, the RuleHost gate loads active rules — our rule is
    // no longer in the active list, so the gate would NOT evaluate it. The
    // default behavior (no rules matching) is 'allow'. This proves behavior
    // reverts after rollback, not just that the DB record changed.
    const activeAfterDeactivate = await stateStore.listCodeToolHookActivations();
    const stillActive = activeAfterDeactivate.find(a => a.artifactId === revisedArtifactId);
    expect(stillActive).toBeUndefined();

    // Simulate the gate: no active rules → default decision is 'allow' for all inputs
    // (The gate iterates active rules; with zero active rules, no rule can block.)
    const gateActiveRules = activeAfterDeactivate.filter(a => a.deactivatedAt === null);
    expect(gateActiveRules).toHaveLength(0);
    const ruleHostAfterRollback = new RuleHost(
      path.join(tmpDir, '.state'),
      { warn: () => {} },
      { workspaceDir: tmpDir },
    );
    expect(ruleHostAfterRollback.evaluate(makeRuleHostInput('/etc/passwd'))).toBeUndefined();

    // P2 #5 fix: with includeDeactivated=true, the record IS returned
    const allAfterDeactivate = await stateStore.listCodeToolHookActivations(true);
    const deactivatedRecord = allAfterDeactivate.find(a => a.artifactId === revisedArtifactId);
    expect(deactivatedRecord).toBeDefined();
    expect(deactivatedRecord!.deactivatedAt).not.toBeNull();

    // ── Step 10: Verify getActivationStatus reflects deactivation (Bug-Q) ─
    // Bug-Q fix: getActivationStatus now filters out deactivated records
    // (WHERE deactivated_at IS NULL), returning null when no active activation
    // exists. This allows re-activation after deactivation. The deactivated
    // record itself is already verified via listCodeToolHookActivations(true)
    // above (L459-462, Step 9). Here we verify the new null semantics.
    const activationAfterDeactivate = await stateStore.getActivationStatus(idempotencyKey);
    expect(activationAfterDeactivate).toBeNull();

    await sm2.close();
  }, 60_000);

  it('P1 #3: dispatch with approved but no approvalId is refused', async () => {
    // This test verifies the approval binding security boundary (P1 #3).
    // A caller cannot bypass owner approval by passing rolloutDecision='approved'
    // without a verified approvalId.

    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();

    const approvalStore = new SqliteApprovalQueueStore(sm.connection);
    const stateStore = new SqliteActivationStateStore(sm.connection);
    const artifactStore = new SqlitePIArtifactStore(sm.connection);

    // Create a test artifact
    const artifactId = 'art-test-001';
    await artifactStore.upsertArtifact({
      artifactId,
      artifactKind: 'principle',
      sourceTaskId: 'task-test-001',
      sourcePrincipleId: 'P_test_001',
      sourceRuleId: undefined,
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: JSON.stringify({ text: 'Test principle', language: 'en' }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const artifact = await artifactStore.getArtifactById(artifactId);
    const artifactSnapshot: PIArtifactSnapshot = {
      artifactId: artifact!.artifactId,
      artifactKind: artifact!.artifactKind,
      sourceTaskId: artifact!.sourceTaskId,
      sourcePrincipleId: artifact!.sourcePrincipleId,
      sourceRuleId: artifact!.sourceRuleId,
      lineageArtifactIds: artifact!.lineageArtifactIds,
      validationStatus: artifact!.validationStatus,
      contentJson: artifact!.contentJson,
      createdAt: artifact!.createdAt,
      updatedAt: artifact!.updatedAt,
    };

    const artifactReadModel = {
      getArtifactById: async (id: string): Promise<PIArtifactSnapshot | null> => {
        return id === artifactId ? artifactSnapshot : null;
      },
    };

    const dispatcher = new ActivationDispatcher(
      artifactReadModel,
      stateStore,
      {
        writers: [new PromptWriter()],
        approvalQueueStore: approvalStore,
      },
    );

    // Attempt to dispatch with 'approved' but no approvalId — must be refused
    const result = await dispatcher.dispatch({
      artifactId,
      channel: 'prompt',
      rolloutDecision: 'approved',
      actor: { kind: 'system', source: 'attacker' },
      now: new Date().toISOString(),
      confirm: true,
      // approvalId intentionally omitted — this is the attack vector
    });

    expect(result.decision).toBe('refused');
    expect(result.reason).toContain('approval_id');

    // Verify no activation was created
    const idempotencyKey = makeIdempotencyKey(artifactId, 'prompt');
    const activationRecord = await stateStore.getActivationStatus(idempotencyKey);
    expect(activationRecord).toBeNull();

    await sm.close();
  }, 30_000);
});
