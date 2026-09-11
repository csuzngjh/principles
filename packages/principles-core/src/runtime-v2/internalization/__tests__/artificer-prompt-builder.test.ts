import { describe, it, expect } from 'vitest';
import {
  ArtificerPromptBuilder,
  ARTIFICER_PROTOCOL_INSTRUCTION,
  ARTIFICER_PROMPT_CONTRACT_VERSION,
  buildArtificerHostSemanticContext,
} from '../artificer-prompt-builder.js';
import { buildToolSemanticRegistry } from '../tool-semantic-registry.js';
import type { BehaviorExamplePack } from '../behavior-example-pack.js';

// P2 fix (CodeRabbit PR2 Comment 4): a minimal valid BehaviorExamplePack used
// to drive the v2 path through the prompt builder so assertions land on the
// composed artificerInstruction, not the bare ARTIFICER_PROTOCOL_INSTRUCTION.
// Shared at module scope so both describe blocks can construct v2 prompts.
const validBehaviorExamplePack: BehaviorExamplePack = {
  sourceNegativeCase: {
    caseId: 'neg-1',
    kind: 'negative',
    toolName: 'write_file',
    params: { path: '/system/file' },
    expectedDecision: 'block',
  },
  ownerDesiredOutcome: 'block writes outside the workspace',
  positiveCounterexamples: [
    {
      caseId: 'pos-1',
      kind: 'positive',
      toolName: 'write_file',
      params: { path: '/workspace/file' },
      expectedDecision: 'allow',
    },
  ],
  evidenceRefs: ['pain://1'],
  redactionNotes: [],
};

describe('ArtificerPromptBuilder', () => {
  const builder = new ArtificerPromptBuilder();

  const input = {
    contextMode: 'v1' as const,
    taskId: 'artificer-task-001',
    contextHash: 'ctx-abc123',
    sourceScribeArtifactId: 'pi-art-scribe-001',
    scribeArtifact: {
      taskId: 'scribe-task-001',
      principleDraft: { title: 'Test', statement: 'S', rationale: 'R', applicability: [], antiPatterns: [], confidence: 0.9 },
    },
  };

  it('includes sourceScribeArtifactId at top level in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.sourceScribeArtifactId).toBe('pi-art-scribe-001');
  });

  it('instruction says copy sourceScribeArtifactId exactly', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('sourceScribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId');
  });

  it('instruction says copy sourceTrace.scribeArtifactId exactly', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('sourceTrace.scribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId');
  });

  it('instruction includes JSON-only constraint', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('ONLY valid JSON');
  });

  it('instruction includes no markdown constraint', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('no markdown');
  });

  it('instruction includes no code fences constraint', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('no code fences');
  });

  it('promptContractVersion is present in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.promptContractVersion).toBe(ARTIFICER_PROMPT_CONTRACT_VERSION);
  });

  it('promptContractVersion identifies the executable V2 contract', () => {
    // PRI-484 — bumped v1 → v2 to signal the RuleCode context surface is part
    // of the contract the model must obey; PRI-634 PR-A — bumped v2 → v3 for
    // the paramsSummary-is-an-object contract + repair replay-evidence block;
    // PRI-700 — bumped v3 → v4 for the case-id vocabulary note + prior
    // output-contract rejection feedback; PRI-741 — bumped v4 → v5 for the
    // canonicalKind-first matching contract + HOST SEMANTIC CONTEXT block.
    expect(ARTIFICER_PROMPT_CONTRACT_VERSION).toBe('artificer-output-v2.prompt.v5');
  });

  // ── PRI-741: canonicalKind-first contract + host semantic projection ──

  it('PRI-741: instruction carries the canonicalKind-first matching contract and no longer teaches the phantom write_file', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('input.action.canonicalKind');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('"read" | "search" | "write" | "execute" | "agent" | "other"');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('CANONICALKIND-FIRST MATCHING (PRI-741)');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('generic LLM vocabulary names (write_file, edit_file, bash, run_shell_command, delete_file, ...) are NOT real host tools');
    // The OUTPUT FORMAT example must not demonstrate the phantom vocabulary.
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).not.toContain('"toolName":"write_file"');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).not.toContain('"affectedTools": ["write_file"]');
  });

  it('PRI-741: v1 prompt without hostSemanticContext stays backward compatible (no host block, no field)', () => {
    const { message, systemPrompt } = builder.buildPrompt(input);
    expect(systemPrompt).not.toContain('HOST SEMANTIC CONTEXT (authoritative');
    const parsed = JSON.parse(message) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('hostSemanticContext');
  });

  it('PRI-741: v1 prompt with hostSemanticContext renders the HOST SEMANTIC CONTEXT block from the projection', () => {
    const { message, systemPrompt, promptInput } = builder.buildPrompt({
      ...input,
      hostSemanticContext: {
        hostKinds: ['openclaw'],
        tools: [
          { rawToolName: 'write', canonicalKind: 'write' },
          { rawToolName: 'edit', canonicalKind: 'write' },
          { rawToolName: 'exec', canonicalKind: 'execute' },
        ],
      },
    });
    expect(systemPrompt).toContain('HOST SEMANTIC CONTEXT');
    expect(systemPrompt).toContain('Target host(s): openclaw');
    expect(systemPrompt).toContain('write→write');
    expect(systemPrompt).toContain('exec→execute');
    expect(systemPrompt).toContain('MUST be one of the real host tool names');
    // DTO travels in the payload for machine readability (evaluator precedent).
    expect(promptInput.hostSemanticContext).toEqual({
      hostKinds: ['openclaw'],
      tools: [
        { rawToolName: 'write', canonicalKind: 'write' },
        { rawToolName: 'edit', canonicalKind: 'write' },
        { rawToolName: 'exec', canonicalKind: 'execute' },
      ],
    });
    const parsed = JSON.parse(message) as { hostSemanticContext?: unknown };
    expect(parsed.hostSemanticContext).toBeDefined();
  });

  // ── PRI-741 review round: projection sanitization (llm trust boundary) ──

  it('PRI-741 review: buildArtificerHostSemanticContext filters control-char names and bounds the list', () => {
    const built = buildToolSemanticRegistry([
      { rawToolName: 'write', canonicalKind: 'write' },
      { rawToolName: 'evil\ninjected instructions', canonicalKind: 'write' },
      { rawToolName: 'tab\tname', canonicalKind: 'execute' },
      { rawToolName: `${'x'.repeat(200)}`, canonicalKind: 'execute' },
    ]);
    if (!built.ok) throw new Error('registry failed to build');
    const dto = buildArtificerHostSemanticContext(built.registry, ['openclaw', 'bad kind!']);
    expect(dto.tools.map((t) => t.rawToolName)).toEqual(['write']);
    expect(dto.hostKinds).toEqual(['openclaw']);
  });

  it('PRI-741 review: buildArtificerHostSemanticContext caps the projected list at 64 entries', () => {
    const mappings = Array.from({ length: 70 }, (_, i) => ({ rawToolName: `tool_${i}`, canonicalKind: 'other' as const }));
    const built = buildToolSemanticRegistry(mappings);
    if (!built.ok) throw new Error('registry failed to build');
    const dto = buildArtificerHostSemanticContext(built.registry, []);
    expect(dto.tools.length).toBe(64);
    expect(dto.hostKinds).toEqual([]);
  });

  it('instruction requires implementationSummary as a non-empty string', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('implementationSummary MUST be a non-empty string');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).not.toContain('"implementationPlan"');
  });

  it('message is valid JSON containing promptInput', () => {
    const { message, systemPrompt } = builder.buildPrompt(input);
    const parsed = JSON.parse(message);
    expect(parsed.taskId).toBe(input.taskId);
    expect(parsed.contextHash).toBe(input.contextHash);
    expect(parsed.sourceScribeArtifactId).toBe(input.sourceScribeArtifactId);
    // PRI-633: the instruction left the payload for the system channel.
    expect(parsed).not.toHaveProperty('artificerInstruction');
    expect(parsed.promptContractVersion).toBe(ARTIFICER_PROMPT_CONTRACT_VERSION);
    expect(systemPrompt).toContain(ARTIFICER_PROTOCOL_INSTRUCTION);
  });

  it('systemPrompt carries the composed artificer instruction (PRI-633)', () => {
    const { systemPrompt } = builder.buildPrompt(input);
    expect(systemPrompt).toContain(ARTIFICER_PROTOCOL_INSTRUCTION);
  });
});

describe('PRI-484 Artificer prompt context modes', () => {
  // Red phase: assertions covering the rewrite required by the
  // 2026-06-27 RuleCode context vision design §7.3.

  it('allows inspecting input.context (v2 surface)', () => {
    const { systemPrompt } = new ArtificerPromptBuilder().buildPrompt({ contextMode: 'v1', taskId: 'task', contextHash: 'hash', sourceScribeArtifactId: 'scribe', scribeArtifact: {} });
    expect(systemPrompt).toMatch(/must not.*input\.context/i);
  });

  it('requires allow when context is missing or unavailable', () => {
    // P2 fix (CodeRabbit PR2 Comment 4): assert against the v2 prompt built by
    // the prompt builder (systemPrompt, PRI-633 ex-artificerInstruction), not
    // the bare ARTIFICER_PROTOCOL_INSTRUCTION constant. The v2 contract is
    // appended via V2_CONTEXT_INSTRUCTION; asserting on the bare constant
    // would not verify that the contract actually flows through the builder.
    const { systemPrompt } = new ArtificerPromptBuilder().buildPrompt({
      contextMode: 'v2',
      taskId: 'task',
      contextHash: 'hash',
      sourceScribeArtifactId: 'scribe',
      scribeArtifact: {},
      behaviorExamplePack: validBehaviorExamplePack,
    });
    expect(systemPrompt).toContain('unavailable');
    expect(systemPrompt).toMatch(/MUST.*allow.*matched.*false/i);
  });

  it('requires preferring canonicalKind / facts over raw history.calls', () => {
    const { systemPrompt } = new ArtificerPromptBuilder().buildPrompt({
      contextMode: 'v2',
      taskId: 'task',
      contextHash: 'hash',
      sourceScribeArtifactId: 'scribe',
      scribeArtifact: {},
      behaviorExamplePack: validBehaviorExamplePack,
    });
    expect(systemPrompt).toContain('facts');
    expect(systemPrompt).toContain('canonicalKind');
    expect(systemPrompt).toContain('Prefer');
  });

  it('forbids inferring "not done" from an empty calls array', () => {
    const { systemPrompt } = new ArtificerPromptBuilder().buildPrompt({
      contextMode: 'v2',
      taskId: 'task',
      contextHash: 'hash',
      sourceScribeArtifactId: 'scribe',
      scribeArtifact: {},
      behaviorExamplePack: validBehaviorExamplePack,
    });
    expect(systemPrompt).toContain('not done');
    expect(systemPrompt).toContain('empty');
  });

  it('declares the contract version bump history v1 → v2 → v3 → v4 → v5 (PRI-634 PR-A, PRI-700, PRI-741)', () => {
    expect(ARTIFICER_PROMPT_CONTRACT_VERSION).toBe('artificer-output-v2.prompt.v5');
  });

  it('still references input.action for v1 compatibility', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('input.action');
  });

  it('PRI-634 PR-A: states paramsSummary is an object and forbids whole-object string methods', () => {
    // SPEC §32 — the Artificer must never emit paramsSummary.includes(...) /
    // startsWith(...): paramsSummary is Record<string, unknown>, and path
    // logic must prefer normalizedPath or guarded key access.
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('paramsSummary is an OBJECT');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('NEVER call string methods on paramsSummary itself');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('paramsSummary.includes(');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('prefer input.action.normalizedPath');
  });

  it('mentions requiresContextVersion when declaring v2 rules', () => {
    const builder = new ArtificerPromptBuilder();
    expect(() => builder.buildPrompt({ contextMode: 'v2', taskId: 'task', contextHash: 'hash', sourceScribeArtifactId: 'scribe', scribeArtifact: {} })).toThrow(/behaviorExamplePack/i);
  });

  it('keeps the existing JSON-only output constraint intact', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('ONLY valid JSON');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('no markdown');
  });

  it('keeps the prior adversarial-failures section intact', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('adversarialFeedback');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('RETRY');
  });
});

describe('PRI-508: Artificer dreamer context passthrough', () => {
  // Vertical slice 1: dreamerContext 5维字段透传到 prompt message
  it('includes dreamerContext.badDecision/betterDecision/rationale in prompt message when provided', () => {
    const builder = new ArtificerPromptBuilder();
    const { message, promptInput } = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'task-pri-508',
      contextHash: 'ctx-pri-508',
      sourceScribeArtifactId: 'scribe-pri-508',
      scribeArtifact: {},
      dreamerContext: {
        badDecision: 'agent called write_file without checking parent path',
        betterDecision: 'agent should resolve and validate parent path before write',
        rationale: 'unchecked parent path leads to path traversal risk',
        riskLevel: 'medium',
        strategicPerspective: 'proactive validation over reactive cleanup',
      },
    });
    const parsed = JSON.parse(message);
    expect(parsed.dreamerContext).toBeDefined();
    expect(parsed.dreamerContext.badDecision).toBe('agent called write_file without checking parent path');
    expect(parsed.dreamerContext.betterDecision).toBe('agent should resolve and validate parent path before write');
    expect(parsed.dreamerContext.rationale).toBe('unchecked parent path leads to path traversal risk');
    expect(parsed.dreamerContext.riskLevel).toBe('medium');
    expect(parsed.dreamerContext.strategicPerspective).toBe('proactive validation over reactive cleanup');
    expect(promptInput.dreamerContext).toBeDefined();
  });

  // Vertical slice 2: RuleHost capability boundary hint in protocol instruction
  it('instruction includes RuleHost capability boundary (stateless/single-call)', () => {
    // PRI-508: artificer must know RuleHost evaluate() is a stateless single-call
    // gate to avoid implementing unenforceable procedural rules (e.g. path whitelists
    // for "audit before modify" principles). PoC-validated text.
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toMatch(/stateless|single-call/i);
  });

  // Vertical slice 3: backward compatibility — dreamerContext absent → not in prompt
  it('does not include dreamerContext in prompt when not provided (backward compatible)', () => {
    const builder = new ArtificerPromptBuilder();
    const { message, promptInput } = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'task-pri-508-no-dreamer',
      contextHash: 'ctx-pri-508',
      sourceScribeArtifactId: 'scribe-pri-508',
      scribeArtifact: {},
    });
    const parsed = JSON.parse(message);
    expect(parsed.dreamerContext).toBeUndefined();
    expect(promptInput.dreamerContext).toBeUndefined();
  });

  // Vertical slice 3b: v2 mode also passes dreamerContext through
  it('v2 mode includes dreamerContext in prompt when provided', () => {
    const builder = new ArtificerPromptBuilder();
    const { message } = builder.buildPrompt({
      contextMode: 'v2',
      taskId: 'task-pri-508-v2',
      contextHash: 'ctx-pri-508-v2',
      sourceScribeArtifactId: 'scribe-pri-508',
      scribeArtifact: {},
      behaviorExamplePack: validBehaviorExamplePack,
      dreamerContext: {
        badDecision: 'v2 bad decision text',
        betterDecision: 'v2 better decision text',
        rationale: 'v2 rationale text',
      },
    });
    const parsed = JSON.parse(message);
    expect(parsed.dreamerContext).toBeDefined();
    expect(parsed.dreamerContext.badDecision).toBe('v2 bad decision text');
    expect(parsed.dreamerContext.betterDecision).toBe('v2 better decision text');
    expect(parsed.dreamerContext.rationale).toBe('v2 rationale text');
    // Optional fields not provided → should be undefined (not serialized as null)
    expect(parsed.dreamerContext.riskLevel).toBeUndefined();
    expect(parsed.dreamerContext.strategicPerspective).toBeUndefined();
  });
});

describe('PRI-509: Artificer repair feedback passthrough', () => {
  const builder = new ArtificerPromptBuilder();

  // Slice 1: repairFeedback serialized into prompt message when present
  it('includes repairFeedback in prompt message when provided (with requiredChanges text)', () => {
    const { message, promptInput } = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'task-pri-509',
      contextHash: 'ctx-pri-509',
      sourceScribeArtifactId: 'scribe-pri-509',
      scribeArtifact: {},
      repairFeedback: 'Previous attempt scored 0.65 (needs_revision). Evaluator concerns:\n1. code quality\nRequired changes:\n1. add input validation\nFix ALL the above.',
    });
    const parsed = JSON.parse(message);
    expect(parsed.repairFeedback).toBeDefined();
    expect(parsed.repairFeedback).toContain('add input validation');
    expect(parsed.repairFeedback).toContain('needs_revision');
    expect(promptInput.repairFeedback).toBeDefined();
  });

  // Slice 2: backward compatibility — repairFeedback absent → not in prompt
  it('does not include repairFeedback in prompt when not provided (backward compatible)', () => {
    const { message, promptInput } = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'task-pri-509-no-repair',
      contextHash: 'ctx-pri-509',
      sourceScribeArtifactId: 'scribe-pri-509',
      scribeArtifact: {},
    });
    const parsed = JSON.parse(message);
    expect(parsed.repairFeedback).toBeUndefined();
    expect(promptInput.repairFeedback).toBeUndefined();
  });

  // Slice 3: empty/whitespace repairFeedback treated as absent (backward compatible)
  it('does not include repairFeedback when empty or whitespace-only', () => {
    const { message: msgEmpty } = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'task-pri-509-empty',
      contextHash: 'ctx-pri-509',
      sourceScribeArtifactId: 'scribe-pri-509',
      scribeArtifact: {},
      repairFeedback: '',
    });
    expect(JSON.parse(msgEmpty).repairFeedback).toBeUndefined();

    const { message: msgWs } = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'task-pri-509-ws',
      contextHash: 'ctx-pri-509',
      sourceScribeArtifactId: 'scribe-pri-509',
      scribeArtifact: {},
      repairFeedback: '   \n\t  ',
    });
    expect(JSON.parse(msgWs).repairFeedback).toBeUndefined();
  });

  // Slice 4: protocol instruction advertises repair feedback semantics
  it('instruction includes REPAIR FEEDBACK section hinting at prior attempt', () => {
    // PRI-509: artificer must know this is a RETRY round when repairFeedback is present,
    // so it addresses each requiredChange instead of regenerating blind.
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toMatch(/REPAIR FEEDBACK|prior attempt/i);
  });
});

describe('BUG-3 (PRI-442): artificer prompt propose_correction consistency', () => {
  const builder = new ArtificerPromptBuilder();

  it('shared CONSTRAINTS must not mention propose_correction as an expected negative case', () => {
    // The shared CONSTRAINTS section (ARTIFICER_PROTOCOL_INSTRUCTION) must NOT
    // tell the LLM to emit propose_correction — it contradicts the V2 ban and
    // causes schema validation failures (ERR-009).
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).not.toMatch(/negative block\/propose_correction case/);
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).not.toMatch(/propose_correction cases MUST include/);
  });

  it('shared CONSTRAINTS forbids propose_correction, requireApproval, and auto_correct', () => {
    // The "only allow/block" constraint must appear in the shared section so
    // both v1 and v2 prompts are consistent.
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toMatch(/expectedDecision MUST be only.*allow.*block/i);
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toMatch(/do not.*propose_correction/i);
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toMatch(/do not.*requireApproval/i);
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toMatch(/do not.*auto_correct/i);
  });

  it('v1 prompt forbids propose_correction (no contradiction with v2)', () => {
    const result = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'bug3-v1',
      contextHash: 'ctx-bug3',
      sourceScribeArtifactId: 'scribe-bug3',
      scribeArtifact: {},
    });
    expect(result.systemPrompt).toMatch(/do not.*propose_correction/i);
    expect(result.systemPrompt).not.toMatch(/negative block\/propose_correction case/);
  });

  it('v2 prompt still forbids propose_correction (constraint preserved after move)', () => {
    const result = builder.buildPrompt({
      contextMode: 'v2',
      taskId: 'bug3-v2',
      contextHash: 'ctx-bug3',
      sourceScribeArtifactId: 'scribe-bug3',
      scribeArtifact: {},
      behaviorExamplePack: validBehaviorExamplePack,
    });
    expect(result.systemPrompt).toMatch(/do not.*propose_correction/i);
    expect(result.systemPrompt).toMatch(/do not.*requireApproval/i);
    expect(result.systemPrompt).toMatch(/do not.*auto_correct/i);
  });
});
