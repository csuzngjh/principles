/**
 * Shared peer prompt-builder contract suite (PRI-888, Test Diet Phase 2.2-A).
 *
 * Consolidates the template assertions that were copy-pasted across the six
 * peer prompt-builder test files (dreamer / philosopher / scribe / evaluator /
 * rollout-reviewer / artificer). One parameterized suite now expresses the
 * mechanical contract every builder must satisfy; per-case probe data keeps
 * the original assertion strength (exact strings and regexes are lifted
 * verbatim from the originating its).
 *
 * What deliberately stays OUT of this suite (in the per-builder files):
 *   - PRI-pinned regression probes (PRI-862, PRI-644, PRI-816, PRI-838,
 *     PRI-741/780, sourceTrace copy pins, contract-version exact pins);
 *   - systemPrompt composition comparators (toBe/toContain differ per builder);
 *   - builder-specific payload contracts (scribe PRI-816 omission semantics,
 *     evaluator example-shape parse, artificer composed-section probes).
 *
 * Provenance of each template is documented in
 * docs/testing/internalization-test-consolidation-report.md (Test Diet
 * Phase 2.2 investigation).
 */
import { describe, it, expect } from 'vitest';
import { DreamerPromptBuilder } from '../dreamer-prompt-builder.js';
import { PhilosopherPromptBuilder } from '../philosopher-prompt-builder.js';
import { ScribePromptBuilder, SCRIBE_PROMPT_CONTRACT_VERSION } from '../scribe-prompt-builder.js';
import { EvaluatorPromptBuilder, EVALUATOR_PROMPT_CONTRACT_VERSION } from '../evaluator-prompt-builder.js';
import {
  RolloutReviewerPromptBuilder,
  ROLLOUT_REVIEWER_PROMPT_CONTRACT_VERSION,
} from '../rollout-reviewer-prompt-builder.js';
import { ArtificerPromptBuilder, ARTIFICER_PROMPT_CONTRACT_VERSION } from '../artificer-prompt-builder.js';
import type { BehaviorExamplePack } from '../behavior-example-pack.js';

interface PeerBuilderCase {
  id: string;
  makeBuilder: () => { buildPrompt(input: Record<string, unknown>): PromptBuildResultLike };
  makeInput: () => Record<string, unknown>;
  taskId: string;
  contextHash: string;
  /** Key of the upstream artifact field that must deep-equal the input value. */
  upstreamArtifactKey: string;
  /** RolloutReviewer passes the artifact by reference — original test asserted identity (toBe). */
  identityPassthrough?: boolean;
  /** Source lineage id field; null when the builder has none (dreamer). */
  sourceIdKey: string | null;
  sourceId: string;
  /** PRI-633: the builder must not smuggle its instruction into the JSON payload. */
  instructionKey: string;
  /** Exact JSON-only directive strings that must appear in systemPrompt. */
  jsonOnlyIncludes: string[];
  /** Regex-flavored JSON-only directives (dreamer/philosopher probe style). */
  jsonOnlyRegexes: RegExp[];
  /** Confidence numeric-range directive probes; empty when the builder has no such directive. */
  confidenceIncludes: string[];
  confidenceRegexes: RegExp[];
  /** Copy-the-source-id directive probes; empty when the builder has none. */
  copyDirectiveIncludes: string[];
  /** Builders that expose promptContractVersion in the payload. */
  contractVersion?: () => string;
}

interface PromptBuildResultLike {
  message: string;
  promptInput: Record<string, unknown>;
  systemPrompt: string;
}

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

const CASES: PeerBuilderCase[] = [
  {
    id: 'DreamerPromptBuilder',
    makeBuilder: () => new DreamerPromptBuilder() as never,
    makeInput: () => ({
      taskId: 'task-dreamer-001',
      contextHash: 'ctx-abc123',
      contextRefs: ['ref-diag-001', 'ref-artifact-001'],
      predecessorOutput: {
        valid: true,
        diagnosisId: 'diag-001',
        taskId: 'task-diag-001',
        summary: 'Agent failed to validate input',
        rootCause: 'Design: missing input validation gate',
        violatedPrinciples: [{ rationale: 'No pre-condition check' }],
        evidence: [{ sourceRef: 'ref-1', note: 'Missing validation' }],
        recommendations: [
          { kind: 'rule', description: 'Add input validation', triggerPattern: 'user_input', action: 'validate before processing' },
        ],
        confidence: 0.85,
        ambiguityNotes: [],
      },
    }),
    taskId: 'task-dreamer-001',
    contextHash: 'ctx-abc123',
    upstreamArtifactKey: 'predecessorOutput',
    sourceIdKey: null,
    sourceId: '',
    instructionKey: 'dreamerInstruction',
    jsonOnlyIncludes: ['CRITICAL', 'ONLY valid JSON', 'no code fences', 'no prose'],
    jsonOnlyRegexes: [/only.*JSON|JSON.*only|pure JSON/i, /no markdown/i],
    confidenceIncludes: [],
    confidenceRegexes: [/confidence.*number/i, /0.*1/],
    copyDirectiveIncludes: [],
  },
  {
    id: 'PhilosopherPromptBuilder',
    makeBuilder: () => new PhilosopherPromptBuilder() as never,
    makeInput: () => ({
      taskId: 'task-philosopher-001',
      contextHash: 'ctx-def456',
      dreamerArtifact: {
        valid: true,
        taskId: 'task-dreamer-001',
        candidates: [
          {
            candidateIndex: 0,
            badDecision: 'Skipped input validation',
            betterDecision: 'Add pre-condition check before processing',
            rationale: 'Validation prevents downstream errors',
            confidence: 0.85,
            riskLevel: 'low',
            strategicPerspective: 'defensive_programming',
          },
        ],
        contextRefs: ['ref-diag-001'],
        generatedAt: '2026-05-01T00:00:00Z',
      },
      sourceDreamerArtifactId: 'pi-art-dreamer-001-run-001',
    }),
    taskId: 'task-philosopher-001',
    contextHash: 'ctx-def456',
    upstreamArtifactKey: 'dreamerArtifact',
    sourceIdKey: 'sourceDreamerArtifactId',
    sourceId: 'pi-art-dreamer-001-run-001',
    instructionKey: 'philosopherInstruction',
    jsonOnlyIncludes: [],
    jsonOnlyRegexes: [/only.*JSON|JSON.*only|pure JSON/i, /no markdown/i],
    confidenceIncludes: [],
    confidenceRegexes: [/confidence.*number/i, /0.*1/],
    copyDirectiveIncludes: ['input.sourceDreamerArtifactId'],
  },
  {
    id: 'ScribePromptBuilder',
    makeBuilder: () => new ScribePromptBuilder() as never,
    makeInput: () => ({
      taskId: 'scribe-001',
      contextHash: 'ctx-abc',
      sourcePhilosopherArtifactId: 'pi-art-phil-001',
      philosopherArtifact: {
        taskId: 'phil-001',
        thesis: 'Test thesis',
        principleCandidate: { title: 'T', rationale: 'R', scope: 'S', confidence: 0.9 },
      },
    }),
    taskId: 'scribe-001',
    contextHash: 'ctx-abc',
    upstreamArtifactKey: 'philosopherArtifact',
    sourceIdKey: 'sourcePhilosopherArtifactId',
    sourceId: 'pi-art-phil-001',
    instructionKey: 'scribeInstruction',
    jsonOnlyIncludes: ['Output ONLY valid JSON', 'no markdown', 'no code fences'],
    jsonOnlyRegexes: [],
    confidenceIncludes: ['confidence MUST be a number between 0.0 and 1.0', 'NOT a string'],
    confidenceRegexes: [],
    copyDirectiveIncludes: [
      'sourcePhilosopherArtifactId MUST be copied exactly from input.sourcePhilosopherArtifactId',
    ],
    contractVersion: () => SCRIBE_PROMPT_CONTRACT_VERSION,
  },
  {
    id: 'EvaluatorPromptBuilder',
    makeBuilder: () => new EvaluatorPromptBuilder() as never,
    makeInput: () => ({
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
    }),
    taskId: 'evaluator-task-001',
    contextHash: 'ctx-abc123',
    upstreamArtifactKey: 'artificerArtifact',
    sourceIdKey: 'sourceArtificerArtifactId',
    sourceId: 'pi-art-artificer-001',
    instructionKey: 'evaluatorInstruction',
    jsonOnlyIncludes: ['ONLY valid JSON', 'no markdown', 'no code fences'],
    jsonOnlyRegexes: [],
    confidenceIncludes: [],
    confidenceRegexes: [],
    copyDirectiveIncludes: [
      'sourceArtificerArtifactId MUST be copied exactly from input.sourceArtificerArtifactId',
    ],
    contractVersion: () => EVALUATOR_PROMPT_CONTRACT_VERSION,
  },
  {
    id: 'RolloutReviewerPromptBuilder',
    makeBuilder: () => new RolloutReviewerPromptBuilder() as never,
    makeInput: () => ({
      taskId: 'task-rr-001',
      contextHash: 'ctx-abc123',
      sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
      evaluatorArtifact: { taskId: 'eval-001', evaluation: { decision: 'approved' } },
    }),
    taskId: 'task-rr-001',
    contextHash: 'ctx-abc123',
    upstreamArtifactKey: 'evaluatorArtifact',
    identityPassthrough: true,
    sourceIdKey: 'sourceEvaluatorArtifactId',
    sourceId: 'pi-art-evaluator-001',
    instructionKey: 'rolloutReviewerInstruction',
    jsonOnlyIncludes: ['CRITICAL', 'ONLY valid JSON', 'no markdown', 'no code fences'],
    jsonOnlyRegexes: [],
    confidenceIncludes: [],
    confidenceRegexes: [],
    copyDirectiveIncludes: [],
    contractVersion: () => ROLLOUT_REVIEWER_PROMPT_CONTRACT_VERSION,
  },
  {
    id: 'ArtificerPromptBuilder',
    makeBuilder: () => new ArtificerPromptBuilder() as never,
    makeInput: () => ({
      behaviorExamplePack: validBehaviorExamplePack,
      taskId: 'artificer-task-001',
      contextHash: 'ctx-abc123',
      sourceScribeArtifactId: 'pi-art-scribe-001',
      scribeArtifact: {
        taskId: 'scribe-task-001',
        principleDraft: { title: 'Test', statement: 'S', rationale: 'R', applicability: [], antiPatterns: [], confidence: 0.9 },
      },
    }),
    taskId: 'artificer-task-001',
    contextHash: 'ctx-abc123',
    upstreamArtifactKey: 'scribeArtifact',
    sourceIdKey: 'sourceScribeArtifactId',
    sourceId: 'pi-art-scribe-001',
    instructionKey: 'artificerInstruction',
    jsonOnlyIncludes: ['ONLY valid JSON', 'no markdown', 'no code fences'],
    jsonOnlyRegexes: [],
    confidenceIncludes: [],
    confidenceRegexes: [],
    copyDirectiveIncludes: [
      'sourceScribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId',
    ],
    contractVersion: () => ARTIFICER_PROMPT_CONTRACT_VERSION,
  },
];

describe.each(CASES)('$id shared prompt-builder contract (PRI-888)', (c) => {
  it('returns a PromptBuildResult with message, promptInput and systemPrompt', () => {
    const result = c.makeBuilder().buildPrompt(c.makeInput());

    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('promptInput');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.systemPrompt.length).toBeGreaterThan(0);
  });

  it('maps taskId from input to top-level promptInput.taskId', () => {
    const { promptInput } = c.makeBuilder().buildPrompt(c.makeInput());
    expect(promptInput.taskId).toBe(c.taskId);
  });

  it('maps contextHash from input to top-level promptInput.contextHash', () => {
    const { promptInput } = c.makeBuilder().buildPrompt(c.makeInput());
    expect(promptInput.contextHash).toBe(c.contextHash);
  });

  it('message field is valid JSON and parses to an object carrying taskId/contextHash at top level', () => {
    const { message } = c.makeBuilder().buildPrompt(c.makeInput());

    expect(() => JSON.parse(message)).not.toThrow();
    const parsed = JSON.parse(message) as Record<string, unknown>;
    expect(typeof parsed).toBe('object');
    expect(parsed.taskId).toBe(c.taskId);
    expect(parsed.contextHash).toBe(c.contextHash);
  });

  it(`maps ${c.upstreamArtifactKey} artifact from input to promptInput unchanged`, () => {
    const input = c.makeInput();
    const { promptInput } = c.makeBuilder().buildPrompt(input);
    const artifact = input[c.upstreamArtifactKey];
    if (c.identityPassthrough) {
      expect(promptInput[c.upstreamArtifactKey]).toBe(artifact);
    } else {
      expect(promptInput[c.upstreamArtifactKey]).toEqual(artifact);
    }
  });

  if (c.sourceIdKey !== null) {
    const sourceIdKey = c.sourceIdKey;
    const sourceId = c.sourceId;
    it(`carries ${sourceIdKey} in promptInput and at the top level of the JSON message`, () => {
      const { promptInput, message } = c.makeBuilder().buildPrompt(c.makeInput());
      expect(promptInput[sourceIdKey]).toBe(sourceId);
      const parsed = JSON.parse(message) as Record<string, unknown>;
      expect(parsed[sourceIdKey]).toBe(sourceId);
    });
  }

  it(`PRI-633: the ${c.instructionKey} instruction left the payload`, () => {
    const { message } = c.makeBuilder().buildPrompt(c.makeInput());
    const parsed = JSON.parse(message) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, c.instructionKey)).toBe(false);
  });

  it('systemPrompt carries the JSON-only output directive (per-builder probes)', () => {
    const { systemPrompt } = c.makeBuilder().buildPrompt(c.makeInput());
    for (const probe of c.jsonOnlyIncludes) {
      expect(systemPrompt).toContain(probe);
    }
    for (const probe of c.jsonOnlyRegexes) {
      expect(systemPrompt).toMatch(probe);
    }
  });

  if (c.confidenceIncludes.length > 0 || c.confidenceRegexes.length > 0) {
    it('instruction specifies confidence must be a number between 0 and 1 (per-builder probes)', () => {
      const { systemPrompt } = c.makeBuilder().buildPrompt(c.makeInput());
      for (const probe of c.confidenceIncludes) {
        expect(systemPrompt).toContain(probe);
      }
      for (const probe of c.confidenceRegexes) {
        expect(systemPrompt).toMatch(probe);
      }
    });
  }

  if (c.copyDirectiveIncludes.length > 0) {
    it('instruction tells the LLM to copy the source artifact id exactly (per-builder probes)', () => {
      const { systemPrompt } = c.makeBuilder().buildPrompt(c.makeInput());
      for (const probe of c.copyDirectiveIncludes) {
        expect(systemPrompt).toContain(probe);
      }
    });
  }

  if (c.contractVersion) {
    const contractVersion = c.contractVersion;
    it('promptInput carries promptContractVersion matching the exported constant', () => {
      const { promptInput } = c.makeBuilder().buildPrompt(c.makeInput());
      expect(promptInput.promptContractVersion).toBe(contractVersion());
    });
  }

  it('buildPrompt() is a pure function — same input produces same output', () => {
    const builder = c.makeBuilder();
    const input = c.makeInput();
    const result1 = builder.buildPrompt(input);
    const result2 = builder.buildPrompt(input);

    expect(result1.message).toBe(result2.message);
    expect(result1.promptInput).toEqual(result2.promptInput);
  });
});
