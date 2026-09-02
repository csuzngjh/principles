import { serializePromptInput } from './prompt-serializer.js';
import { validateBehaviorExamplePack } from './behavior-example-pack.js';
import type { BehaviorExamplePack } from './behavior-example-pack.js';

/**
 * Dreamer candidate 5-dim context (PRI-508).
 *
 * Carries the dreamer-stage candidate fields that scribe compresses into a
 * single principleDraft.statement. Forwarding them to the artificer prompt
 * prevents intent inconsistency (PoC: deepseek-v4-flash 0.7 needs_revision
 * → 0.85 approved when combined with repair loop).
 *
 * All fields are runtime-validated by ArtificerRunner.buildContext via
 * typeof / Object.hasOwn / Array.isArray guards before being placed here
 * (rc-1, rc-2). dreamerContext is optional — undefined when the scribe
 * artifact lacks `sourceTrace.dreamerArtifactId` or the dreamer artifact
 * cannot be resolved (backward compatible with pre-PRI-508 flows).
 */
export interface ArtificerDreamerContext {
  readonly badDecision: string;
  readonly betterDecision: string;
  readonly rationale: string;
  readonly riskLevel?: string;
  readonly strategicPerspective?: string;
}

export interface ArtificerPromptBuilderInput {
  contextMode: 'v1' | 'v2';
  behaviorExamplePack?: BehaviorExamplePack;
  taskId: string;
  contextHash: string;
  sourceScribeArtifactId: string;
  scribeArtifact: unknown;
  /**
   * Prior adversarial replay failures to address (RuleHost MVP, PRI-428).
   * Present only on Round-2+ retries inside runAdversarialLoop. When absent,
   * the prompt is the initial generation prompt (backward compatible).
   */
  adversarialFeedback?: string;
  /**
   * Dreamer candidate 5-dim context (PRI-508). Optional — when present,
   * serialized into the prompt so the artificer can align its implementation
   * with the dreamer's original intent. Undefined for backward compatibility.
   */
  dreamerContext?: ArtificerDreamerContext;
  /**
   * Evaluator repair feedback (PRI-509). Present only on Round-2+ artificer
   * tasks seeded by evaluator needs_revision. Carries the evaluator's
   * requiredChanges/concerns/previousScore as a single pre-formatted string
   * (built by ArtificerRunner.buildContext from PITaskMetadata.repairPayload).
   * Distinct from adversarialFeedback (PRI-428): adversarialFeedback is
   * adversarial-replay failure text; repairFeedback is evaluator semantic feedback.
   * Undefined on Round-1 artificer tasks (backward compatible).
   */
  repairFeedback?: string;
}

export interface ArtificerPromptInput {
  contextMode: 'v1' | 'v2';
  behaviorExamplePack?: BehaviorExamplePack;
  taskId: string;
  contextHash: string;
  sourceScribeArtifactId: string;
  scribeArtifact: unknown;
  artificerInstruction: string;
  promptContractVersion: string;
  /** Present only when this is a retry with prior adversarial failures. */
  adversarialFeedback?: string;
  /** Present only when dreamer candidate context is available (PRI-508). */
  dreamerContext?: ArtificerDreamerContext;
  /** Present only on Round-2+ artificer repair tasks (PRI-509). */
  repairFeedback?: string;
}

export interface ArtificerPromptBuildResult {
  readonly message: string;
  readonly promptInput: ArtificerPromptInput;
}

export const ARTIFICER_PROTOCOL_INSTRUCTION = `You are an Artificer agent in a principle internalization pipeline. Your role is to transform the Scribe's formal principle draft into executable RuleHost code with a concise implementation summary, tests, and rollout notes.

PROTOCOL:
1. Review the scribeArtifact to understand the formal principle draft
2. Transform the principle draft into executable RuleHost code and a brief implementation summary
3. Preserve the lineage trace from scribe, philosopher, and dreamer artifacts
4. Identify risks associated with implementing this principle
5. The implementation summary should clearly describe what the code does and why

OUTPUT FORMAT (pure JSON, no markdown):
{
  "taskId": "<from input>",
  "sourceScribeArtifactId": "<copy exactly from input.sourceScribeArtifactId>",
  "implementationSummary": "<concise summary of what the code does and the implementation approach>",
  "sourceTrace": {
    "scribeArtifactId": "<copy exactly from input.sourceScribeArtifactId>",
    "philosopherArtifactId": "<from scribe artifact if available, or omit>",
    "dreamerArtifactId": "<from scribe artifact if available, or omit>"
  },
  "risks": ["<risk 1>", "<risk 2>"],
  "implementationCode": "function evaluate(input, helpers) { ... }",
  "goldenTraceCases": [
    {"caseId":"negative-1","kind":"negative","toolName":"write_file","params":{"path":"/system/file"},"expectedDecision":"block"},
    {"caseId":"positive-1","kind":"positive","toolName":"write_file","params":{"path":"/workspace/file"},"expectedDecision":"allow"}
  ],
  "affectedTools": ["write_file"],
  "generatedAt": "<ISO-8601 timestamp>"
}

CONSTRAINTS:
- Output ONLY valid JSON (no markdown, no explanatory text, no code fences)
- implementationSummary MUST be a non-empty string describing what the code does and the implementation approach
- sourceScribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId (non-empty string)
- sourceTrace.scribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId
- sourceTrace.philosopherArtifactId is optional — include only if available from scribe artifact
- sourceTrace.dreamerArtifactId is optional — include only if available from scribe artifact
- risks MUST be an array of strings (can be empty if no risks identified)
- generatedAt MUST be the current ISO-8601 timestamp (use the actual current time, NOT a placeholder)
- implementationCode MUST define exactly function evaluate(input, helpers) and return { decision, matched, reason }
- EVERY return statement inside evaluate() MUST include ALL three fields: decision, matched, reason
- Do NOT return partial objects — missing fields will fail sandbox validation and block activation
- GOOD: return { decision: 'allow', matched: false, reason: 'path is within workspace, no risk' }
- GOOD: return { decision: 'block', matched: true, reason: 'write to system path outside workspace' }
- BAD:  return { matched: false } — missing decision and reason, will be rejected
- BAD:  return { decision: 'allow', matched: true } — missing reason, will be rejected
- input.action contains toolName, normalizedPath, and paramsSummary
- input.action.paramsSummary is an OBJECT (a map of parameter names to values), NOT a string
- NEVER call string methods on paramsSummary itself — paramsSummary.includes(...), paramsSummary.startsWith(...), paramsSummary.match(...) are always bugs and will crash with "is not a function"
- To inspect a parameter, access its specific key (e.g. paramsSummary.path) and guard its type at runtime (typeof paramsSummary.path === 'string') before using it as a string
- For path logic prefer input.action.normalizedPath (a normalized string) over reading raw params strings
- implementationCode MUST be deterministic and self-contained: no imports, require, eval, Function, I/O, network, timers, Date.now, or randomness
- goldenTraceCases MUST contain 2-10 cases with at least one positive allow case and one negative block case
- goldenTraceCases expectedDecision MUST be only "allow" or "block" — do NOT emit "propose_correction", "requireApproval", or "auto_correct" (seed-user MVP only supports allow/block; all other action types are rejected by the schema validator)
- affectedTools MUST contain the non-empty tool names the rule can match

PRIOR ADVERSARIAL FAILURES (when \`adversarialFeedback\` is present):
- This is a RETRY. A prior version of your generated code was reviewed and failed adversarial sandbox replay.
- The \`adversarialFeedback\` field lists the specific cases that failed, each with the attack type, the expected vs actual decision, and a rationale.
- You MUST address each listed failure specifically — do not regenerate blind. Adjust the matcher/logic so the failed cases produce the expected decision while preserving the cases that previously passed.

RULEHOST CAPABILITY BOUNDARY (PRI-508):
- RuleHost evaluate(input) is a STATELESS single-call gate. It CANNOT track multi-step workflows (e.g., audit→verify→incremental) across invocations.
- Translate the principle into a STATEFUL-CHECKABLE constraint that evaluate() CAN enforce per tool call: check whether the current tool call carries evidence of prior analysis (context markers, params encoding prior reads, explicit preconditions in the params).
- Do NOT implement a path whitelist or a "first call must be X" ordering rule if the principle is about procedural discipline — the runtime cannot observe ordering across calls.
- If the principle cannot be enforced per-call, encode the closest per-call proxy and document the gap in implementationSummary.

REPAIR FEEDBACK (PRI-509, when \`repairFeedback\` is present):
- This is a REPAIR RETRY. A prior attempt of your generated code was reviewed by the evaluator and returned needs_revision.
- The \`repairFeedback\` field lists the evaluator's concerns and required changes from the prior attempt.
- You MUST address each required change specifically — do not regenerate blind. Adjust the matcher/logic so the concerns are resolved while preserving the principle intent.
- If a required change contradicts the principle intent (from scribeArtifact/dreamerContext), prefer the principle intent and document the conflict in implementationSummary.
- When the repair feedback contains a "Deterministic Replay Evidence" block (resolved from the source evaluator artifact):
  - Each entry is a machine-verified failure: Case (id), Expected (decision), Actual (decision, only when your code really returned one), Error (sandbox error type), Message (bounded safe failure detail).
  - Fix EVERY listed deterministic failure so the case produces its Expected decision.
  - Preserve the behavior of cases that already passed — do not trade passing cases for failing ones.
  - Do NOT weaken safety constraints (e.g. drop risk-path blocks) just to make replay pass.
  - Respect the canonical RuleHostInput contract, including that paramsSummary is an object (see CONSTRAINTS).
  - Do NOT invent, guess, or fabricate evidence that is not listed — the list is the complete deterministic fact set (possibly truncated, as noted).
`;

const V1_CONTEXT_INSTRUCTION = `
CONTEXT MODE: v1
- You MUST NOT read input.context.
- You MUST NOT output requiresContextVersion or case-level ruleContext.
- Generate an action-only rule from the Scribe principle.
`;

const V2_CONTEXT_INSTRUCTION = `
CONTEXT MODE: v2 (Owner-labelled evidence is present)
- Treat behaviorExamplePack labels as authoritative: sourceNegativeCase MUST remain block and every positiveCounterexample MUST remain allow.
- You MUST output requiresContextVersion: 2.
- Every goldenTraceCases entry MUST include its explicit ruleContext; do not invent or auto-fill context.
- You may inspect input.context. When it is undefined or context.history.status is unavailable, MUST return { decision: "allow", matched: false, reason: "context unavailable" }.
- Prefer deterministic context.facts and canonicalKind over raw context.history.calls.
- An empty or truncated history is insufficient evidence; do not infer "not done" from it.
- You MUST copy evidenceRefs exactly from the behaviorExamplePack into your output. Do not omit, reorder, or rewrite any evidenceRef string.
`;

/**
 * PRI-634 PR-A: bumped v2 → v3. The prompt contract changed materially:
 * (1) explicit paramsSummary-is-an-object contract with whole-object string
 * method prohibition; (2) deterministic replay evidence block semantics in
 * repair rounds (Case/Expected/Actual/Error/Message entries + fix/preserve/
 * no-weakening/no-fabrication instructions).
 */
export const ARTIFICER_PROMPT_CONTRACT_VERSION = 'artificer-output-v2.prompt.v3';

export class ArtificerPromptBuilder {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  buildPrompt(input: ArtificerPromptBuilderInput): ArtificerPromptBuildResult {
    if (input.contextMode === 'v2') {
      const validation = validateBehaviorExamplePack(input.behaviorExamplePack);
      if (!validation.valid) {
        throw new Error(`behaviorExamplePack is required and must be valid in v2 mode: ${validation.errors.join('; ')}`);
      }
    } else if (input.behaviorExamplePack !== undefined) {
      throw new Error('behaviorExamplePack is forbidden in v1 mode');
    }
    const artificerInstruction = ARTIFICER_PROTOCOL_INSTRUCTION
      + (input.contextMode === 'v2' ? V2_CONTEXT_INSTRUCTION : V1_CONTEXT_INSTRUCTION);
    const promptInput: ArtificerPromptInput = {
      contextMode: input.contextMode,
      taskId: input.taskId,
      contextHash: input.contextHash,
      sourceScribeArtifactId: input.sourceScribeArtifactId,
      scribeArtifact: input.scribeArtifact,
      artificerInstruction,
      promptContractVersion: ARTIFICER_PROMPT_CONTRACT_VERSION,
      ...(input.contextMode === 'v2' && input.behaviorExamplePack !== undefined
        ? { behaviorExamplePack: input.behaviorExamplePack }
        : {}),
      // Only include adversarialFeedback when present + non-empty, so
      // Round-1 prompts stay backward-compatible (test asserts absence).
      ...(typeof input.adversarialFeedback === 'string' && input.adversarialFeedback.trim() !== ''
        ? { adversarialFeedback: input.adversarialFeedback }
        : {}),
      // PRI-508: only include dreamerContext when present, so pre-PRI-508
      // prompts stay backward-compatible (test asserts absence when undefined).
      ...(input.dreamerContext !== undefined ? { dreamerContext: input.dreamerContext } : {}),
      // PRI-509: only include repairFeedback when present + non-empty, so
      // Round-1 prompts stay backward-compatible (test asserts absence).
      ...(typeof input.repairFeedback === 'string' && input.repairFeedback.trim() !== ''
        ? { repairFeedback: input.repairFeedback }
        : {}),
    };

    const message = serializePromptInput(promptInput);

    return { message, promptInput };
  }
}
