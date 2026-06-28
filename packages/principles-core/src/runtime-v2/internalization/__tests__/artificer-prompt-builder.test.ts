import { describe, it, expect } from 'vitest';
import {
  ArtificerPromptBuilder,
  ARTIFICER_PROTOCOL_INSTRUCTION,
  ARTIFICER_PROMPT_CONTRACT_VERSION,
} from '../artificer-prompt-builder.js';

describe('ArtificerPromptBuilder', () => {
  const builder = new ArtificerPromptBuilder();

  const input = {
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
    expect(parsed.artificerInstruction).toBe(ARTIFICER_PROTOCOL_INSTRUCTION);
    expect(parsed.promptContractVersion).toBe(ARTIFICER_PROMPT_CONTRACT_VERSION);
  });

  it('artificerInstruction is included in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.artificerInstruction).toBe(ARTIFICER_PROTOCOL_INSTRUCTION);
  });
});

describe('PRI-484 ARTIFICER_PROTOCOL_INSTRUCTION — v2 context section', () => {
  // Red phase: assertions covering the rewrite required by the
  // 2026-06-27 RuleCode context vision design §7.3.

  it('allows inspecting input.context (v2 surface)', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toMatch(/input\.context/i);
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('inspect input.context');
  });

  it('requires allow when context is missing or unavailable', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('unavailable');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toMatch(/MUST.*allow.*matched.*false/i);
  });

  it('requires preferring canonicalKind / facts over raw history.calls', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('facts');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('canonicalKind');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('Prefer');
  });

  it('forbids inferring "not done" from an empty calls array', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('not done');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('empty');
  });

  it('declares the v2 contract version bump v1 -> v2', () => {
    expect(ARTIFICER_PROMPT_CONTRACT_VERSION).toBe('artificer-output-v2.prompt.v2');
  });

  it('still references input.action for v1 compatibility', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('input.action');
  });

  it('mentions requiresContextVersion when declaring v2 rules', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('requiresContextVersion');
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
