import { describe, it, expect } from 'vitest';
import {
  EvaluatorPromptBuilder,
  EVALUATOR_PROTOCOL_INSTRUCTION,
  EVALUATOR_PROMPT_CONTRACT_VERSION,
} from '../evaluator-prompt-builder.js';
import { extractJsonObject } from '../../adapter/json-extractor.js';

describe('EvaluatorPromptBuilder', () => {
  const builder = new EvaluatorPromptBuilder();

  const input = {
    taskId: 'evaluator-task-001',
    contextHash: 'ctx-abc123',
    sourceArtificerArtifactId: 'pi-art-artificer-001',
    artificerArtifact: {
      taskId: 'artificer-task-001',
      implementationPlan: {
        summary: 'Add input validation',
        targetSurface: 'src/ops/*.ts',
        changes: ['Add try-catch'],
        tests: ['Unit test for error handling'],
        rolloutNotes: ['Deploy behind feature flag'],
        confidence: 0.85,
      },
    },
  };

  // Shared-contract note (PRI-888): passthrough fields (taskId/contextHash/
  // sourceArtificerArtifactId/artificerArtifact), JSON-only directive strings,
  // promptContractVersion presence and the PRI-633 payload/systemPrompt split
  // for this builder now run in peer-prompt-builder-contract.test.ts.
  // The exact systemPrompt === EVALUATOR_PROTOCOL_INSTRUCTION comparator pin
  // and all PRI/sourceTrace pins stay here.

  it('instruction says copy sourceTrace.artificerArtifactId exactly', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('sourceTrace.artificerArtifactId MUST be copied exactly from input.sourceArtificerArtifactId');
  });

  it('promptContractVersion value is evaluator-output-v1.prompt.v9 (derivation-fidelity anchor)', () => {
    // v7 (2026-10-11 closeout) anchored the first kind-semantics clause but
    // asserted a FALSE mapping ("EVERY writeTools entry dispatches as
    // 'write'") — the real OpenClaw catalog's writeTools is a risk grouping
    // that includes a shell tool dispatching 'execute' and an
    // agent-delegation tool dispatching 'agent'. v8 (review round) makes the
    // host's OWN tool-to-kind mapping the authority and keeps unknown when
    // no mapping is present.
    expect(EVALUATOR_PROMPT_CONTRACT_VERSION).toBe('evaluator-output-v1.prompt.v9');
  });

  // ── prompt.v9 (2026-10-12 r6): requiredChanges expressibility + ungrounded
  // mechanism routing ──
  // Live-chain evidence (p1-final r4 chain, 2026-10-12): the judge's
  // requiredChanges[0] demanded the rule read "Owner write-confirmation
  // records" from input.context — a field the RuleHost stateless single-call
  // input contract does NOT carry. Regenerating the rule can never satisfy
  // such a demand, so the item belonged in a marked concern for the Owner
  // (the contract asserted a mechanism with no Owner source), not in
  // requiredChanges. v9 adds two clauses:
  //  (a) RULEHOST EXPRESSIBILITY: requiredChanges may only demand behavior the
  //      stateless single-call evaluate(input) contract can express; a demand
  //      presupposing new input (persisted records, authorization tables,
  //      cross-call state) goes to concerns instead;
  //  (b) UNGROUNDED CONTRACT MECHANISM: when the intentContract asserts a
  //      mechanism absent from the diagnosis's Owner-attributed statements,
  //      that divergence is a Principle↔Pain mismatch finding (existing
  //      marker + Owner routing), never a rule defect. scopePrecision itself
  //      is unchanged — declared limitations do not auto-pass misblock/miss
  //      checks.
  it('instruction carries the RULEHOST EXPRESSIBILITY clause for requiredChanges (v9)', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('RULEHOST EXPRESSIBILITY');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('stateless single-call');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('can never be satisfied by regenerating the rule');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('record it in evaluation.concerns instead');
  });

  // Review round (2026-10-11): the clause must point the judge at the real
  // mapping (input.hostToolKinds), forbid reading the risk catalog or tool
  // names as kind authority, keep unknown when the mapping is absent, and
  // still allow evidenced parameter-shape coverage flags.
  it('instruction carries RUNTIME KIND SEMANTICS with the mapping authority (v8)', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('RUNTIME KIND SEMANTICS');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('The kind authority is input.hostToolKinds');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('input.hostToolCatalog is a risk/legality grouping, NOT a kind table');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain("never infer a kind from the catalog grouping or from a tool's name");
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('When input.hostToolKinds is ABSENT you have NO authoritative kind knowledge');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('equal canonicalKind does not prove equal parameter shape');
  });

  it('v7 false mappings are gone', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).not.toContain('EVERY tool catalogued under writeTools');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).not.toContain('ALREADY covers edit and apply_patch dispatches');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).not.toContain('readOnlyTools dispatch as "read" or "search"');
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).not.toContain('Only a rule that matches by literal toolName equality');
  });

  // The prompt message must carry the projected mapping when the runner has
  // a host semantic context — and must NOT carry the field when it does not.
  // Fixture mirrors the REAL OpenClaw producer data (openclaw-plugin
  // constants/tool-semantics.ts OPENCLAW_TOOL_SEMANTIC_MAPPINGS): the
  // file-mutation family as 'write', exec as 'execute', the agent-delegation
  // tool as 'agent' — the exact counterexample that disproved the v7
  // "every writeTools entry is write" claim (the risk catalog's writeTools
  // includes exec and the agent tool).
  it('message carries hostToolKinds from the host semantic context and omits it when absent', () => {
    const withMapping = builder.buildPrompt({
      ...input,
      hostToolKinds: [
        { rawToolName: 'write', canonicalKind: 'write' },
        { rawToolName: 'edit', canonicalKind: 'write' },
        { rawToolName: 'apply_patch', canonicalKind: 'write' },
        { rawToolName: 'exec', canonicalKind: 'execute' },
        { rawToolName: 'sessions_spawn', canonicalKind: 'agent' },
      ],
    });
    const parsedWith = JSON.parse(withMapping.message) as Record<string, unknown>;
    const kinds = parsedWith.hostToolKinds as { rawToolName: string; canonicalKind: string }[];
    expect(kinds).toEqual([
      { rawToolName: 'write', canonicalKind: 'write' },
      { rawToolName: 'edit', canonicalKind: 'write' },
      { rawToolName: 'apply_patch', canonicalKind: 'write' },
      { rawToolName: 'exec', canonicalKind: 'execute' },
      { rawToolName: 'sessions_spawn', canonicalKind: 'agent' },
    ]);

    const withoutMapping = builder.buildPrompt({ ...input });
    const parsedWithout = JSON.parse(withoutMapping.message) as Record<string, unknown>;
    expect(Object.hasOwn(parsedWithout, 'hostToolKinds')).toBe(false);
  });

  it('score instruction says number not string/percentage', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('NOT a string, NOT a percentage');
  });

  it('systemPrompt carries the evaluator instruction (PRI-633)', () => {
    const { systemPrompt } = builder.buildPrompt(input);
    expect(systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION);
  });

  it('instruction contains complete JSON example with all required fields', () => {
    const parsed = extractJsonObject(EVALUATOR_PROTOCOL_INSTRUCTION);
    expect(parsed).not.toBeNull();
    const example = parsed as Record<string, unknown>;
    expect(example).toHaveProperty('taskId');
    expect(example).toHaveProperty('sourceArtificerArtifactId');
    expect(example).toHaveProperty('evaluation');
    const evaluation = example.evaluation as Record<string, unknown>;
    expect(evaluation).toHaveProperty('decision');
    expect(evaluation).toHaveProperty('summary');
    expect(evaluation).toHaveProperty('score');
    expect(typeof evaluation.score).toBe('number');
    expect(evaluation).toHaveProperty('strengths');
    expect(Array.isArray(evaluation.strengths)).toBe(true);
    expect(evaluation).toHaveProperty('concerns');
    expect(Array.isArray(evaluation.concerns)).toBe(true);
    expect(evaluation).toHaveProperty('requiredChanges');
    expect(Array.isArray(evaluation.requiredChanges)).toBe(true);
    expect(example).toHaveProperty('sourceTrace');
    const sourceTrace = example.sourceTrace as Record<string, unknown>;
    expect(sourceTrace).toHaveProperty('artificerArtifactId');
    expect(sourceTrace.artificerArtifactId).toBe(example.sourceArtificerArtifactId);
    expect(example).toHaveProperty('risks');
    expect(Array.isArray(example.risks)).toBe(true);
    expect(example).toHaveProperty('generatedAt');
  });

  it('instruction says ENTIRE response must be ONLY the JSON object', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('ENTIRE response must be ONLY the JSON object');
  });

  it('instruction says no text before or after JSON', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('no prose before or after');
  });

  it('instruction says no markdown code fences', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('Do NOT wrap the JSON in markdown code fences');
  });
});
