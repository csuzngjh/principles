/**
 * Replay / Production Input Parity tests — PRI-634-F Phase 2
 *
 * SPEC §12 Phase 2 acceptance: for the same {tool, params, workspace}, the
 * replay input builder and the production action builder produce identical
 * canonicalKind / normalizedPath / paramsSummary.
 *
 * Baseline defect this file pins (see docs/pri-634-f-baseline-report.md §1.3):
 * replay builders never passed isBashTool/isWriteTool hints, so bash command
 * extraction and write-tool synthetic paths never fired on the replay side.
 */

import { describe, expect, it } from 'vitest';
import { buildRuleHostAction } from '../internalization/rule-host-input-builder.js';
import { createSyntheticRuleHostInput } from '../golden-trace.js';
import { evaluateInRefinerSandbox } from '../internalization/refiner-sandbox-wrapper.js';
import { buildToolSemanticRegistry } from '../internalization/tool-semantic-registry.js';
import type { GoldenTrace } from '../golden-trace.js';

const PROJECT_DIR = '/workspace/project';

function registry() {
  const built = buildToolSemanticRegistry([
    { rawToolName: 'shell', canonicalKind: 'execute' },
    { rawToolName: 'delete_file', canonicalKind: 'write' },
  ]);
  if (!built.ok) throw new Error(built.errors.join('; '));
  return built.registry;
}

interface ParityFixture {
  label: string;
  toolName: string;
  params: Record<string, unknown>;
}

const FIXTURES: readonly ParityFixture[] = [
  { label: 'write tool with absolute path', toolName: 'write_file', params: { file_path: '/workspace/project/src/a.ts', content: 'x' } },
  { label: 'write tool with relative path', toolName: 'edit', params: { path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
  { label: 'bash tool, mutation target', toolName: 'bash', params: { command: 'rm -rf /workspace/project/build' } },
  { label: 'bash tool, no file target (full command)', toolName: 'bash', params: { command: 'npm test' } },
  { label: 'generic LLM alias execute_command', toolName: 'execute_command', params: { command: 'python deploy.py' } },
  { label: 'host alias shell (was other before host layer)', toolName: 'shell', params: { command: 'grep -r TODO .' } },
  { label: 'write tool without any path (synthetic <tool:X>)', toolName: 'delete_file', params: { } },
  { label: 'write tool with pathless write', toolName: 'insert', params: { content: 'data' } },
  { label: 'read tool with path', toolName: 'read_file', params: { file_path: '/workspace/project/README.md' } },
  { label: 'unknown tool (resolve other, no extraction)', toolName: 'mystery_tool', params: { path: '/workspace/project/x' } },
];

describe('replay/production input parity (SPEC §12 Phase 2)', () => {
  for (const fixture of FIXTURES) {
    it(`replay input === production action: ${fixture.label}`, () => {
      const toolSemantics = registry();
      const canonicalKind = toolSemantics.resolve(fixture.toolName);

      // Production side: the gate resolves the kind from the registry, then
      // hands it to the shared builder (hooks/gate.ts + production-rulehost-gate.ts).
      const productionAction = buildRuleHostAction(fixture.toolName, fixture.params, PROJECT_DIR, { canonicalKind });

      // Replay side: the synthetic input builder resolves through the SAME
      // registry (refiner-sandbox-wrapper + golden-trace-replay-validator).
      const replayInput = createSyntheticRuleHostInput(
        { toolName: fixture.toolName, params: fixture.params },
        {},
        { projectDir: PROJECT_DIR, toolSemantics },
      );

      expect(replayInput.action.toolName).toBe(productionAction.toolName);
      expect(replayInput.action.canonicalKind).toBe(productionAction.canonicalKind);
      expect(replayInput.action.normalizedPath).toBe(productionAction.normalizedPath);
      expect(replayInput.action.paramsSummary).toEqual(productionAction.paramsSummary);
    });
  }

  it('registry-driven replay now extracts bash command paths (baseline defect pinned)', () => {
    const toolSemantics = registry();
    const input = createSyntheticRuleHostInput(
      { toolName: 'bash', params: { command: 'rm -rf /workspace/project/build' } },
      {},
      { projectDir: PROJECT_DIR, toolSemantics },
    );
    // Baseline: hints absent → extraction skipped → normalizedPath null.
    expect(input.action.normalizedPath).toBe('build');
    expect(input.action.canonicalKind).toBe('execute');
  });

  it('legacy replay behavior is unchanged without a registry (back-compat)', () => {
    const input = createSyntheticRuleHostInput(
      { toolName: 'bash', params: { command: 'rm -rf /workspace/project/build' } },
      {},
      { projectDir: PROJECT_DIR },
    );
    // PRI-439 legacy semantics: projectDir present but no hints → bash command
    // extraction never fires; normalizePathPure(null) === '' (not a path).
    expect(input.action.normalizedPath).toBe('');
    expect(input.action.canonicalKind).toBeUndefined();
  });
});

describe('activation-gate sandbox parity (refiner-sandbox-wrapper)', () => {
  it('a rule reading input.action sees the bash command path when toolSemantics is provided', () => {
    const toolSemantics = registry();
    const trace: GoldenTrace = {
      traceId: 'trace-bash-parity',
      version: 1,
      createdAt: '2026-09-03T00:00:00.000Z',
      cases: [
        {
          caseId: 'negative-1',
          kind: 'negative',
          toolName: 'bash',
          params: { command: 'rm -rf /workspace/project/build' },
          expectedDecision: 'block',
        },
        {
          caseId: 'positive-1',
          kind: 'positive',
          toolName: 'bash',
          params: { command: 'echo ok' },
          expectedDecision: 'allow',
        },
      ],
    };

    // The rule matches on the extracted normalizedPath — under the baseline
    // (registry absent) it would never match because normalizedPath was null.
    // evaluateCode is a plain closure: the wrapper uses `code` only for static
    // checks, so the behavioral contract under test is the INPUT it receives.
    const code = [
      'const evaluate = (input) => {',
      '  if (input.action.normalizedPath === "build") {',
      '    return { decision: "block", matched: true, reason: "destructive build wipe" };',
      '  }',
      '  return { decision: "allow", matched: false, reason: "not the protected path" };',
      '};',
    ].join('\n');

    const result = evaluateInRefinerSandbox(code, trace, {
      evaluateCode: (input) => {
        if (input.action.normalizedPath === 'build') {
          return { decision: 'block' as const, matched: true, reason: 'destructive build wipe' };
        }
        return { decision: 'allow' as const, matched: false, reason: 'not the protected path' };
      },
      toolSemantics,
      projectDir: PROJECT_DIR,
    });

    expect(result.success).toBe(true);
    expect(result.failedCases).toHaveLength(0);

    // Negative control: without the registry+root the same closure cannot
    // match — pinning WHY the parity plumbing is required on the replay side.
    const baselineResult = evaluateInRefinerSandbox(code, trace, {
      evaluateCode: (input) => {
        if (input.action.normalizedPath === 'build') {
          return { decision: 'block' as const, matched: true, reason: 'destructive build wipe' };
        }
        return { decision: 'allow' as const, matched: false, reason: 'not the protected path' };
      },
    });
    expect(baselineResult.success).toBe(false);
    expect(baselineResult.failedCases[0]?.caseId).toBe('negative-1');
  });
});
