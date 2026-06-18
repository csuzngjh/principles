/**
 * runRuleHostPipeline unit tests (PRI-429).
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/class-methods-use-this, @typescript-eslint/require-await */
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runRuleHostPipeline } from '../../src/services/rulehost-pipeline-runner.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus, PIArtifactStore } from '@principles/core/runtime-v2';
import { RuntimeStateManager, createPITaskDiagnosticJson } from '@principles/core/runtime-v2';

const PAIN_ID = 'pain-test-001';

type StageFactory = (taskId: string, priorArtifactId?: string) => unknown;
type EvaluatorFactory = (taskId: string, artificerArtifactId: string) => unknown;

class ScriptedAdapter implements PDRuntimeAdapter {
  readonly startRunCalls: { taskId: string }[] = [];
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

  async startRun(input: { taskRef: { taskId: string } }): Promise<RunHandle> {
    this.startRunCalls.push({ taskId: input.taskRef.taskId });
    return { runId: `run-${input.taskRef.taskId}`, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  }
  async pollRun(): Promise<RunStatus> { return { status: 'succeeded', runId: 'run-x' }; }
  async fetchOutput(runId: string): Promise<{ payload: unknown }> {
    const taskId = runId.replace(/^run-/, '');
    const kind = this.kindFor(taskId);
    if (kind === 'dreamer') return { payload: this.factories.dreamer(taskId) };
    if (kind === 'philosopher') return { payload: this.factories.philosopher(taskId, await this.priorArtifactId('dreamer')) };
    if (kind === 'scribe') return { payload: this.factories.scribe(taskId, await this.priorArtifactId('philosopher')) };
    if (kind === 'artificer') return { payload: this.factories.artificer(taskId, await this.priorArtifactId('scribe')) };
    return { payload: this.factories.evaluator(taskId, (await this.priorArtifactId('artificer'))!) };
  }
  async cancelRun(): Promise<void> { /* noop */ }
  kind(): 'test-double' { return 'test-double'; }
}

const dreamerOut = (taskId: string) => ({
  valid: true, taskId,
  candidates: [{ candidateIndex: 0, badDecision: 'Wrote to /etc/passwd', betterDecision: 'Block system path writes', rationale: 'OS damage risk', confidence: 0.85, riskLevel: 'low' as const, strategicPerspective: 'safety' }],
  sourcePainId: PAIN_ID, contextRefs: [], generatedAt: new Date().toISOString(),
});

const philosopherOut = (taskId: string, priorId?: string) => ({
  taskId, sourceDreamerArtifactId: priorId ?? 'fallback',
  thesis: 'System path writes must be blocked',
  principleCandidate: { title: 'Block system path writes', rationale: 'OS corruption risk', scope: 'write ops', confidence: 0.9 },
  risks: [], generatedAt: new Date().toISOString(),
});

const scribeOut = (taskId: string, priorId?: string) => ({
  taskId, sourcePhilosopherArtifactId: priorId ?? 'fallback',
  principleDraft: { title: 'Block system path writes', statement: 'Writes to /etc, /boot, /sys must be blocked.', rationale: 'OS corruption risk', applicability: ['write_file'], antiPatterns: ['Hardcoded allow'], confidence: 0.9 },
  sourceTrace: { philosopherArtifactId: priorId ?? 'fallback' },
  risks: [], generatedAt: new Date().toISOString(),
});

const artificerV2 = (taskId: string, priorId?: string) => ({
  taskId, sourceScribeArtifactId: priorId ?? 'fallback',
  implementationPlan: { summary: 'Block /etc writes', targetSurface: 'rule-host', changes: ['matcher'], tests: ['unit'], rolloutNotes: ['shadow'], confidence: 0.85 },
  implementationCode: 'function evaluate(input, helpers) { const p = String(input?.action?.paramsSummary?.path ?? input?.action?.normalizedPath ?? ""); return p.startsWith("/etc") ? { decision: "block", matched: true, reason: "system path" } : { decision: "allow", matched: false, reason: "ok" }; }',
  goldenTraceCases: [
    { caseId: 'pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/project/f.txt' }, expectedDecision: 'allow' },
    { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
  ],
  affectedTools: ['write_file'],
  sourceTrace: { scribeArtifactId: priorId ?? 'fallback' },
  risks: [], generatedAt: new Date().toISOString(),
});

const evaluatorApproved = (taskId: string, artificerArtifactId: string) => ({
  taskId, sourceArtificerArtifactId: artificerArtifactId,
  evaluation: { decision: 'approved', summary: 'approved', score: 0.9, strengths: [], concerns: [], requiredChanges: [] },
  sourceTrace: { artificerArtifactId },
  risks: [], generatedAt: new Date().toISOString(),
  codeReview: { intentConsistency: { aligned: true, explanation: 'ok' }, scopePrecision: { verdict: 'precise' as const, explanation: 'ok' }, traceCoverage: { sufficient: true, gaps: [], explanation: 'ok' } },
  adversarialCases: [{ caseId: 'adv-1', attackType: 'boundary' as const, toolName: 'write_file', params: { path: '/etc/shadow' }, expectedDecision: 'block' as const, rationale: 'system path' }],
  adversarialResult: { passed: true, failedCases: [] },
});

let tmpDir = '';

async function seedDreamer(sm: RuntimeStateManager, painId: string): Promise<string> {
  const taskId = `dreamer-seeded-${painId}-${Date.now().toString(36)}`;
  await sm.createTask({ taskId, taskKind: 'dreamer', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds: [], channel: 'prompt', timeoutMs: 1000, inputArtifactRefs: [], outputArtifactRefs: [] }) });
  return taskId;
}

describe('runRuleHostPipeline (PRI-429)', () => {
  afterEach(() => { if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } tmpDir = ''; } });

  it('full happy path: pain to adversarial loop to approved rule artifact', async () => {
    tmpDir = path.join(os.tmpdir(), `pd-pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
    await sm.initialize();
    await seedDreamer(sm, PAIN_ID);
    await sm.close();
    const adapter = new ScriptedAdapter({ dreamer: dreamerOut, philosopher: philosopherOut, scribe: scribeOut, artificer: artificerV2, evaluator: evaluatorApproved });
    const result = await runRuleHostPipeline({ workspaceDir: tmpDir, painId: PAIN_ID, runtimeAdapter: adapter, channel: 'code_tool_hook', pollIntervalMs: 5, timeoutMs: 1000, onStoreReady: (store) => { adapter.artifactStore = store; } });
    expect(result.decision).toBe('approved');
    expect(result.stages.map((s) => s.name)).toEqual(['pain_lookup', 'dreamer', 'philosopher', 'scribe', 'adversarial_loop']);
    expect(result.ruleArtifactId).not.toBeNull();
  }, 60_000);

  it('rejects when no dreamer task is seeded for the pain', async () => {
    tmpDir = path.join(os.tmpdir(), `pd-pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const adapter = new ScriptedAdapter({ dreamer: dreamerOut, philosopher: philosopherOut, scribe: scribeOut, artificer: artificerV2, evaluator: evaluatorApproved });
    const result = await runRuleHostPipeline({ workspaceDir: tmpDir, painId: 'pain-nonexistent', runtimeAdapter: adapter, pollIntervalMs: 5, timeoutMs: 1000 });
    expect(result.decision).toBe('rejected');
    expect(result.degradationReason).toContain('no_dreamer_task_seeded');
    expect(result.stages[0]!.name).toBe('pain_lookup');
    expect(result.stages[0]!.status).toBe('failed');
  });
});
