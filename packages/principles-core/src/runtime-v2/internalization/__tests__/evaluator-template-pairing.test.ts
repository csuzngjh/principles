import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EvaluatorRunner } from '../evaluator-runner.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import { createProductionGateDeps } from '../../activation/production-gate-deps.js';
import { buildToolSemanticRegistry } from '../tool-semantic-registry.js';
import type { GoldenTraceCase } from '../../golden-trace.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';
import type { ArtificerHostSemanticContext } from '../artificer-prompt-builder.js';

const ARTIFICER = 'pairing-artificer';
const EVALUATOR = 'pairing-evaluator';
const ARTIFACT = 'pairing-artifact';
const HOST: ArtificerHostSemanticContext = {
  hostKinds: ['openclaw'], tools: [{ rawToolName: 'write', canonicalKind: 'write' }],
};
const registryBuild = buildToolSemanticRegistry(HOST.tools);
if (!registryBuild.ok) throw new Error('pairing registry must build');
const {registry} = registryBuild;
const RULE = 'function evaluate(input) { if (input.action.normalizedPath === "/etc/passwd") return { decision: "block", matched: true, reason: "risk" }; if (input.action.canonicalKind === "write" && input.context && input.context.history.status === "available" && !input.context.history.truncated && input.context.facts.priorReadOfTarget === "no") return { decision: "block", matched: true, reason: "read first" }; return { decision: "allow", matched: false, reason: "safe" }; }';
let workspaceDir: string;
let state: RuntimeStateManager;
let artifactConnection: SqliteConnection;
let emitter: StoreEventEmitter;
let events: { eventType: string; payload: Record<string, unknown> }[];

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-template-pairing-'));
  state = new RuntimeStateManager({ workspaceDir });
  await state.initialize();
  artifactConnection = new SqliteConnection(workspaceDir);
  emitter = new StoreEventEmitter();
  events = [];
  emitter.onTelemetry((event) => events.push({ eventType: event.eventType, payload: event.payload }));
});
afterEach(async () => {
  await state.close();
  artifactConnection.close();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

function positive(caseId: string, toolName: string, params: Record<string, unknown>): GoldenTraceCase {
  return { caseId, kind: 'positive', toolName, params, expectedDecision: 'allow' };
}

async function run(options: {
  positives: GoldenTraceCase[];
  affectedTool?: string;
  decision?: 'approved' | 'needs_revision';
  auxiliary?: boolean;
  implementationCode?: string;
}) {
  for (const [taskId, taskKind, dependencyTaskIds] of [
    [ARTIFICER, 'artificer', []], [EVALUATOR, 'evaluator', [ARTIFICER]],
  ] satisfies [string, string, string[]][]) {
    await state.createTask({ taskId, taskKind, status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({ dependencyTaskIds, channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }) });
  }
  await state.acquireLease({ taskId: ARTIFICER, owner: 'pairing', runtimeKind: 'test-double' });
  await state.markTaskSucceeded(ARTIFICER);
  const store = new SqlitePIArtifactStore(artifactConnection);
  await store.upsertArtifact({ artifactId: ARTIFACT, artifactKind: 'principle', sourceTaskId: ARTIFICER,
    lineageArtifactIds: [], validationStatus: 'validated', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    contentJson: JSON.stringify({ implementationCode: options.implementationCode ?? RULE, affectedTools: [options.affectedTool ?? 'edit_file'],
      goldenTraceCases: [{ caseId: 'negative-risk', kind: 'negative', toolName: 'edit_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' }, ...options.positives] }),
  });
  const decision = options.decision ?? 'approved';
  const payload = {
    taskId: EVALUATOR, sourceArtificerArtifactId: ARTIFACT,
    evaluation: { decision, summary: 'pairing', score: 0.9, strengths: [], concerns: [], requiredChanges: decision === 'needs_revision' ? ['revise'] : [] },
    sourceTrace: { artificerArtifactId: ARTIFACT }, risks: [], generatedAt: new Date().toISOString(),
    ...(options.auxiliary ? { adversarialCases: [{ caseId: 'llm-risk', attackType: 'boundary', toolName: 'edit_file', params: { path: '/etc/passwd' }, expectedDecision: 'block', rationale: 'risk' }], adversarialResult: { passed: true, failedCases: [] } } : {}),
  };
  const adapter: PDRuntimeAdapter = {
    kind: () => 'test-double',
    getCapabilities: async () => { throw new Error('not used by runner'); },
    healthCheck: async () => { throw new Error('not used by runner'); },
    startRun: async () => ({ runId: 'pairing-run', runtimeKind: 'test-double', startedAt: new Date().toISOString() }),
    pollRun: async () => ({ status: 'succeeded', runId: 'pairing-run' }),
    fetchOutput: async () => ({ runId: 'pairing-run', payload }),
    fetchArtifacts: async () => [], cancelRun: async () => undefined,
  };
  const traces: GoldenTraceCase[][] = [];
  const production = createProductionGateDeps({ projectDir: workspaceDir, toolSemantics: registry });
  const repair: { diagnosticReplay?: unknown }[] = [];
  const runner = new EvaluatorRunner({ stateManager: state, runtimeAdapter: adapter, eventEmitter: emitter,
    artifactStore: store, validator: new DefaultEvaluatorValidator(), isRepairLoopEnabled: () => true,
    seedArtificerRepairTask: async (params) => { repair.push(params.repairPayload); return 'pairing-repair'; },
  }, { owner: 'pairing', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 20_000,
    ...(options.auxiliary ? { hostSemanticContext: HOST } : {}),
    gateDeps: { evaluateInSandbox: (code, trace) => { traces.push([...trace.cases]); return production.evaluateInSandbox(code, trace); } },
  });
  const result = await runner.run(EVALUATOR);
  const artifacts = await store.listBySourceTaskId(EVALUATOR);
  const principle = artifacts.find((artifact) => artifact.artifactKind === 'principle');
  if (!principle) throw new Error('evaluator artifact missing');
  const content: unknown = JSON.parse(principle.contentJson);
  return { result, traces, repair, artifacts, principle, content, task: await state.getTask(EVALUATOR) };
}

describe('B1: derive write templates from one complete positive example', () => {
  it('skips a first ls positive and takes tool name and path from the write example', async () => {
    const outcome = await run({ positives: [positive('ls-first', 'ls', { path: '/wrong/read-path' }), positive('write-second', 'write', { file_path: '/workspace/right.ts' })] });
    expect(outcome.result.status).toBe('succeeded');
    expect(outcome.traces).toHaveLength(1);
    const templates = outcome.traces[0]?.filter((item) => item.caseId.startsWith('v2-'));
    expect(templates).toHaveLength(5);
    expect(templates?.find((item) => item.caseId === 'v2-unavailable')).toMatchObject({ toolName: 'write', params: { path: '/workspace/right.ts' } });
    expect(templates?.find((item) => item.caseId === 'v2-path-boundary')).toMatchObject({ toolName: 'write', params: { path: '/workspace/right.ts.bak' } });
  });
  it('keeps scanning after a write example with no usable path', async () => {
    const outcome = await run({ positives: [positive('empty-write', 'edit_file', { path: ' ', file_path: 7 }), positive('complete-write', 'write', { path: '/workspace/later.ts' })] });
    expect(outcome.traces).toHaveLength(1);
    expect(outcome.traces[0]?.find((item) => item.caseId === 'v2-unavailable')).toMatchObject({ toolName: 'write', params: { path: '/workspace/later.ts' } });
    expect(outcome.result.status).toBe('succeeded');
  });
  for (const [name, positives, reason] of [
    ['only ls examples', [positive('ls', 'ls', { path: '/workspace/read' })], 'no_write_kind_positive_case_for_v2_adversarial_cases'],
    ['write examples without paths', [positive('empty-write', 'write', {})], 'paired_positive_case_has_no_path_param'],
  ] satisfies [string, GoldenTraceCase[], string][]) {
    for (const auxiliary of [false, true]) {
      it(`${name}: fails before gate even when alias and LLM cases are ${auxiliary ? 'present' : 'absent'}`, async () => {
        const outcome = await run({ positives, auxiliary });
        expect(outcome.result.status).toBe('failed');
        expect(outcome.task?.status).toBe('failed');
        expect(outcome.task?.lastError).toBe('input_invalid');
        expect(outcome.traces).toHaveLength(0);
        expect(events.some((event) => event.eventType === 'evaluator_adversarial_replay')).toBe(false);
        expect(events.some((event) => event.eventType === 'evaluator_host_alias_case_skipped')).toBe(false);
        expect(outcome.content).not.toHaveProperty('adversarialResult');
        expect(outcome.artifacts.filter((artifact) => artifact.artifactKind === 'rule')).toHaveLength(0);
        expect(outcome.principle.validationStatus).toBe('pending');
        expect(events).toContainEqual(expect.objectContaining({ eventType: 'evaluator_adversarial_replay_skipped', payload: expect.objectContaining({ reason, nextAction: expect.any(String) }) }));
        expect(outcome.result.failureReason).toContain(`template_derivation_failed:${reason}`);
        expect(outcome.result.failureReason).not.toContain('supply LLM adversarialCases');
      });
    }
  }
  it('needs_revision completes evaluation but cannot gain replay evidence or promotion from auxiliary cases', async () => {
    const outcome = await run({ positives: [positive('ls', 'ls', { path: '/workspace/read' })], decision: 'needs_revision', auxiliary: true });
    expect(outcome.result.status).toBe('succeeded');
    expect(outcome.task?.status).toBe('succeeded');
    expect(outcome.content).toHaveProperty('evaluation.decision', 'needs_revision');
    expect(outcome.content).not.toHaveProperty('adversarialResult');
    expect(outcome.traces).toHaveLength(0);
    expect(outcome.repair).toHaveLength(1);
    expect(outcome.repair[0]?.diagnosticReplay).toBeUndefined();
    expect(outcome.principle.validationStatus).toBe('pending');
    expect(outcome.artifacts.filter((artifact) => artifact.artifactKind === 'rule')).toHaveLength(0);
  });
  it('non-write target retains the custom-case replay path', async () => {
    const outcome = await run({ positives: [positive('ls', 'ls', { path: '/workspace/read' })], affectedTool: 'ls', auxiliary: true });
    expect(outcome.traces).toHaveLength(1);
    expect(outcome.traces[0]?.filter((item) => item.caseId.startsWith('v2-') && item.caseId !== 'v2-host-alias')).toHaveLength(0);
    expect(outcome.content).toHaveProperty('adversarialResult.passed', true);
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'evaluator_v2_adversarial_cases_skipped', payload: expect.objectContaining({ reason: 'non_write_canonical_kind_for_v2_adversarial_cases' }) }));
  });
  it('preserves the path-boundary failure for a rule that permits unread writes', async () => {
    const outcome = await run({ positives: [positive('write', 'write', { path: '/workspace/right.ts' })],
      implementationCode: 'function evaluate(input) { return input.action.normalizedPath === "/etc/passwd" ? { decision: "block", matched: true, reason: "risk" } : { decision: "allow", matched: false, reason: "allow" }; }' });
    expect(outcome.traces[0]?.filter((item) => item.caseId.startsWith('v2-'))).toHaveLength(5);
    expect(outcome.content).toHaveProperty('adversarialResult.passed', false);
    expect(outcome.content).toHaveProperty('adversarialResult.failedCases', expect.arrayContaining([expect.objectContaining({ caseId: 'v2-path-boundary', expectedDecision: 'block', actualDecision: 'allow' })]));
  });
});
