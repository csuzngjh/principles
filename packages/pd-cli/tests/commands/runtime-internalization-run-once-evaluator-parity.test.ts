/**
 * PRI-661 — run-once evaluator runtime parity (E2E through the REAL CLI
 * handler).
 *
 * Drives `handleRuntimeInternalizationRunOnce --runner evaluator` against a
 * REAL sqlite workspace + REAL persisted host declaration + the REAL resolver
 * and sandbox. Only the LLM boundary is the CLI's own test-double runtime.
 *
 * Pins the acceptance from the Linear issue:
 *   1. a declared workspace runs the deterministic adversarial replay to
 *      completion through run-once (the gap this PR closes);
 *   2. the SAME artifact replays to the SAME verdict through the
 *      consumer-cycle assembly formula (live registry from the same mapping
 *      constants) — replay/production parity, not just "some gate ran";
 *   3. an undeclared workspace refuses BEFORE leasing any task, with the same
 *      structured semantics as runtime-activation (no baseline fallback);
 *   4. a replay-failing rule records adversarialResult.passed=false — the
 *      deterministic verdict the downstream approval chain consumes.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RuntimeStateManager,
  createPITaskDiagnosticJson,
  buildToolSemanticRegistry,
  createProductionGateDeps,
  type ToolSemanticMappingV1,
} from '@principles/core/runtime-v2';
import { saveHostToolDeclaration } from '@principles/host-runtime';
import { handleRuntimeInternalizationRunOnce } from '../../src/commands/runtime-internalization-run-once.js';

const HOST_MAPPINGS: readonly ToolSemanticMappingV1[] = [
  { rawToolName: 'Write', canonicalKind: 'write' },
  { rawToolName: 'Edit', canonicalKind: 'write' },
  { rawToolName: 'write_file', canonicalKind: 'write' },
  { rawToolName: 'Bash', canonicalKind: 'execute' },
];

/**
 * A realistic write-after-read guard that satisfies both the fixture's golden
 * cases and the runner's 5 auto-generated v2 adversarial templates:
 * risk-path writes always block (v1 action check dominates); otherwise a
 * write is allowed only with prior-read evidence or an explicitly benign
 * context posture (unavailable/truncated/unknown fail open).
 * Registry-sensitive: it keys off action.canonicalKind — the field the host
 * tool registry injects into replay inputs.
 */
const PASSING_CODE = [
  'function evaluate(input) {',
  '  const action = input && input.action ? input.action : {};',
  '  const kind = action.canonicalKind ? action.canonicalKind : "other";',
  '  const params = action.paramsSummary ? action.paramsSummary : {};',
  '  const p = typeof params.path === "string" ? params.path : "";',
  '  if (kind !== "write") {',
  '    return { decision: "allow", matched: false, reason: "not a write" };',
  '  }',
  '  if (p.indexOf("/etc/") === 0) {',
  '    return { decision: "block", matched: true, reason: "risk path write" };',
  '  }',
  '  const ctx = input && input.context ? input.context : null;',
  '  const facts = ctx && ctx.facts ? ctx.facts : {};',
  '  if (facts.priorReadOfTarget === "yes") {',
  '    return { decision: "allow", matched: false, reason: "write after read" };',
  '  }',
  '  if (facts.priorReadOfTarget === "no") {',
  '    return { decision: "block", matched: true, reason: "write without prior read" };',
  '  }',
  '  return { decision: "allow", matched: false, reason: "unknown history fails open" };',
  '}',
].join('\n');

/** Same shape, but never blocks — the negative golden case fails under replay. */
const REPLAY_FAILING_CODE = [
  'function evaluate(input) {',
  '  return { decision: "allow", matched: false, reason: "never blocks" };',
  '}',
].join('\n');

const GOLDEN_CASES = [
  { caseId: 'c-neg', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
  { caseId: 'c-pos', kind: 'positive', toolName: 'write_file', params: { path: '/project/src/safe.ts' }, expectedDecision: 'allow' },
];

function codeBearingArtificerContent(implementationCode: string): string {
  return JSON.stringify({
    implementationCode,
    goldenTraceCases: GOLDEN_CASES,
    affectedTools: ['write_file'],
  });
}

const dirs: string[] = [];

function makeWorkspace(withDeclaration: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-runonce-parity-'));
  dirs.push(dir);
  if (withDeclaration) {
    saveHostToolDeclaration(dir, {
      version: 1,
      hostKind: 'openclaw',
      mappings: HOST_MAPPINGS,
      declaredAt: new Date().toISOString(),
    });
  }
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
});

/**
 * Seed the dependency chain exactly like the core gate-authority fixture:
 * artificer(succeeded) + its code-bearing artifact + evaluator(pending,
 * dep=artificer). The artifact id matches the CLI test-double's default echo.
 */
async function seedEvaluatorTask(workspaceDir: string, implementationCode: string): Promise<void> {
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  try {
    const meta = (deps: string[]): string =>
      createPITaskDiagnosticJson({
        dependencyTaskIds: deps, channel: 'prompt', timeoutMs: 300_000,
        inputArtifactRefs: [], outputArtifactRefs: [],
      });
    await stateManager.createTask({ taskId: 'artificer-seed', taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta([]) });
    await stateManager.acquireLease({ taskId: 'artificer-seed', owner: 'seed', runtimeKind: 'test-double' });
    await stateManager.markTaskSucceeded('artificer-seed');
    await stateManager.createTask({ taskId: 'evaluator-under-test', taskKind: 'evaluator', status: 'pending', attemptCount: 0, maxAttempts: 3, diagnosticJson: meta(['artificer-seed']) });
    await stateManager.piArtifactStore.upsertArtifact({
      artifactId: 'pi-art-test-artificer',
      artifactKind: 'principle',
      sourceTaskId: 'artificer-seed',
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: codeBearingArtificerContent(implementationCode),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } finally {
    await stateManager.close();
  }
}

async function readEvaluatorArtifact(workspaceDir: string): Promise<Record<string, unknown> | null> {
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  try {
    const artifacts = await stateManager.piArtifactStore.listBySourceTaskId('evaluator-under-test');
    const principle = artifacts.find((a) => a.artifactKind === 'principle');
    return principle ? (JSON.parse(principle.contentJson) as Record<string, unknown>) : null;
  } finally {
    await stateManager.close();
  }
}

/** The consumer-cycle assembly formula: live registry from the same constants a host passes in memory. */
function consumerCycleFormulaReplay(implementationCode: string): { passed: boolean; failedCaseCount: number } {
  const liveRegistry = buildToolSemanticRegistry(HOST_MAPPINGS);
  if (!liveRegistry.ok) throw new Error(liveRegistry.errors.join('; '));
  const gateDeps = createProductionGateDeps({ toolSemantics: liveRegistry.registry });
  const result = gateDeps.evaluateInSandbox(implementationCode, {
    version: 1,
    cases: GOLDEN_CASES.map((c) => ({ ...c })),
    createdAt: '2026-09-04T00:00:00.000Z',
  } as never);
  return {
    passed: result.success,
    failedCaseCount: result.failedCases.length,
  };
}

async function runOnceJson(workspaceDir: string): Promise<{ output: Record<string, unknown>; logSpy: ReturnType<typeof vi.spyOn> }> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const prevExitCode = process.exitCode;
  try {
    await handleRuntimeInternalizationRunOnce({
      workspace: workspaceDir,
      runner: 'evaluator',
      runtime: 'test-double',
      allowTestDouble: true,
      enqueueNext: false,
      json: true,
    });
    const printed = logSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.trim().startsWith('{'));
    expect(printed.length).toBeGreaterThan(0);
    return { output: JSON.parse(printed[0]) as Record<string, unknown>, logSpy };
  } finally {
    vi.restoreAllMocks();
    process.exitCode = prevExitCode;
  }
}

describe('run-once evaluator runtime parity (PRI-661)', () => {
  it('declared workspace: adversarial replay runs to completion and matches the consumer-cycle verdict', async () => {
    const workspaceDir = makeWorkspace(true);
    await seedEvaluatorTask(workspaceDir, PASSING_CODE);

    const { output } = await runOnceJson(workspaceDir);
    expect(output.decision).toBe('would_lease');
    expect(output.runnerResult, JSON.stringify(output)).toMatchObject({ status: 'succeeded' });

    const artifact = await readEvaluatorArtifact(workspaceDir);
    expect(artifact).not.toBeNull();
    const adversarial = (artifact?.adversarialResult ?? null) as { passed?: boolean; failedCases?: unknown[] } | null;
    expect(adversarial, 'deterministic replay must record adversarialResult').not.toBeNull();
    expect(adversarial?.passed).toBe(true);
    expect(adversarial?.failedCases ?? []).toEqual([]);

    // Parity: the SAME code replays to the SAME verdict through the
    // consumer-cycle assembly formula (live registry, same constants).
    expect(consumerCycleFormulaReplay(PASSING_CODE)).toEqual({ passed: true, failedCaseCount: 0 });
  }, 60_000);

  it('declared workspace: a replay-failing rule records passed=false with structured failed cases', async () => {
    const workspaceDir = makeWorkspace(true);
    await seedEvaluatorTask(workspaceDir, REPLAY_FAILING_CODE);

    const { output } = await runOnceJson(workspaceDir);

    const artifact = await readEvaluatorArtifact(workspaceDir);
    expect(artifact).not.toBeNull();
    const adversarial = (artifact?.adversarialResult ?? null) as { passed?: boolean; failedCases?: Array<{ caseId?: string }> } | null;
    expect(adversarial).not.toBeNull();
    expect(adversarial?.passed).toBe(false);
    // The auto-generated v2 templates expecting block are the ones a
    // never-blocking rule fails (path-boundary + combination at minimum).
    const failedIds = (adversarial?.failedCases ?? []).map((c) => c.caseId);
    expect(failedIds).toContain('v2-path-boundary');
    expect(failedIds).toContain('v2-combination');

    // The deterministic verdict the approval chain would consume matches the
    // consumer-cycle formula for the same artifact content.
    expect(consumerCycleFormulaReplay(REPLAY_FAILING_CODE)).toMatchObject({ passed: false });
    void output;
  }, 60_000);

  it('undeclared workspace: refuses BEFORE leasing, structured reason, queue untouched', async () => {
    const workspaceDir = makeWorkspace(false);
    await seedEvaluatorTask(workspaceDir, PASSING_CODE);

    const { output } = await runOnceJson(workspaceDir);
    expect(output.decision).toBe('refused');
    expect(output.reason).toBe('host_tool_declaration_missing');
    expect(typeof output.nextAction).toBe('string');
    expect((output.nextAction as string).length).toBeGreaterThan(0);

    // cli-5: refusal performed NO queue mutation — the evaluator task is
    // still pending and unleased.
    const stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    try {
      const task = await stateManager.getTask('evaluator-under-test');
      expect(task?.status).toBe('pending');
      expect(task?.leasedBy ?? null).toBeNull();
    } finally {
      await stateManager.close();
    }
  }, 60_000);
});
