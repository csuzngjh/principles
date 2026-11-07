import type { OutputLanguage } from '../language-directive.js';
import { buildLanguageDirective } from '../language-directive.js';

export interface RolloutReviewerPromptBuilderInput {
  taskId: string;
  contextHash: string;
  /** Code-chain review source (PRI-720: required in code_chain mode). */
  sourceEvaluatorArtifactId?: string;
  evaluatorArtifact?: unknown;
  /** PRI-720: defaults to the legacy code_chain review. */
  reviewMode?: 'principle_semantic' | 'code_chain';
  /** Principle semantic review source — the exact scribe principle artifact id. */
  sourceScribeArtifactId?: string;
  /** Principle semantic review payload: scribe artifact contentJson (parsed). */
  scribeArtifact?: unknown;
  /**
   * Owner's preferred language for review fields (PRI-714). When provided,
   * the rollout reviewer instruction carries a language directive so summary /
   * requiredChanges / rolloutRisks / safetyChecks / risks are written in the
   * owner's language. Undefined = no directive (backward compatible).
   */
  outputLanguage?: OutputLanguage;
}

export interface RolloutReviewerPromptInput {
  taskId: string;
  contextHash: string;
  reviewMode?: 'principle_semantic' | 'code_chain';
  sourceEvaluatorArtifactId?: string;
  evaluatorArtifact?: unknown;
  sourceScribeArtifactId?: string;
  scribeArtifact?: unknown;
  promptContractVersion: string;
}

export interface RolloutReviewerPromptBuildResult {
  readonly message: string;
  readonly promptInput: RolloutReviewerPromptInput;
  /**
   * PRI-633: base-layer system prompt (role + protocol). Previously embedded
   * in the payload as `rolloutReviewerInstruction`; now delivered via the
   * system channel by the runtime adapter.
   */
  readonly systemPrompt: string;
}

export const ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION = `You are a Rollout Reviewer agent in a principle internalization pipeline. Your role is to review the Evaluator's assessment and produce a rollout review decision with safety checks and risk analysis.

PROTOCOL:
1. Review the evaluatorArtifact to understand the evaluation decision, score, and feedback
2. Assess whether the evaluated plan is safe to proceed with rollout
3. Produce a decision: approve_rollout (safe to proceed), needs_revision (issues found but salvageable), or reject (fundamental safety or quality concerns)
4. Provide a confidence score from 0.0 to 1.0 reflecting your assessment certainty
5. List specific required changes if any
6. Identify rollout-specific risks
7. List safety checks that should be performed before/during rollout
8. Preserve the lineage trace from evaluator, artificer, scribe, philosopher, and dreamer artifacts
9. Identify risks associated with this review

CRITICAL: Your ENTIRE response must be ONLY the JSON object below. Do NOT include any text before or after the JSON. Do NOT wrap the JSON in markdown code fences. Do NOT add explanatory prose. Output the raw JSON object and nothing else.

COMPLETE EXAMPLE OUTPUT (follow this exact structure):
{"taskId":"task-123","sourceEvaluatorArtifactId":"pi-art-evaluator-001","review":{"decision":"approve_rollout","summary":"The evaluation is thorough and the plan is safe to proceed with rollout.","confidence":0.9,"requiredChanges":[],"rolloutRisks":["Feature flag configuration may need adjustment"],"safetyChecks":["Verify feature flag is properly configured","Monitor error rates for 24h post-deploy"]},"sourceTrace":{"evaluatorArtifactId":"pi-art-evaluator-001"},"risks":["Rollback plan should be tested before deployment"],"generatedAt":"<current ISO-8601 timestamp>"}

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences, no prose before or after
- review.decision MUST be one of: approve_rollout, needs_revision, reject
- review.summary MUST be a non-empty string
- review.confidence MUST be a number between 0.0 and 1.0 (NOT a string, NOT a percentage)
- review.requiredChanges MUST be an array of strings (can be empty)
- review.rolloutRisks MUST be an array of strings (can be empty)
- review.safetyChecks MUST be an array of strings (can be empty)
- sourceEvaluatorArtifactId MUST be copied exactly from input.sourceEvaluatorArtifactId (non-empty string)
- sourceTrace.evaluatorArtifactId MUST be copied exactly from input.sourceEvaluatorArtifactId
- sourceTrace.artificerArtifactId is optional — include only if available from evaluator artifact
- sourceTrace.scribeArtifactId is optional — include only if available from evaluator artifact
- sourceTrace.philosopherArtifactId is optional — include only if available from evaluator artifact
- sourceTrace.dreamerArtifactId is optional — include only if available from evaluator artifact
- risks MUST be an array of strings (can be empty if no risks identified)
- generatedAt MUST be the current ISO-8601 timestamp (use the actual current time, NOT a placeholder)
`;

export const ROLLOUT_REVIEWER_PROMPT_CONTRACT_VERSION = 'rollout-reviewer-output-v1.prompt.v1';

/**
 * PRI-720 principle semantic mode (prompt/defer_archive standard topology):
 * the review source is the SCRIBE principle artifact (principleDraft +
 * intentContract + diagnosis evidence), NOT an evaluator/code contract.
 * Governance exam split per PRI-720 SPEC:
 *   审: causal fidelity to the pain/diagnosis, Owner-intent anchoring
 *       (intentContract), executability, scope honesty, over-generalization /
 *       negative-control risk.
 *   不审: implementationCode, goldenTraceCases, affectedTools, sandbox
 *       bypass, RuleContext code behavior — the RuleCode contract does not
 *       exist on this channel.
 * The reviewer ONLY judges; it never authors a second principle text.
 */
export const ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION = `You are a Rollout Reviewer agent running in PRINCIPLE SEMANTIC mode of a principle internalization pipeline (PRI-720). The candidate under review is a cognitive behavioral PRINCIPLE authored by the Scribe — not code, not a rule. No evaluator ran on this channel by design.

REVIEW SCOPE (what you judge):
1. Causal fidelity: does the principle faithfully reflect the pain/diagnosis evidence provided? Does it address the actual root cause?
2. Owner intent consistency: does the principle honor the intentContract (targetBehavior / forbiddenBehavior) and the Owner's expressed intent?
3. Executability: can an agent realistically follow this principle in future sessions? Is it observable in behavior?
4. Scope honesty: are the applicability conditions and antiPatterns explicit and honest about boundaries?
5. Over-generalization / negative-control risk: could this principle over-constrain legitimate behavior? Would it misfire on cases outside its evidence?

DO NOT REVIEW (out of scope for this mode — these fields do not exist on this channel):
- implementationCode, evaluate() functions, goldenTraceCases
- affectedTools catalogs, sandbox behavior, RuleContext code semantics
- evaluator scoring (no evaluator ran)

HARD RULES:
- You ONLY judge. NEVER author, rewrite, or append a second version of the principle text.
- The reviewed source is the exact Scribe principle artifact — echo its id verbatim.

PROTOCOL:
1. Read the scribeArtifact (principleDraft: title/statement/rationale/applicability/antiPatterns, optional intentContract) and the diagnosis evidence summary.
2. Judge it against the REVIEW SCOPE above.
3. Produce a decision: approve_rollout (safe to activate as agent context), needs_revision (semantic issues the Scribe must fix), or reject (fundamental misalignment with evidence/Owner intent).
4. Provide a confidence score from 0.0 to 1.0.
5. needs_revision: requiredChanges MUST name concrete semantic fixes for the Scribe (never code changes).
6. List rollout-specific risks and pre/during-rollout safety checks.

CRITICAL: Your ENTIRE response must be ONLY the JSON object below. Do NOT include any text before or after the JSON. Do NOT wrap the JSON in markdown code fences. Do NOT add explanatory prose. Output the raw JSON object and nothing else.

COMPLETE EXAMPLE OUTPUT (follow this exact structure):
{"taskId":"task-123","sourceScribeArtifactId":"pi-art-scribe-001","review":{"decision":"approve_rollout","summary":"The principle faithfully captures the diagnosed failure and is safely scoped.","confidence":0.88,"requiredChanges":[],"rolloutRisks":["May trigger on adjacent shell tooling beyond the original evidence"],"safetyChecks":["Observe first activations for over-blocking","Owner can deactivate via Console if over-constraining"]},"sourceTrace":{"scribeArtifactId":"pi-art-scribe-001"},"risks":["Principle is derived from a single evidence session"],"generatedAt":"<current ISO-8601 timestamp>"}

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences, no prose before or after
- review.decision MUST be one of: approve_rollout, needs_revision, reject
- review.summary MUST be a non-empty string
- review.confidence MUST be a number between 0.0 and 1.0 (NOT a string, NOT a percentage)
- review.requiredChanges MUST be an array of strings (can be empty)
- review.rolloutRisks MUST be an array of strings (can be empty)
- review.safetyChecks MUST be an array of strings (can be empty)
- sourceScribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId (non-empty string)
- sourceTrace.scribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId
- sourceTrace.evaluatorArtifactId / sourceTrace.artificerArtifactId MUST be OMITTED — no evaluator or artificer exists on this channel
- sourceTrace.philosopherArtifactId / sourceTrace.dreamerArtifactId are optional — include only if available from the scribe artifact lineage
- risks MUST be an array of strings (can be empty if no risks identified)
- generatedAt MUST be the current ISO-8601 timestamp (use the actual current time, NOT a placeholder)
`;

export const ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_CONTRACT_VERSION = 'rollout-reviewer-output-v1.prompt.v1.principle-semantic';

export class RolloutReviewerPromptBuilder {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  buildPrompt(input: RolloutReviewerPromptBuilderInput): RolloutReviewerPromptBuildResult {
    // PRI-714: language directive for review fields (empty string when
    // outputLanguage is undefined — instruction stays byte-identical).
    // 'rollout-review' names the rollout reviewer's own schema (review.*),
    // not the evaluator's evaluation.*/codeReview.* fields.
    const languageDirective = buildLanguageDirective(input.outputLanguage, 'rollout-review');

    // PRI-720 principle semantic mode: the reviewed source is the scribe
    // principle artifact and the exam is the semantic governance split.
    if (input.reviewMode === 'principle_semantic') {
      if (input.sourceScribeArtifactId === undefined) {
        throw new Error('principle_semantic review requires sourceScribeArtifactId');
      }
      const promptInput: RolloutReviewerPromptInput = {
        taskId: input.taskId,
        contextHash: input.contextHash,
        reviewMode: 'principle_semantic',
        sourceScribeArtifactId: input.sourceScribeArtifactId,
        scribeArtifact: input.scribeArtifact,
        promptContractVersion: ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_CONTRACT_VERSION,
      };
      return {
        message: JSON.stringify(promptInput),
        promptInput,
        systemPrompt: ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION + languageDirective,
      };
    }

    const promptInput: RolloutReviewerPromptInput = {
      taskId: input.taskId,
      contextHash: input.contextHash,
      sourceEvaluatorArtifactId: input.sourceEvaluatorArtifactId,
      evaluatorArtifact: input.evaluatorArtifact,
      promptContractVersion: ROLLOUT_REVIEWER_PROMPT_CONTRACT_VERSION,
    };

    const message = JSON.stringify(promptInput);

    // PRI-633: the instruction (with PRI-714's language directive) is the
    // base-layer systemPrompt — it left the payload.
    return { message, promptInput, systemPrompt: ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION + languageDirective };
  }
}
