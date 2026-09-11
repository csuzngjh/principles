/**
 * PRI-741 — host-name parity replay test.
 *
 * The G3 failure class: a rule generated against the author's own tool-name
 * vocabulary (e.g. `edit_file`) passes replay while never firing in
 * production, because the real host dispatches different names (e.g. `write`)
 * for the same canonicalKind. The evaluator's host-alias variant case replays
 * the same action under a REAL host tool name (from the host semantic
 * projection — the same provenance as gateDeps) and demands the same
 * decision.
 *
 * Verified through the public runner surface with the REAL production
 * gateDeps (real vm sandbox + real registry resolution):
 *   1. the host-alias variant is cloned from the FIRST NEGATIVE case with the
 *      host's real tool name of the same canonicalKind;
 *   2. a canonicalKind-matching rule passes replay including the variant;
 *   3. (control) a toolName-equality rule FAILS the variant — the exact G3
 *      silent-no-trigger defect is caught at replay, not after activation;
 *   4. without hostSemanticContext the case is skipped OBSERVABLY (rc-9).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { buildToolSemanticRegistry } from '../tool-semantic-registry.js';
import type { ArtificerHostSemanticContext } from '../artificer-prompt-builder.js';
import type { AdversarialCase } from '../evaluator-output.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';

const HOST_MAPPINGS = [
  { rawToolName: 'write', canonicalKind: 'write' },
  { rawToolName: 'edit', canonicalKind: 'write' },
  { rawToolName: 'exec', canonicalKind: 'execute' },
] as const;
const HOST_SEMANTIC_CONTEXT: ArtificerHostSemanticContext = {
  hostKinds: ['openclaw'],
  tools: [...HOST_MAPPINGS],
};
// The SAME registry the production host threads into gateDeps (consumer cycle
// ports / workspace declaration) — replay must resolve canonicalKind
// identically to production, so the gateDeps below carry it too.
const HOST_REGISTRY_BUILT = buildToolSemanticRegistry([...HOST_MAPPINGS]);
if (!HOST_REGISTRY_BUILT.ok) throw new Error('test host registry failed to build');
const HOST_REGISTRY = HOST_REGISTRY_BUILT.registry;

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let emitter: StoreEventEmitter;
let emitted: { eventType: string; payload: Record<string, unknown> }[];
const ARTIFICER_ID = 'artificer-host-alias';
const EVAL_ID = 'evaluator-host-alias';
const ARTIFICER_ART = 'pi-art-artificer-host-alias';

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-host-alias-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  emitter = new StoreEventEmitter();
  emitted = [];
  emitter.onTelemetry((event) => {
    emitted.push({ eventType: event.eventType, payload: event.payload });
  });
});

afterEach(async () => {
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

function meta(o: Record<string, unknown> = {}): string {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
    inputArtifactRefs: [], outputArtifactRefs: [], ...o,
  });
}

async function mkTask(id: string, kind: string, deps: string[]): Promise<void> {
  await stateManager.createTask({ taskId: id, taskKind: kind, status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta({ correlationId: 'host-alias', dependencyTaskIds: deps }) });
}

async function succeed(id: string): Promise<void> {
  await stateManager.acquireLease({ taskId: id, owner: 'host-alias', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(id);
}

/**
 * Artificer content whose golden trace uses the author vocabulary
 * `edit_file` (baseline-resolvable to 'write' but NOT a real OpenClaw host
 * name after PRI-741's declaration correction).
 */
// v2 read-before-write rule semantics (mirrors the canonical dogfood rule):
// context-aware so the auto-generated v2 templates pass for BOTH rule
// variants below — the ONLY behavioral difference under test is matching by
// canonicalKind vs by the author's tool-name vocabulary.
const AUTHOR_READ_CONTEXT = {
  version: 2,
  history: {
    status: 'available',
    truncated: false,
    calls: [
      { sequenceId: 1, toolName: 'read', canonicalKind: 'read', normalizedPath: '/workspace/notes', paramsSummary: { path: '/workspace/notes' }, outcome: 'success' },
    ],
  },
  facts: { priorReadOfTarget: 'yes', readCount: 1, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
};
const AUTHOR_UNREAD_CONTEXT = {
  version: 2,
  history: {
    status: 'available',
    truncated: false,
    calls: [],
  },
  facts: { priorReadOfTarget: 'no', readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
};

function artificerContent(ruleBody: string): string {
  return JSON.stringify({
    implementationCode: `function evaluate(input, helpers) { ${ruleBody} }`,
    goldenTraceCases: [
      { caseId: 'c-neg', kind: 'negative', toolName: 'edit_file', params: { path: '/system/secret' }, expectedDecision: 'block', ruleContext: AUTHOR_UNREAD_CONTEXT },
      { caseId: 'c-pos', kind: 'positive', toolName: 'edit_file', params: { path: '/workspace/notes' }, expectedDecision: 'allow', ruleContext: AUTHOR_READ_CONTEXT },
    ],
    affectedTools: ['edit_file'],
  });
}

const KIND_MATCHING_BODY = 'if (typeof input.action.normalizedPath === "string" && input.action.normalizedPath.indexOf("/etc/") === 0) { return { decision: "block", matched: true, reason: "risk path" }; } if (!input.context || input.context.history.status === "unavailable") { return { decision: "allow", matched: false, reason: "context unavailable" }; } if (input.action.canonicalKind === "write" && input.context.facts.priorReadOfTarget === "no") { return { decision: "block", matched: true, reason: "read before write required" }; } return { decision: "allow", matched: false, reason: "ok" };';
const NAME_MATCHING_BODY = 'if (typeof input.action.normalizedPath === "string" && input.action.normalizedPath.indexOf("/etc/") === 0) { return { decision: "block", matched: true, reason: "risk path" }; } if (!input.context || input.context.history.status === "unavailable") { return { decision: "allow", matched: false, reason: "context unavailable" }; } if (input.action.toolName === "edit_file" && input.context.facts.priorReadOfTarget === "no") { return { decision: "block", matched: true, reason: "read before write required" }; } return { decision: "allow", matched: false, reason: "ok" };';

function v1ApprovedOutput(): unknown {
  return {
    taskId: EVAL_ID,
    sourceArtificerArtifactId: ARTIFICER_ART,
    evaluation: { decision: 'approved', summary: 'host-alias', score: 0.9, strengths: [], concerns: [], requiredChanges: [] },
    sourceTrace: { artificerArtifactId: ARTIFICER_ART },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

function scriptedAdapter(payload: unknown): PDRuntimeAdapter {
  return {
    startRun: async () => ({ runId: 'run-host-alias', runtimeKind: 'test-double', startedAt: new Date().toISOString() }),
    pollRun: async () => ({ status: 'succeeded', runId: 'run-host-alias' }),
    fetchOutput: async () => ({ runId: 'run-host-alias', payload }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

async function seedLineage(artificer: string): Promise<SqlitePIArtifactStore> {
  await mkTask(ARTIFICER_ID, 'artificer', []);
  await succeed(ARTIFICER_ID);
  await mkTask(EVAL_ID, 'evaluator', [ARTIFICER_ID]);
  const store = new SqlitePIArtifactStore(new SqliteConnection(workspaceDir));
  await store.upsertArtifact({
    artifactId: ARTIFICER_ART, artifactKind: 'principle', sourceTaskId: ARTIFICER_ID,
    lineageArtifactIds: [], validationStatus: 'validated',
    contentJson: artificer,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return store;
}

function makeRunner(
  store: SqlitePIArtifactStore,
  options: { hostSemanticContext?: ArtificerHostSemanticContext } = {},
): EvaluatorRunner {
  return new EvaluatorRunner(
    {
      stateManager, runtimeAdapter: scriptedAdapter(v1ApprovedOutput()),
      eventEmitter: emitter, artifactStore: store, validator: new DefaultEvaluatorValidator(),
    },
    {
      owner: 'host-alias', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 20_000,
      // REAL production gate deps: real vm sandbox + registry-backed
      // canonicalKind resolution, exactly like the consumer cycle.
      gateDeps: createProductionGateDeps({ projectDir: workspaceDir, toolSemantics: HOST_REGISTRY }),
      ...options,
    },
  );
}

async function replayedResult(ruleBody: string, options: { hostSemanticContext?: ArtificerHostSemanticContext } = {}): Promise<{ status: string; passed: boolean | undefined; failedCases: { caseId: string }[] }> {
  const store = await seedLineage(artificerContent(ruleBody));
  const runner = makeRunner(store, options);
  const result = await runner.run(EVAL_ID);
  const artifacts = await store.listBySourceTaskId(EVAL_ID);
  const principle = artifacts.find((a) => a.artifactKind === 'principle');
  const parsed = principle ? JSON.parse(principle.contentJson) as { adversarialResult?: { passed?: boolean; failedCases?: { caseId: string }[] } } : undefined;
  return {
    status: result.status,
    passed: parsed?.adversarialResult?.passed,
    failedCases: parsed?.adversarialResult?.failedCases ?? [],
  };
}

/** Typed access to the private generator for shape assertions (no dynamic code execution). */
function hostAliasMethod(runner: EvaluatorRunner): (rawGoldenCases: unknown, taskId: string, runId: string) => AdversarialCase | null {
  return (runner as unknown as { generateHostAliasCase: (rawGoldenCases: unknown, taskId: string, runId: string) => AdversarialCase | null }).generateHostAliasCase.bind(runner);
}

describe('PRI-741 host-name parity replay', () => {
  it('v2-host-alias variant is cloned from the first NEGATIVE case under the host real name', async () => {
    const store = await seedLineage(artificerContent(KIND_MATCHING_BODY));
    const runner = makeRunner(store, { hostSemanticContext: HOST_SEMANTIC_CONTEXT });
    const rawCases = [
      { caseId: 'c-neg', kind: 'negative', toolName: 'edit_file', params: { path: '/system/secret' }, expectedDecision: 'block' },
      { caseId: 'c-pos', kind: 'positive', toolName: 'edit_file', params: { path: '/workspace/notes' }, expectedDecision: 'allow' },
    ];
    const variant = hostAliasMethod(runner)(rawCases, EVAL_ID, 'run-host-alias');

    expect(variant).not.toBeNull();
    expect(variant?.caseId).toBe('v2-host-alias');
    // host REAL name, same canonicalKind as the author's edit_file vocabulary,
    // and the closest name match (edit_file → edit, not write — PRI-741 review)
    expect(variant?.toolName).toBe('edit');
    expect(variant?.params).toEqual({ path: '/system/secret' });
    expect(variant?.expectedDecision).toBe('block');
    expect(variant?.rationale).toContain('PRI-741 host-name parity');
    expect(emitted.some((e) => e.eventType === 'evaluator_host_alias_case_skipped')).toBe(false);
  });

  it('canonicalKind-matching rule passes replay including the host-alias variant (parity holds)', async () => {
    const out = await replayedResult(KIND_MATCHING_BODY, { hostSemanticContext: HOST_SEMANTIC_CONTEXT });
    expect(out.status).toBe('succeeded');
    expect(out.passed, JSON.stringify(out)).toBe(true);
    expect(out.failedCases).toEqual([]);
    expect(emitted.some((e) => e.eventType === 'evaluator_host_alias_case_skipped')).toBe(false);
  });

  it('control: a rule matching the author tool NAME fails the variant — G3 caught at replay', async () => {
    const out = await replayedResult(NAME_MATCHING_BODY, { hostSemanticContext: HOST_SEMANTIC_CONTEXT });
    expect(out.passed).toBe(false);
    expect(out.failedCases.some((fc) => fc.caseId === 'v2-host-alias')).toBe(true);
  });

  it('without hostSemanticContext the case is skipped observably (rc-9) and replay still runs', async () => {
    const out = await replayedResult(KIND_MATCHING_BODY);
    expect(out.status).toBe('succeeded');
    expect(out.passed).toBe(true);
    const skip = emitted.find((e) => e.eventType === 'evaluator_host_alias_case_skipped');
    expect(skip).toBeDefined();
    expect(JSON.stringify(skip?.payload)).toContain('no_host_semantic_context');
  });

  // ── PRI-741 review round: skip-branch coverage (codecov patch gate) ──

  it('non-array / empty golden cases skip observably with no_validated_golden_case', async () => {
    const store = await seedLineage(artificerContent(KIND_MATCHING_BODY));
    const generate = hostAliasMethod(makeRunner(store, { hostSemanticContext: HOST_SEMANTIC_CONTEXT }));
    for (const bad of ['nope', [], 42]) {
      emitted.length = 0;
      expect(generate(bad, EVAL_ID, 'run-host-alias')).toBeNull();
      const skip = emitted.find((e) => e.eventType === 'evaluator_host_alias_case_skipped');
      expect(skip, `input ${JSON.stringify(bad)}`).toBeDefined();
      expect(JSON.stringify(skip?.payload)).toContain('no_validated_golden_case');
    }
  });

  it('structurally invalid golden cases fail the builder and skip observably', async () => {
    const store = await seedLineage(artificerContent(KIND_MATCHING_BODY));
    const generate = hostAliasMethod(makeRunner(store, { hostSemanticContext: HOST_SEMANTIC_CONTEXT }));
    // Valid-looking array, but the case violates the golden-trace schema
    // (negative case expecting allow → builder rejects).
    const invalid = [
      { caseId: 'bad', kind: 'negative', toolName: 'edit_file', params: { path: '/x' }, expectedDecision: 'allow' },
    ];
    expect(generate(invalid, EVAL_ID, 'run-host-alias')).toBeNull();
    const skip = emitted.find((e) => e.eventType === 'evaluator_host_alias_case_skipped');
    expect(skip).toBeDefined();
    expect(JSON.stringify(skip?.payload)).toContain('no_validated_golden_case');
  });

  it('an author name that is already host-real skips observably (parity already covered)', async () => {
    const store = await seedLineage(artificerContent(KIND_MATCHING_BODY));
    const generate = hostAliasMethod(makeRunner(store, { hostSemanticContext: HOST_SEMANTIC_CONTEXT }));
    const hostRealCases = [
      { caseId: 'c-neg', kind: 'negative', toolName: 'write', params: { path: '/system/secret' }, expectedDecision: 'block' },
      { caseId: 'c-pos', kind: 'positive', toolName: 'write', params: { path: '/workspace/notes' }, expectedDecision: 'allow' },
    ];
    expect(generate(hostRealCases, EVAL_ID, 'run-host-alias')).toBeNull();
    const skip = emitted.find((e) => e.eventType === 'evaluator_host_alias_case_skipped');
    expect(skip).toBeDefined();
    expect(JSON.stringify(skip?.payload)).toContain('author_name_already_host_real');
  });

  it('a base case whose kind no host tool covers skips observably (no_host_tool_with_kind)', async () => {
    const store = await seedLineage(artificerContent(KIND_MATCHING_BODY));
    const generate = hostAliasMethod(makeRunner(store, { hostSemanticContext: HOST_SEMANTIC_CONTEXT }));
    // 'ask_user' canonicalizes to 'other'; the host projection declares no
    // 'other' tool, so no host-real substitute exists for the author's kind.
    const otherKindCases = [
      { caseId: 'c-neg', kind: 'negative', toolName: 'ask_user', params: { path: '/system/secret' }, expectedDecision: 'block' },
      { caseId: 'c-pos', kind: 'positive', toolName: 'edit_file', params: { path: '/workspace/notes' }, expectedDecision: 'allow' },
    ];
    expect(generate(otherKindCases, EVAL_ID, 'run-host-alias')).toBeNull();
    const skip = emitted.find((e) => e.eventType === 'evaluator_host_alias_case_skipped');
    expect(skip).toBeDefined();
    expect(JSON.stringify(skip?.payload)).toContain('no_host_tool_with_kind:other');
  });
});
