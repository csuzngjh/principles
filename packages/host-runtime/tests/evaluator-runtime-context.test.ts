/**
 * PRI-661 — evaluator runtime context builder + replay/production parity.
 *
 * The builder is the ONE construction path for the deterministic adversarial
 * replay context used by host-neutral CLI entries (run-once evaluator,
 * run-rulehost pipeline). These tests pin the two properties the issue is
 * about, against REAL files, the REAL resolver and the REAL sandbox:
 *
 *   P1 (parity): the same rule code + golden trace + workspace produce the
 *      SAME RefinerSandboxResult whether the gate deps come from the builder
 *      (durable declaration) or from the consumer-cycle assembly formula
 *      (live registry built from the same mapping constants) — the drift
 *      PRI-661 exists to close.
 *   P2 (fail-loud): unresolvable provenance (no declaration persisted /
 *      malformed declaration) is a structured refusal — never a silent
 *      baseline-only fallback (ERR-114).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildToolSemanticRegistry,
  createProductionGateDeps,
  type ToolSemanticMappingV1,
} from '@principles/core/runtime-v2';
import {
  createEvaluatorRuntimeContext,
  saveHostToolDeclaration,
} from '../src/index.js';

const HOST_MAPPINGS: readonly ToolSemanticMappingV1[] = [
  { rawToolName: 'Write', canonicalKind: 'write' },
  { rawToolName: 'Edit', canonicalKind: 'write' },
  { rawToolName: 'Bash', canonicalKind: 'execute' },
];

const dirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-eval-ctx-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
});

/**
 * A registry-SENSITIVE rule implementation: it blocks system-path writes only
 * when the replay input carries canonicalKind='write' — the field the host
 * tool registry injects. Under a baseline-only replay (no registry) the same
 * code+trace gets a DIFFERENT verdict, which is precisely the drift PRI-661
 * exists to close.
 */
const PASSING_CODE = [
  'function evaluate(input) {',
  '  const action = input && input.action ? input.action : {};',
  '  const kind = action.canonicalKind ? action.canonicalKind : "other";',
  '  const params = action.paramsSummary ? action.paramsSummary : {};',
  '  const p = typeof params.path === "string" ? params.path : "";',
  '  if (kind === "write" && p.indexOf("/etc/") === 0) {',
  '    return { decision: "block", matched: true, reason: "system path write" };',
  '  }',
  '  return { decision: "allow", matched: false, reason: "project path" };',
  '}',
].join('\n');

const TRACE = [
  { caseId: 'c-neg', kind: 'negative', toolName: 'Write', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
  { caseId: 'c-pos', kind: 'positive', toolName: 'Write', params: { path: '/project/src/safe.ts' }, expectedDecision: 'allow' },
] as const;

/** A trace the code CANNOT satisfy (expects allow on a system path). */
const FAILING_TRACE = [
  { caseId: 'c-bad', kind: 'negative', toolName: 'Write', params: { path: '/etc/passwd' }, expectedDecision: 'allow' },
] as const;

function replay(gateDeps: { evaluateInSandbox: (code: string, trace: unknown, opts?: unknown) => { success: boolean; failedCases: unknown[]; executionTimeMs?: number } }, code: string, cases: readonly unknown[]): unknown {
  const result = gateDeps.evaluateInSandbox(code, { version: 1, cases: [...cases], createdAt: '2026-09-04T00:00:00.000Z' } as never, {
    projectDir: undefined,
  });
  // executionTimeMs is wall-clock noise — strip it so parity assertions
  // compare verdict semantics only.
  const { executionTimeMs: _timing, ...verdict } = result;
  void _timing;
  return verdict;
}

describe('createEvaluatorRuntimeContext (PRI-661)', () => {
  it('host-neutral mode resolves the durable declaration and replays identically to the consumer-cycle formula (P1)', () => {
    const workspaceDir = makeWorkspace();
    saveHostToolDeclaration(workspaceDir, {
      version: 1,
      hostKind: 'openclaw',
      mappings: HOST_MAPPINGS,
      declaredAt: new Date().toISOString(),
    });

    const viaBuilder = createEvaluatorRuntimeContext({ workspaceDir });
    expect(viaBuilder.ok).toBe(true);

    // The consumer-cycle assembly formula: the live in-memory registry hosts
    // build from the SAME mapping constants they persist.
    const liveRegistry = buildToolSemanticRegistry(HOST_MAPPINGS);
    expect(liveRegistry.ok).toBe(true);
    const viaConsumerCycleFormula = createProductionGateDeps({
      projectDir: workspaceDir,
      ...(liveRegistry.ok ? { toolSemantics: liveRegistry.registry } : {}),
    });
    if (!viaBuilder.ok) throw new Error('builder refused a declared workspace');

    for (const [label, code, cases] of [
      ['passing code + trace', PASSING_CODE, TRACE],
      ['failing trace', PASSING_CODE, FAILING_TRACE],
    ] as const) {
      const fromBuilder = replay(viaBuilder.gateDeps, code, cases);
      const fromCycle = replay(viaConsumerCycleFormula, code, cases);
      expect(fromBuilder, label).toEqual(fromCycle);
    }
    // Sanity: the passing fixture actually passes, the failing one fails —
    // the parity above is over real verdicts, not two identical errors.
    expect(replay(viaBuilder.gateDeps, PASSING_CODE, TRACE)).toMatchObject({ success: true });
    expect(replay(viaBuilder.gateDeps, PASSING_CODE, FAILING_TRACE)).toMatchObject({ success: false });
    // Drift demonstration: the SAME code+trace under a baseline-only replay
    // (the old sandbox wiring — no workspace registry) reaches a different
    // verdict, because 'Write' resolves to canonicalKind='write' only through
    // the host declaration. This is why the builder refuses to fall back.
    const baselineOnly = createProductionGateDeps({ projectDir: workspaceDir });
    expect(replay(baselineOnly, PASSING_CODE, TRACE)).toMatchObject({ success: false });
  });

  it('host-threaded mode replays identically to the durable-declaration mode (same constants round-trip)', () => {
    const workspaceDir = makeWorkspace();
    saveHostToolDeclaration(workspaceDir, {
      version: 1,
      hostKind: 'openclaw',
      mappings: HOST_MAPPINGS,
      declaredAt: new Date().toISOString(),
    });
    const liveRegistry = buildToolSemanticRegistry(HOST_MAPPINGS);
    if (!liveRegistry.ok) throw new Error(liveRegistry.errors.join('; '));

    const viaHostThread = createEvaluatorRuntimeContext({ workspaceDir, toolSemantics: liveRegistry.registry });
    const viaDeclaration = createEvaluatorRuntimeContext({ workspaceDir });
    expect(viaHostThread.ok).toBe(true);
    expect(viaDeclaration.ok).toBe(true);
    if (!viaHostThread.ok || !viaDeclaration.ok) throw new Error('unreachable');

    expect(replay(viaHostThread.gateDeps, PASSING_CODE, TRACE)).toEqual(replay(viaDeclaration.gateDeps, PASSING_CODE, TRACE));
    expect(replay(viaHostThread.gateDeps, PASSING_CODE, FAILING_TRACE)).toEqual(replay(viaDeclaration.gateDeps, PASSING_CODE, FAILING_TRACE));
  });

  it('host-neutral mode REFUSES when no declaration is persisted — never a baseline fallback (P2)', () => {
    const workspaceDir = makeWorkspace();
    const resolved = createEvaluatorRuntimeContext({ workspaceDir });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.reason).toBe('host_tool_declaration_missing');
    expect(resolved.nextAction.length).toBeGreaterThan(0);
  });

  it('host-neutral mode REFUSES on a malformed declaration file with a repair action (P2)', () => {
    const workspaceDir = makeWorkspace();
    const dir = path.join(workspaceDir, '.pd', 'host-tool-semantics');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'openclaw.json'), '{not json', 'utf-8');

    const resolved = createEvaluatorRuntimeContext({ workspaceDir });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.reason).toContain('host_tool_declaration_invalid');
    expect(resolved.nextAction.length).toBeGreaterThan(0);
  });
});
