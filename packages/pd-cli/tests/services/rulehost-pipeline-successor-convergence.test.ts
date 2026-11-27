/**
 * PRI-1299 review fix (P1-1) — RuleHost logical-successor convergence.
 *
 * Real SQLite integration tests for the unified successor authority in
 * runRuleHostPipeline: philosopher/scribe creation goes through core
 * createLogicalSuccessorTask — identity (parentTaskId, taskKind, channel),
 * never the timestamp preferredTaskId shape.
 *
 * Matrix:
 *   - first execution creates philosopher/scribe with correct lineage metadata
 *   - same pain/parent/channel rerun does NOT duplicate logical successors
 *   - succeeded successor is reused without re-execution
 *   - pending / retry_wait successors continue under existing execution semantics
 *   - leased successor is never taken over by a second executor
 *   - failed successor is an explicit terminal failure (no silent re-execution)
 *   - needs_human_review successor is never bypassed automatically
 *   - malformed successor metadata fails closed (no creation, no execution)
 *   - multiple conflicting successors surface the integrity conflict explicitly
 *   - id occupancy by a foreign chain fails closed (no random-id bypass)
 *   - different parents / channels isolate independent logical successors
 *   - DB-level uniqueness invariant over (parentTaskId, taskKind, channel)
 *
 * Harness discipline mirrors rulehost-pipeline-runner.test.ts: real
 * RuntimeStateManager + real SQLite + scripted PDRuntimeAdapter double — no
 * mocks of private internals.
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runRuleHostPipeline } from '../../src/services/rulehost-pipeline-runner.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus, PIArtifactStore, RuntimeCapabilities, RuntimeHealth, RuntimeArtifactRef, ContextItem, StructuredRunOutput, StartRunInput } from '@principles/core/runtime';
import { RuntimeStateManager, createPITaskDiagnosticJson, hydratePITaskRecord, SqliteApprovalQueueStore } from '@principles/core/runtime';
import { saveHostToolDeclaration } from '@principles/host-runtime';
import { seedCandidateMaterial } from '../helpers/candidate-identity-fixture.js';

// ── Scripted adapter (same discipline as rulehost-pipeline-runner.test.ts) ────

type StageFactory = (taskId: string, priorArtifactId?: string) => unknown;

class ScriptedAdapter implements PDRuntimeAdapter {
  readonly startRunCalls: { taskId: string }[] = [];
  readonly startRunInputs = new Map<string, StartRunInput>();
  artifactStore: PIArtifactStore | null = null;
  constructor(private readonly factories: { dreamer: StageFactory; philosopher: StageFactory; scribe: StageFactory }) {}

  private kindFor(taskId: string): 'dreamer' | 'philosopher' | 'scribe' {
    if (taskId.startsWith('dreamer')) return 'dreamer';
    if (taskId.includes('philosopher')) return 'philosopher';
    return 'scribe';
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
    else payload = this.factories.scribe(taskId, await this.priorArtifactId('philosopher'));
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
    risks: [],
    intentContract: {
      ownerIntent: 'writes to system paths must not happen',
      targetBehavior: 'writes under /etc, /boot, /sys are blocked',
      forbiddenBehavior: 'writing system paths',
      evidenceSource: 'pain fixture',
      validationExpectation: 'rule blocks system-path writes and allows workspace writes',
    },
    executionConditions: { version: 1, requiredFacts: [] },
    generatedAt: new Date().toISOString(),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let tmpDir = '';

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pipe-succ-'));
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

function makeAdapter(painId: string): ScriptedAdapter {
  return new ScriptedAdapter({
    dreamer: (taskId) => dreamerOut(taskId, painId),
    philosopher: philosopherOut,
    scribe: scribeOut,
  });
}

/** Seed a dreamer task, mirroring seedDreamerWithId in rulehost-pipeline-runner.test.ts. */
async function seedDreamerWithId(
  sm: RuntimeStateManager,
  taskId: string,
  painId: string,
  channel: 'prompt' | 'code_tool_hook' | 'defer_archive' = 'code_tool_hook',
  candidateId?: string,
): Promise<void> {
  // Explicit candidate ids skip the probation-ledger write (same discipline as
  // the runner tests): tests add their own ledger entry and must not end up
  // with two principles claiming the same candidate.
  const explicitCandidate = candidateId !== undefined;
  candidateId ??= `candidate-${taskId}`;
  await seedCandidateMaterial(sm, candidateId, explicitCandidate ? undefined : tmpDir);
  const baseMetadata = JSON.parse(createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel, timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [],
  })) as Record<string, unknown>;
  const diagnosticJson = JSON.stringify({ ...baseMetadata, sourcePainId: painId, candidateId });
  await sm.createTask({ taskId, taskKind: 'dreamer', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson });
}

/**
 * Seed a logical-successor row directly (the state a prior run/ crash/repair
 * leaves behind). Well-formed rows go through the validated metadata writer;
 * the malformed variant carries the identity triple but drops required fields
 * so full hydration fails — the exact fail-closed input class successor-lookup
 * adjudicates.
 */
async function seedSuccessorTask(
  sm: RuntimeStateManager,
  opts: {
    readonly taskId: string;
    readonly taskKind: 'philosopher' | 'scribe';
    readonly parentTaskId: string;
    readonly channel: 'prompt' | 'code_tool_hook' | 'defer_archive';
    readonly status?: 'pending' | 'retry_wait' | 'failed' | 'needs_human_review' | 'succeeded';
    readonly malformed?: 'missing_required_fields';
  },
): Promise<void> {
  const diagnosticJson = opts.malformed === 'missing_required_fields'
    // Identity present (parentTaskId + channel inside pi_metadata) but no
    // dependencyTaskIds/timeoutMs — full PI hydration fails while the identity
    // still claims this logical successor. Valid JSON, insertable.
    ? JSON.stringify({ pi_metadata: { parentTaskId: opts.parentTaskId, channel: opts.channel } })
    : createPITaskDiagnosticJson({
        dependencyTaskIds: [opts.parentTaskId],
        channel: opts.channel,
        timeoutMs: 1000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        parentTaskId: opts.parentTaskId,
      });
  await sm.createTask({
    taskId: opts.taskId,
    taskKind: opts.taskKind,
    status: opts.status ?? 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson,
  });
}

/**
 * DB-level uniqueness invariant: at most one well-formed logical successor per
 * (parentTaskId, taskKind, channel) triple. This is the invariant the unified
 * successor authority exists to protect — asserted on the real SQLite rows.
 */
async function assertLogicalSuccessorUniqueness(sm: RuntimeStateManager): Promise<void> {
  const tasks = await sm.listTasks();
  const groups = new Map<string, string[]>();
  for (const task of tasks) {
    const pi = hydratePITaskRecord(task);
    if (!pi || !pi.parentTaskId) continue;
    const key = `${pi.parentTaskId}${pi.taskKind}${pi.channel}`;
    const ids = groups.get(key) ?? [];
    ids.push(task.taskId);
    groups.set(key, ids);
  }
  const violations = [...groups.entries()].filter(([, ids]) => ids.length > 1);
  expect(
    violations,
    `logical successor uniqueness violated: ${violations.map(([k, ids]) => `${k} -> [${ids.join(',')}]`).join('; ')}`,
  ).toEqual([]);
}

async function listTasksByKind(sm: RuntimeStateManager, kind: string): Promise<string[]> {
  const tasks = await sm.listTasks();
  return tasks.filter((t) => t.taskKind === kind).map((t) => t.taskId).sort();
}

async function openVerify(dir: string): Promise<RuntimeStateManager> {
  const verify = new RuntimeStateManager({ workspaceDir: dir });
  await verify.initialize();
  return verify;
}

function pipelineOpts(dir: string, painId: string, adapter: ScriptedAdapter, extra?: Record<string, unknown>) {
  return {
    workspaceDir: dir, painId, runtimeAdapter: adapter,
    channel: 'code_tool_hook' as const, pollIntervalMs: 5, timeoutMs: 1000,
    // Capability omitted → OFF: the chain ends text_principle_only after the
    // scribe, isolating the dreamer→philosopher→scribe spine these tests audit.
    onStoreReady: (store: PIArtifactStore) => { adapter.artifactStore = store; },
    ...extra,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runRuleHostPipeline — PRI-1299 logical-successor convergence (P1-1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } tmpDir = ''; }
  });

  it('first execution creates the philosopher and scribe successors with correct lineage metadata', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-first-001', 'pain-first-001', 'code_tool_hook');
    await sm.close();

    const adapter = makeAdapter('pain-first-001');
    const result = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-first-001', adapter));

    expect(result.decision).toBe('text_principle_only');
    const verify = await openVerify(tmpDir);
    try {
      const philosopherIds = await listTasksByKind(verify, 'philosopher');
      const scribeIds = await listTasksByKind(verify, 'scribe');
      expect(philosopherIds).toHaveLength(1);
      expect(scribeIds).toHaveLength(1);
      const philosopher = (await verify.getTask(philosopherIds[0]!))!;
      const scribe = (await verify.getTask(scribeIds[0]!))!;
      // Timestamp preferredTaskId shape preserved for real creations.
      expect(philosopher.taskId).toMatch(/^rulehost-pain-first-001-philosopher-[0-9a-z]+$/);
      expect(scribe.taskId).toMatch(/^rulehost-pain-first-001-scribe-[0-9a-z]+$/);
      // Lineage metadata: real parent chain + channel + dependency edge.
      const philosopherPi = hydratePITaskRecord(philosopher);
      const scribePi = hydratePITaskRecord(scribe);
      expect(philosopherPi?.parentTaskId).toBe('dreamer-first-001');
      expect(philosopherPi?.channel).toBe('code_tool_hook');
      expect(philosopherPi?.dependencyTaskIds).toEqual(['dreamer-first-001']);
      expect(scribePi?.parentTaskId).toBe(philosopher.taskId);
      expect(scribePi?.channel).toBe('code_tool_hook');
      expect(scribePi?.dependencyTaskIds).toEqual([philosopher.taskId]);
      expect(philosopher.status).toBe('succeeded');
      expect(scribe.status).toBe('succeeded');
      await assertLogicalSuccessorUniqueness(verify);
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('rerun with the same pain/parent/channel does not duplicate logical successors and re-executes nothing', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-rerun-001', 'pain-rerun-001', 'code_tool_hook');
    await sm.close();

    const adapter1 = makeAdapter('pain-rerun-001');
    const first = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-rerun-001', adapter1));
    expect(first.decision).toBe('text_principle_only');
    expect(first.approvalId).not.toBeNull();

    const verify1 = await openVerify(tmpDir);
    let firstPhilosopherId: string;
    let firstScribeId: string;
    try {
      [firstPhilosopherId] = await listTasksByKind(verify1, 'philosopher');
      [firstScribeId] = await listTasksByKind(verify1, 'scribe');
      expect(firstPhilosopherId).toBeTruthy();
      expect(firstScribeId).toBeTruthy();
    } finally {
      await verify1.close();
    }

    // Run 2: fresh adapter — any re-execution would show up in its call log.
    const adapter2 = makeAdapter('pain-rerun-001');
    const second = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-rerun-001', adapter2));

    // Zero LLM executions in the rerun: dreamer seed reuse (pre-existing
    // precedent) AND philosopher/scribe successor reuse (PRI-1299).
    expect(adapter2.startRunCalls, JSON.stringify(second)).toEqual([]);
    expect(second.decision).toBe('text_principle_only');
    const philosopherStage = second.stages.find((s) => s.name === 'philosopher');
    const scribeStage = second.stages.find((s) => s.name === 'scribe');
    expect(philosopherStage).toMatchObject({ status: 'succeeded', taskId: firstPhilosopherId });
    expect(philosopherStage?.reason).toContain('successor_reused_succeeded');
    expect(scribeStage).toMatchObject({ status: 'succeeded', taskId: firstScribeId });
    expect(scribeStage?.reason).toContain('successor_reused_succeeded');

    const verify2 = await openVerify(tmpDir);
    try {
      // Exactly one philosopher row and one scribe row — the logical identity
      // converged instead of duplicating under a fresh timestamp id.
      expect(await listTasksByKind(verify2, 'philosopher')).toEqual([firstPhilosopherId]);
      expect(await listTasksByKind(verify2, 'scribe')).toEqual([firstScribeId]);
      await assertLogicalSuccessorUniqueness(verify2);
      // No duplicate approval rows either (idempotent enqueue convergence).
      const approvalStore = new SqliteApprovalQueueStore(verify2.connection);
      const approvals = await approvalStore.getById(first.approvalId!);
      expect(approvals).not.toBeNull();
    } finally {
      await verify2.close();
    }
    // Same artifact identity across the replay — no rewritten history.
    expect(second.principleArtifactId).toBe(first.principleArtifactId);
    expect(second.approvalId).toBe(first.approvalId);
  }, 60_000);

  it('pending existing successor continues under existing execution semantics (executed, not duplicated)', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-pend-001', 'pain-pend-001', 'code_tool_hook');
    // A prior run crashed after creating the philosopher but before executing it.
    await seedSuccessorTask(sm, {
      taskId: 'philosopher-preexisting-pending', taskKind: 'philosopher',
      parentTaskId: 'dreamer-pend-001', channel: 'code_tool_hook', status: 'pending',
    });
    await sm.close();

    const adapter = makeAdapter('pain-pend-001');
    const result = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-pend-001', adapter));

    expect(result.decision, JSON.stringify(result)).toBe('text_principle_only');
    // The pre-seeded pending task was leased and executed — exactly once.
    expect(adapter.startRunCalls.filter((c) => c.taskId === 'philosopher-preexisting-pending')).toHaveLength(1);
    const philosopherStage = result.stages.find((s) => s.name === 'philosopher');
    expect(philosopherStage).toMatchObject({ status: 'succeeded', taskId: 'philosopher-preexisting-pending' });
    const verify = await openVerify(tmpDir);
    try {
      // No second philosopher row appeared next to the pre-seeded one.
      expect(await listTasksByKind(verify, 'philosopher')).toEqual(['philosopher-preexisting-pending']);
      expect((await verify.getTask('philosopher-preexisting-pending'))?.status).toBe('succeeded');
      // The scribe anchored on the RESOLVED pre-existing philosopher id.
      const [scribeId] = await listTasksByKind(verify, 'scribe');
      expect(hydratePITaskRecord((await verify.getTask(scribeId!))!)?.parentTaskId).toBe('philosopher-preexisting-pending');
      await assertLogicalSuccessorUniqueness(verify);
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('retry_wait existing successor is leased and executed (retry remains continuable)', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-rw-001', 'pain-rw-001', 'code_tool_hook');
    await seedSuccessorTask(sm, {
      taskId: 'philosopher-preexisting-retrywait', taskKind: 'philosopher',
      parentTaskId: 'dreamer-rw-001', channel: 'code_tool_hook', status: 'retry_wait',
    });
    await sm.close();

    const adapter = makeAdapter('pain-rw-001');
    const result = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-rw-001', adapter));

    expect(result.decision, JSON.stringify(result)).toBe('text_principle_only');
    expect(adapter.startRunCalls.filter((c) => c.taskId === 'philosopher-preexisting-retrywait')).toHaveLength(1);
    const verify = await openVerify(tmpDir);
    try {
      expect(await listTasksByKind(verify, 'philosopher')).toEqual(['philosopher-preexisting-retrywait']);
      expect((await verify.getTask('philosopher-preexisting-retrywait'))?.status).toBe('succeeded');
      await assertLogicalSuccessorUniqueness(verify);
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('leased successor is never taken over: no second executor starts and the lease stays intact', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-lease-001', 'pain-lease-001', 'code_tool_hook');
    await seedSuccessorTask(sm, {
      taskId: 'philosopher-preexisting-leased', taskKind: 'philosopher',
      parentTaskId: 'dreamer-lease-001', channel: 'code_tool_hook', status: 'pending',
    });
    // A foreign executor holds the lease (e.g. the lease-based consumer).
    await sm.acquireLease({ taskId: 'philosopher-preexisting-leased', owner: 'foreign-executor', durationMs: 60_000, runtimeKind: 'openclaw' });
    await sm.close();

    const adapter = makeAdapter('pain-lease-001');
    const result = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-lease-001', adapter));

    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('successor_leased_active');
    const philosopherStage = result.stages.find((s) => s.name === 'philosopher');
    expect(philosopherStage).toMatchObject({ status: 'degraded', taskId: 'philosopher-preexisting-leased' });
    expect(philosopherStage?.reason).toContain('successor_leased_active');
    // Exactly-once boundary: the pipeline never started a second executor.
    expect(adapter.startRunCalls.filter((c) => c.taskId === 'philosopher-preexisting-leased')).toHaveLength(0);
    // The chain stops before the scribe — no successor creation past the block.
    expect(adapter.startRunCalls.some((c) => c.taskId.includes('scribe'))).toBe(false);

    const verify = await openVerify(tmpDir);
    try {
      expect(await listTasksByKind(verify, 'philosopher')).toEqual(['philosopher-preexisting-leased']);
      const leased = (await verify.getTask('philosopher-preexisting-leased'))!;
      // The foreign lease is untouched — no steal, no status reset.
      expect(leased.status).toBe('leased');
      expect(leased.leaseOwner).toBe('foreign-executor');
      expect(await listTasksByKind(verify, 'scribe')).toEqual([]);
      await assertLogicalSuccessorUniqueness(verify);
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('failed successor surfaces an explicit terminal failure and is never re-executed', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-fail-001', 'pain-fail-001', 'code_tool_hook');
    await seedSuccessorTask(sm, {
      taskId: 'philosopher-preexisting-failed', taskKind: 'philosopher',
      parentTaskId: 'dreamer-fail-001', channel: 'code_tool_hook', status: 'failed',
    });
    await sm.close();

    const adapter = makeAdapter('pain-fail-001');
    const result = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-fail-001', adapter));

    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('successor_failed_terminal');
    const philosopherStage = result.stages.find((s) => s.name === 'philosopher');
    expect(philosopherStage).toMatchObject({ status: 'failed', taskId: 'philosopher-preexisting-failed' });
    expect(philosopherStage?.reason).toContain('successor_failed_terminal');
    // Terminal rows are not re-executed and not silently replaced.
    expect(adapter.startRunCalls.filter((c) => c.taskId === 'philosopher-preexisting-failed')).toHaveLength(0);
    const verify = await openVerify(tmpDir);
    try {
      expect(await listTasksByKind(verify, 'philosopher')).toEqual(['philosopher-preexisting-failed']);
      expect((await verify.getTask('philosopher-preexisting-failed'))?.status).toBe('failed');
      expect(await listTasksByKind(verify, 'scribe')).toEqual([]);
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('needs_human_review successor is never bypassed automatically', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-nhr-001', 'pain-nhr-001', 'code_tool_hook');
    await seedSuccessorTask(sm, {
      taskId: 'philosopher-preexisting-nhr', taskKind: 'philosopher',
      parentTaskId: 'dreamer-nhr-001', channel: 'code_tool_hook', status: 'needs_human_review',
    });
    await sm.close();

    const adapter = makeAdapter('pain-nhr-001');
    const result = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-nhr-001', adapter));

    // No automatic bypass: not re-executed, not treated as succeeded — the
    // chain stops with an explicit owner-attention reason.
    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('successor_needs_human_review');
    expect(result.decision).not.toBe('text_principle_only');
    const philosopherStage = result.stages.find((s) => s.name === 'philosopher');
    expect(philosopherStage).toMatchObject({ status: 'failed', taskId: 'philosopher-preexisting-nhr' });
    expect(adapter.startRunCalls.filter((c) => c.taskId === 'philosopher-preexisting-nhr')).toHaveLength(0);
    const verify = await openVerify(tmpDir);
    try {
      expect((await verify.getTask('philosopher-preexisting-nhr'))?.status).toBe('needs_human_review');
      expect(await listTasksByKind(verify, 'philosopher')).toEqual(['philosopher-preexisting-nhr']);
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('malformed successor metadata fails closed: no creation, no execution, structured reason', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-mal-001', 'pain-mal-001', 'code_tool_hook');
    await seedSuccessorTask(sm, {
      taskId: 'philosopher-malformed-row', taskKind: 'philosopher',
      parentTaskId: 'dreamer-mal-001', channel: 'code_tool_hook',
      malformed: 'missing_required_fields',
    });
    await sm.close();

    const adapter = makeAdapter('pain-mal-001');
    const result = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-mal-001', adapter));

    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('successor_metadata_malformed');
    const philosopherStage = result.stages.find((s) => s.name === 'philosopher');
    expect(philosopherStage?.status).toBe('failed');
    expect(philosopherStage?.reason).toContain('successor_metadata_malformed');
    expect(philosopherStage?.reason).toContain('philosopher-malformed-row');
    // Fail-closed: the malformed row is neither executed nor duplicated.
    expect(adapter.startRunCalls.filter((c) => c.taskId === 'philosopher-malformed-row')).toHaveLength(0);
    const verify = await openVerify(tmpDir);
    try {
      expect(await listTasksByKind(verify, 'philosopher')).toEqual(['philosopher-malformed-row']);
      expect(await listTasksByKind(verify, 'scribe')).toEqual([]);
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('multiple successors for one parent surface the integrity conflict explicitly', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-conf-001', 'pain-conf-001', 'code_tool_hook');
    // Historical corruption: two well-formed rows claiming the same logical identity.
    await seedSuccessorTask(sm, {
      taskId: 'philosopher-conflict-a', taskKind: 'philosopher',
      parentTaskId: 'dreamer-conf-001', channel: 'code_tool_hook', status: 'succeeded',
    });
    await seedSuccessorTask(sm, {
      taskId: 'philosopher-conflict-b', taskKind: 'philosopher',
      parentTaskId: 'dreamer-conf-001', channel: 'code_tool_hook', status: 'succeeded',
    });
    await sm.close();

    const adapter = makeAdapter('pain-conf-001');
    const result = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-conf-001', adapter));

    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('successor_integrity_conflict');
    const philosopherStage = result.stages.find((s) => s.name === 'philosopher');
    expect(philosopherStage?.status).toBe('failed');
    expect(philosopherStage?.reason).toContain('successor_integrity_conflict');
    expect(philosopherStage?.reason).toContain('philosopher-conflict-a');
    expect(philosopherStage?.reason).toContain('philosopher-conflict-b');
    // Neither conflicting row is picked silently; no third row appears.
    expect(adapter.startRunCalls.filter((c) => c.taskId.includes('philosopher'))).toHaveLength(0);
    const verify = await openVerify(tmpDir);
    try {
      expect(await listTasksByKind(verify, 'philosopher')).toEqual(['philosopher-conflict-a', 'philosopher-conflict-b']);
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('preferred id occupied by a foreign chain fails closed instead of bypassing uniqueness with a fresh random id', async () => {
    tmpDir = makeTmpDir();
    // Anchor the frozen clock at the REAL current time: the lease machinery
    // compares expiry ISO strings written from Date.now against real-wall-clock
    // `new Date()` reads — a timestamp far in the past/future would skew every
    // lease in the run. Anchoring at real now keeps the skew within the few
    // milliseconds the test itself takes, far inside the lease budget.
    const fixedNow = Date.now();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-idc-001', 'pain-idc-001', 'code_tool_hook');
    // Foreign occupant: valid PI metadata but parented on an unrelated chain —
    // it claims the exact timestamp id this run would prefer for its creation.
    const occupiedId = `rulehost-pain-idc-001-philosopher-${fixedNow.toString(36)}`;
    await seedSuccessorTask(sm, {
      taskId: occupiedId, taskKind: 'philosopher',
      parentTaskId: 'dreamer-someone-elses-chain', channel: 'code_tool_hook', status: 'pending',
    });
    await sm.close();

    // Freeze Date.now only AFTER the fixtures are seeded (seedCandidateMaterial
    // leases real tasks). The pipeline's preferredTaskId derives from Date.now,
    // so the creation attempt now collides with the foreign occupant above.
    // The wide timeoutMs keeps lease expiries comfortably ahead of the real
    // wall clock despite the frozen acquisition instant.
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const adapter = makeAdapter('pain-idc-001');
    const result = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-idc-001', adapter, { timeoutMs: 60_000 }));

    expect(result.decision).toBe('generation_rejected');
    expect(result.degradationReason).toContain('successor_id_conflict');
    const philosopherStage = result.stages.find((s) => s.name === 'philosopher');
    expect(philosopherStage?.status).toBe('failed');
    expect(philosopherStage?.reason).toContain('successor_id_conflict');
    // No execution, and no second philosopher row for OUR parent — uniqueness
    // is never bypassed by minting a different random id.
    expect(adapter.startRunCalls.filter((c) => c.taskId.includes('philosopher'))).toHaveLength(0);
    const verify = await openVerify(tmpDir);
    try {
      const all = await verify.listTasks();
      const ours = all.filter((t) => t.taskKind === 'philosopher' && hydratePITaskRecord(t)?.parentTaskId === 'dreamer-idc-001');
      expect(ours).toEqual([]);
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('different parents isolate independent logical successors (one per dreamer seed)', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-iso-a', 'pain-iso-a', 'code_tool_hook');
    await seedDreamerWithId(sm, 'dreamer-iso-b', 'pain-iso-b', 'code_tool_hook');
    await sm.close();

    const adapterA = makeAdapter('pain-iso-a');
    const resultA = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-iso-a', adapterA));
    // NOTE: the candidate fixture writes identical principle text for every
    // candidate, so the ledger dedup folds the second candidate's probation
    // entry onto the first — a downstream scribe-preflight concern that is
    // deliberately NOT what this test audits. The isolation invariant lives
    // at the philosopher successor level: each chain creates exactly one,
    // parented on its own dreamer seed.
    expect(resultA.stages.find((s) => s.name === 'philosopher')?.status).toBe('succeeded');
    const adapterB = makeAdapter('pain-iso-b');
    const resultB = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-iso-b', adapterB));
    expect(resultB.stages.find((s) => s.name === 'philosopher')?.status, JSON.stringify(resultB)).toBe('succeeded');

    const verify = await openVerify(tmpDir);
    try {
      const philosopherIds = await listTasksByKind(verify, 'philosopher');
      expect(philosopherIds).toHaveLength(2);
      const parents = await Promise.all(philosopherIds.map(async (id) => hydratePITaskRecord((await verify.getTask(id))!)?.parentTaskId));
      expect([...parents].sort()).toEqual(['dreamer-iso-a', 'dreamer-iso-b']);
      // Neither chain reused or interfered with the other's successor.
      const idA = resultA.stages.find((s) => s.name === 'philosopher')?.taskId;
      const idB = resultB.stages.find((s) => s.name === 'philosopher')?.taskId;
      expect(idA).toBeTruthy();
      expect(idB).toBeTruthy();
      expect(idA).not.toBe(idB);
      await assertLogicalSuccessorUniqueness(verify);
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('different channels isolate independent logical successors for the same parent', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    // Sole seed is on code_tool_hook; the prompt-channel run falls back to it
    // (same parent) but must NOT collide with the hook-channel successor.
    await seedDreamerWithId(sm, 'dreamer-iso-ch', 'pain-iso-ch', 'code_tool_hook');
    await sm.close();

    const adapterHook = makeAdapter('pain-iso-ch');
    const hookRun = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-iso-ch', adapterHook));
    expect(hookRun.decision).toBe('text_principle_only');

    const adapterPrompt = makeAdapter('pain-iso-ch');
    // The dreamer seed is already succeeded (run 1) — not re-executed — so the
    // scripted philosopher's sourceDreamerArtifactId lineage lookup would find
    // no dreamer call in this fresh adapter. Pre-register it (same technique as
    // the §9.1.8 replay test in rulehost-pipeline-runner.test.ts); the artifact
    // store resolves the REAL persisted dreamer artifact.
    adapterPrompt.startRunCalls.push({ taskId: 'dreamer-iso-ch' });
    const promptRun = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-iso-ch', adapterPrompt, { channel: 'prompt' }));
    expect(promptRun.decision).toBe('text_principle_only');
    // The prompt run is a DIFFERENT logical successor — it must execute, not reuse.
    expect(adapterPrompt.startRunCalls.some((c) => c.taskId.includes('philosopher'))).toBe(true);

    const verify = await openVerify(tmpDir);
    try {
      const philosopherIds = await listTasksByKind(verify, 'philosopher');
      expect(philosopherIds).toHaveLength(2);
      const channels = await Promise.all(philosopherIds.map(async (id) => hydratePITaskRecord((await verify.getTask(id))!)?.channel));
      expect([...channels].sort()).toEqual(['code_tool_hook', 'prompt']);
      // Both rows share the same parent but differ by channel — the identity
      // triple keeps them legitimately distinct.
      const parents = await Promise.all(philosopherIds.map(async (id) => hydratePITaskRecord((await verify.getTask(id))!)?.parentTaskId));
      expect(parents).toEqual(['dreamer-iso-ch', 'dreamer-iso-ch']);
      await assertLogicalSuccessorUniqueness(verify);
    } finally {
      await verify.close();
    }
  }, 60_000);

  it('rerun after a first-run philosopher failure converges on the same in-flight successor instead of duplicating it', async () => {
    tmpDir = makeTmpDir();
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamerWithId(sm, 'dreamer-crash-001', 'pain-crash-001', 'code_tool_hook');
    await sm.close();

    // Run 1: the philosopher adapter throws persistently — the task is created
    // (exactly once) and ends retry_wait/failed; the pipeline rejects.
    const failingAdapter = new ScriptedAdapter({
      dreamer: (taskId) => dreamerOut(taskId, 'pain-crash-001'),
      philosopher: () => { throw new Error('transient philosopher outage'); },
      scribe: scribeOut,
    });
    const first = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-crash-001', failingAdapter, { maxStageRetries: 0 }));
    expect(first.decision).toBe('generation_rejected');

    const verify1 = await openVerify(tmpDir);
    let crashedPhilosopherId: string;
    let crashedStatus: string;
    try {
      const ids = await listTasksByKind(verify1, 'philosopher');
      expect(ids).toHaveLength(1);
      [crashedPhilosopherId] = ids as [string];
      crashedStatus = (await verify1.getTask(crashedPhilosopherId))!.status;
    } finally {
      await verify1.close();
    }

    if (crashedStatus === 'failed') {
      // Terminal failure: the rerun surfaces the explicit failure — no
      // re-execution, no duplicate (failed is not a vehicle for new work).
      const adapter2 = makeAdapter('pain-crash-001');
      const second = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-crash-001', adapter2));
      expect(second.decision).toBe('generation_rejected');
      expect(second.degradationReason).toContain('successor_failed_terminal');
      expect(adapter2.startRunCalls.filter((c) => c.taskId === crashedPhilosopherId)).toHaveLength(0);
    } else {
      // retry_wait/pending: the rerun resumes the SAME in-flight successor and
      // drives it to success — still exactly one philosopher row.
      expect(crashedStatus).toBe('retry_wait');
      const adapter2 = makeAdapter('pain-crash-001');
      // Dreamer already succeeded in run 1 — pre-register its call so the
      // re-executed philosopher resolves the real persisted dreamer artifact.
      adapter2.startRunCalls.push({ taskId: 'dreamer-crash-001' });
      const second = await runRuleHostPipeline(pipelineOpts(tmpDir, 'pain-crash-001', adapter2));
      expect(second.decision, JSON.stringify(second)).toBe('text_principle_only');
      expect(adapter2.startRunCalls.filter((c) => c.taskId === crashedPhilosopherId)).toHaveLength(1);
      const philosopherStage = second.stages.find((s) => s.name === 'philosopher');
      expect(philosopherStage).toMatchObject({ status: 'succeeded', taskId: crashedPhilosopherId });
    }

    const verify2 = await openVerify(tmpDir);
    try {
      expect(await listTasksByKind(verify2, 'philosopher')).toEqual([crashedPhilosopherId]);
      await assertLogicalSuccessorUniqueness(verify2);
    } finally {
      await verify2.close();
    }
  }, 60_000);
});
