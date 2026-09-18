import { describe, it, expect } from 'vitest';
import { ScribePromptBuilder, buildScribeProtocolInstruction, SCRIBE_PROMPT_CONTRACT_VERSION } from '../scribe-prompt-builder.js';

describe('ScribePromptBuilder (PRI-109)', () => {
  const builder = new ScribePromptBuilder();

  const defaultInput = {
    taskId: 'scribe-001',
    contextHash: 'ctx-abc',
    sourcePhilosopherArtifactId: 'pi-art-phil-001',
    philosopherArtifact: {
      taskId: 'phil-001',
      thesis: 'Test thesis',
      principleCandidate: { title: 'T', rationale: 'R', scope: 'S', confidence: 0.9 },
    },
  };

  it('buildPrompt returns JSON message containing sourcePhilosopherArtifactId', () => {
    const { message } = builder.buildPrompt(defaultInput);
    const parsed = JSON.parse(message);
    expect(parsed.sourcePhilosopherArtifactId).toBe('pi-art-phil-001');
  });

  it('instruction says copy sourcePhilosopherArtifactId exactly', () => {
    const instruction = buildScribeProtocolInstruction();
    expect(instruction).toContain('sourcePhilosopherArtifactId MUST be copied exactly from input.sourcePhilosopherArtifactId');
  });

  it('instruction says Output ONLY valid JSON', () => {
    const instruction = buildScribeProtocolInstruction();
    expect(instruction).toContain('Output ONLY valid JSON');
  });

  it('instruction says no markdown, no code fences', () => {
    const instruction = buildScribeProtocolInstruction();
    expect(instruction).toContain('no markdown');
    expect(instruction).toContain('no code fences');
  });

  it('instruction specifies confidence must be number 0..1', () => {
    const instruction = buildScribeProtocolInstruction();
    expect(instruction).toContain('confidence MUST be a number between 0.0 and 1.0');
    expect(instruction).toContain('NOT a string');
  });

  it('systemPrompt carries the scribe instruction (PRI-633)', () => {
    const { systemPrompt } = builder.buildPrompt(defaultInput);
    const expectedInstruction = buildScribeProtocolInstruction();
    expect(systemPrompt).toBe(expectedInstruction);
  });

  it('promptInput includes promptContractVersion', () => {
    const { promptInput } = builder.buildPrompt(defaultInput);
    expect(promptInput.promptContractVersion).toBe(SCRIBE_PROMPT_CONTRACT_VERSION);
  });

  it('promptInput preserves taskId and contextHash', () => {
    const { promptInput } = builder.buildPrompt(defaultInput);
    expect(promptInput.taskId).toBe('scribe-001');
    expect(promptInput.contextHash).toBe('ctx-abc');
  });

  it('promptInput preserves philosopherArtifact', () => {
    const { promptInput } = builder.buildPrompt(defaultInput);
    expect(promptInput.philosopherArtifact).toEqual(defaultInput.philosopherArtifact);
  });

  it('message is valid JSON string', () => {
    const { message } = builder.buildPrompt(defaultInput);
    expect(() => JSON.parse(message)).not.toThrow();
  });

  // ── PRI-816 (R-01): authoritative sourceDreamerArtifactId in prompt input ──

  it('promptInput carries sourceDreamerArtifactId when provided (PRI-816)', () => {
    const { promptInput, message } = builder.buildPrompt({
      ...defaultInput,
      sourceDreamerArtifactId: 'pi-art-dreamer-001',
    });
    expect(promptInput.sourceDreamerArtifactId).toBe('pi-art-dreamer-001');
    const parsed = JSON.parse(message) as { sourceDreamerArtifactId?: string };
    expect(parsed.sourceDreamerArtifactId).toBe('pi-art-dreamer-001');
  });

  it('promptInput omits sourceDreamerArtifactId when not provided (pre-PRI-508 compat)', () => {
    const { promptInput, message } = builder.buildPrompt(defaultInput);
    expect(Object.hasOwn(promptInput, 'sourceDreamerArtifactId')).toBe(false);
    const parsed = JSON.parse(message) as { sourceDreamerArtifactId?: string };
    expect(Object.hasOwn(parsed, 'sourceDreamerArtifactId')).toBe(false);
  });

  it('instruction tells scribe to copy sourceTrace.dreamerArtifactId from input (PRI-816)', () => {
    const instruction = buildScribeProtocolInstruction();
    expect(instruction).toContain('MUST be copied exactly from input.sourceDreamerArtifactId');
    // The old "scrape from philosopher artifact" instruction must be gone.
    expect(instruction).not.toContain('from philosopher artifact if available');
  });
});

// ── PRI-838: formation evidence in the scribe prompt contract ───────────────

describe('ScribePromptBuilder — PRI-838 formation evidence', () => {
  const builder = new ScribePromptBuilder();

  const baseInput = {
    taskId: 'scribe-838',
    contextHash: 'ctx-838',
    sourcePhilosopherArtifactId: 'pi-art-phil-838',
    sourceDreamerArtifactId: 'pi-art-dreamer-838',
    philosopherArtifact: { taskId: 'phil-838', thesis: 'T', sourceDreamerArtifactId: 'pi-art-dreamer-838' },
  };

  const formationContext = {
    version: 'formation-context.v1',
    dreamerProposals: [
      {
        candidateIndex: 1,
        priorityRank: 1,
        badDecision: 'agent guessed the contract from examples',
        betterDecision: 'read the authoritative contract first',
        rationale: 'guessing drifts silently',
        confidence: 0.9,
        riskLevel: 'low',
        strategicPerspective: 'evidence-first',
      },
    ],
    dreamerContextRefs: ['pi-art-pain-838'],
    sourceDiagnosis: {
      artifactId: 'pi-art-diag-838',
      taskId: 'diag-router-838',
      stage: 'diag_router',
      rootCause: 'Assumption: contract inferred from examples',
      summary: 'contract guessed',
      violatedPrinciples: [{ principleId: 'T-03', title: 'Evidence first', rationale: 'read, do not guess' }],
      evidence: [{ sourceRef: 'trajectory://s-1/t-4', note: 'wrote config without reading contract' }],
      recommendations: ['[principle] read the authoritative contract'],
      confidence: 0.8,
      omittedFields: [],
    },
    provenance: {
      sourceDreamerArtifactId: 'pi-art-dreamer-838',
      sourceDreamerTaskId: 'dreamer-838',
      sourceDiagnosisArtifactId: 'pi-art-diag-838',
      sourceDiagnosisTaskId: 'diag-router-838',
      sourcePainId: 'pain-838',
      lineageArtifactIds: ['pi-art-diag-838'],
    },
    truncationNotes: [],
  };

  it('promptContractVersion was bumped to v4', () => {
    expect(SCRIBE_PROMPT_CONTRACT_VERSION).toBe('scribe-output-v1.prompt.v4');
  });

  it('carries formationContext in the payload when provided', () => {
    const { promptInput, message } = builder.buildPrompt({ ...baseInput, formationContext });
    expect(promptInput.formationContext).toBeDefined();
    const parsed = JSON.parse(message) as { formationContext?: typeof formationContext };
    expect(parsed.formationContext?.dreamerProposals).toHaveLength(1);
    expect(parsed.formationContext?.sourceDiagnosis?.rootCause).toContain('Assumption:');
    expect(parsed.formationContext?.provenance.sourcePainId).toBe('pain-838');
  });

  it('appends the formation-evidence addendum to the system prompt when provided', () => {
    const { systemPrompt } = builder.buildPrompt({ ...baseInput, formationContext });
    expect(systemPrompt).toContain('ADDITIONAL CONTEXT (formation evidence recovery)');
    expect(systemPrompt).toContain('formationContext.sourceDiagnosis');
    expect(systemPrompt).toContain('formationContext.dreamerProposals');
    expect(systemPrompt).toContain('formationContext.provenance');
  });

  it('reuses the frozen PRI-815 candidate-priority contract verbatim', () => {
    const { systemPrompt } = builder.buildPrompt({ ...baseInput, formationContext });
    expect(systemPrompt).toContain('CANDIDATE PRIORITY (must obey):');
    expect(systemPrompt).toContain(
      'source intent (sourceDiagnosis) > critique conclusions (philosopherArtifact) > proposals as candidate evidence (dreamerProposals).',
    );
    expect(systemPrompt).toContain('do NOT revive a proposal the critique explicitly rejected');
    expect(systemPrompt).toContain('Do NOT merge mutually exclusive proposals into one principle.');
    expect(systemPrompt).toContain('Longer output is not better');
  });

  it('omits formationContext entirely when absent (pre-PRI-838 compat)', () => {
    const { promptInput, message, systemPrompt } = builder.buildPrompt(baseInput);
    expect(Object.hasOwn(promptInput, 'formationContext')).toBe(false);
    const parsed = JSON.parse(message) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'formationContext')).toBe(false);
    expect(systemPrompt).not.toContain('formation evidence recovery');
  });

  it('degradation instruction is present for the absent-diagnosis case', () => {
    // Case 2/3: the model must be told to degrade rather than invent the intent.
    const { systemPrompt } = builder.buildPrompt({ ...baseInput, formationContext });
    expect(systemPrompt).toContain('the source intent is UNAVAILABLE');
  });

  it('buildScribeProtocolInstruction gates the addendum on formationEvidence', () => {
    expect(buildScribeProtocolInstruction({ formationEvidence: true })).toContain('CANDIDATE PRIORITY');
    expect(buildScribeProtocolInstruction({ formationEvidence: false })).not.toContain('CANDIDATE PRIORITY');
    expect(buildScribeProtocolInstruction()).not.toContain('CANDIDATE PRIORITY');
  });

  it('does not leak formationEvidence into the core axiom options', () => {
    // Regression guard: the option must be destructured out, not forwarded.
    const withFlag = buildScribeProtocolInstruction({ formationEvidence: true, coreGrounding: true });
    const withoutFlag = buildScribeProtocolInstruction({ coreGrounding: true });
    expect(withFlag.startsWith(withoutFlag)).toBe(true);
  });
});
