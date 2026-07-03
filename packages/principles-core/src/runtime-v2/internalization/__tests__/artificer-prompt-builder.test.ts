import { describe, it, expect } from 'vitest';
import {
  ArtificerPromptBuilder,
  ARTIFICER_PROTOCOL_INSTRUCTION,
  ARTIFICER_PROMPT_CONTRACT_VERSION,
} from '../artificer-prompt-builder.js';
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
    // PRI-484 — bumped from v1 to v2 to signal the RuleCode context surface
    // is part of the contract the model must obey.
    expect(ARTIFICER_PROMPT_CONTRACT_VERSION).toBe('artificer-output-v2.prompt.v2');
  });

  it('instruction requires implementationSummary as a non-empty string', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('implementationSummary MUST be a non-empty string');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).not.toContain('"implementationPlan"');
  });

  it('message is valid JSON containing promptInput', () => {
    const { message } = builder.buildPrompt(input);
    const parsed = JSON.parse(message);
    expect(parsed.taskId).toBe(input.taskId);
    expect(parsed.contextHash).toBe(input.contextHash);
    expect(parsed.sourceScribeArtifactId).toBe(input.sourceScribeArtifactId);
    expect(parsed.artificerInstruction).toContain(ARTIFICER_PROTOCOL_INSTRUCTION);
    expect(parsed.promptContractVersion).toBe(ARTIFICER_PROMPT_CONTRACT_VERSION);
  });

  it('artificerInstruction is included in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.artificerInstruction).toContain(ARTIFICER_PROTOCOL_INSTRUCTION);
  });
});

describe('PRI-484 Artificer prompt context modes', () => {
  // Red phase: assertions covering the rewrite required by the
  // 2026-06-27 RuleCode context vision design §7.3.

  it('allows inspecting input.context (v2 surface)', () => {
    const { promptInput } = new ArtificerPromptBuilder().buildPrompt({ contextMode: 'v1', taskId: 'task', contextHash: 'hash', sourceScribeArtifactId: 'scribe', scribeArtifact: {} });
    expect(promptInput.artificerInstruction).toMatch(/must not.*input\.context/i);
  });

  it('requires allow when context is missing or unavailable', () => {
    // P2 fix (CodeRabbit PR2 Comment 4): assert against the v2 prompt built by
    // the prompt builder (promptInput.artificerInstruction), not the bare
    // ARTIFICER_PROTOCOL_INSTRUCTION constant. The v2 contract is appended via
    // V2_CONTEXT_INSTRUCTION; asserting on the bare constant would not verify
    // that the contract actually flows through the builder.
    const { promptInput } = new ArtificerPromptBuilder().buildPrompt({
      contextMode: 'v2',
      taskId: 'task',
      contextHash: 'hash',
      sourceScribeArtifactId: 'scribe',
      scribeArtifact: {},
      behaviorExamplePack: validBehaviorExamplePack,
    });
    expect(promptInput.artificerInstruction).toContain('unavailable');
    expect(promptInput.artificerInstruction).toMatch(/MUST.*allow.*matched.*false/i);
  });

  it('requires preferring canonicalKind / facts over raw history.calls', () => {
    const { promptInput } = new ArtificerPromptBuilder().buildPrompt({
      contextMode: 'v2',
      taskId: 'task',
      contextHash: 'hash',
      sourceScribeArtifactId: 'scribe',
      scribeArtifact: {},
      behaviorExamplePack: validBehaviorExamplePack,
    });
    expect(promptInput.artificerInstruction).toContain('facts');
    expect(promptInput.artificerInstruction).toContain('canonicalKind');
    expect(promptInput.artificerInstruction).toContain('Prefer');
  });

  it('forbids inferring "not done" from an empty calls array', () => {
    const { promptInput } = new ArtificerPromptBuilder().buildPrompt({
      contextMode: 'v2',
      taskId: 'task',
      contextHash: 'hash',
      sourceScribeArtifactId: 'scribe',
      scribeArtifact: {},
      behaviorExamplePack: validBehaviorExamplePack,
    });
    expect(promptInput.artificerInstruction).toContain('not done');
    expect(promptInput.artificerInstruction).toContain('empty');
  });

  it('declares the v2 contract version bump v1 -> v2', () => {
    expect(ARTIFICER_PROMPT_CONTRACT_VERSION).toBe('artificer-output-v2.prompt.v2');
  });

  it('still references input.action for v1 compatibility', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('input.action');
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
    expect(result.promptInput.artificerInstruction).toMatch(/do not.*propose_correction/i);
    expect(result.promptInput.artificerInstruction).not.toMatch(/negative block\/propose_correction case/);
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
    expect(result.promptInput.artificerInstruction).toMatch(/do not.*propose_correction/i);
    expect(result.promptInput.artificerInstruction).toMatch(/do not.*requireApproval/i);
    expect(result.promptInput.artificerInstruction).toMatch(/do not.*auto_correct/i);
  });
});
