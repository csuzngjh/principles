import { serializePromptInput } from './prompt-serializer.js';
import { validateBehaviorExamplePack } from './behavior-example-pack.js';
import type { BehaviorExamplePack } from './behavior-example-pack.js';
import type { LastValidatorErrors } from './pitask-metadata.js';
import type { IntentContractV1 } from './intent-contract.js';
import type { ToolSemanticMappingV1 } from './tool-semantic-registry.js';
import type { OutputLanguage } from '../language-directive.js';
import { buildLanguageDirective } from '../language-directive.js';

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

/**
 * PRI-741: read-only projection of the host tool semantic context into the
 * Artificer prompt. Built by entry points from the SAME ToolSemanticRegistry
 * instance the production gate and the reliability validation use — this is a
 * prompt DTO, not a new truth source: it carries no authority of its own.
 */
export interface ArtificerHostSemanticContext {
  /** Host kind label(s) the generated rule will run under (e.g. 'openclaw'). */
  readonly hostKinds: readonly string[];
  /** The real host dispatch surface (raw tool name → canonicalKind). */
  readonly tools: readonly ToolSemanticMappingV1[];
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
  /**
   * PRI-700 因子 B (Owner 决策 2026-09-07): 上一次 attempt 的 validator
   * 拒绝全文（结构化 {recordedAt, errorCategory, errors[]}）。仅在同一
   * attempt 未消费过时由 runner 携带；presence = 上次输出被 output-contract
   * gate 拒绝的确切原因。Undefined = 本 attempt 无前次拒绝（首轮生成或
   * 前次 attempt 成功通过校验）。
   */
  priorValidatorErrors?: LastValidatorErrors;
  /**
   * PRI-703 Phase 1: the scribe artifact's structured Owner-intent contract
   * (runtime-validated via extractIntentContract). The generated rule must
   * serve ownerIntent/targetBehavior and MUST NOT implement
   * forbiddenBehavior. Undefined for pre-contract scribe artifacts
   * (backward compatible).
   */
  intentContract?: IntentContractV1;
  /**
   * Owner's preferred language for implementation artifacts (PRI-714). When
   * provided, the artificer instruction carries a language directive so
   * implementationSummary and risks are written in the owner's language.
   * Undefined = no directive (backward compatible). Never affects
   * implementationCode, goldenTraceCases params, or lineage fields.
   */
  outputLanguage?: OutputLanguage;
  /**
   * PRI-741: optional host semantic projection (real host tool names + kinds,
   * resolved from the ToolSemanticRegistry). When present the prompt carries a
   * HOST SEMANTIC CONTEXT block constraining the generated rule to
   * canonicalKind-first matching and host-dispatchable tool names. Undefined =
   * prompt unchanged (backward compatible for workspaces without a host
   * declaration).
   */
  hostSemanticContext?: ArtificerHostSemanticContext;
}

export interface ArtificerPromptInput {
  contextMode: 'v1' | 'v2';
  behaviorExamplePack?: BehaviorExamplePack;
  taskId: string;
  contextHash: string;
  sourceScribeArtifactId: string;
  scribeArtifact: unknown;
  promptContractVersion: string;
  /** Present only when this is a retry with prior adversarial failures. */
  adversarialFeedback?: string;
  /** Present only when dreamer candidate context is available (PRI-508). */
  dreamerContext?: ArtificerDreamerContext;
  /** Present only on Round-2+ artificer repair tasks (PRI-509). */
  repairFeedback?: string;
  /** Present only when the prior attempt was rejected by the output-contract gate (PRI-700 factor B). */
  priorValidatorErrors?: LastValidatorErrors;
  /**
   * PRI-703 Phase 1: the scribe artifact's structured Owner-intent contract
   * (already runtime-validated by extractIntentContract). Forwarded into the
   * prompt so rule generation anchors to the explicit intent — the
   * implementationCode must serve ownerIntent/targetBehavior and MUST NOT
   * implement forbiddenBehavior. Undefined for pre-contract scribe artifacts
   * (backward compatible).
   */
  intentContract?: IntentContractV1;
  /** PRI-741: present only when a host semantic projection was resolved. */
  hostSemanticContext?: ArtificerHostSemanticContext;
}

export interface ArtificerPromptBuildResult {
  readonly message: string;
  readonly promptInput: ArtificerPromptInput;
  /**
   * PRI-633: base-layer system prompt (role + protocol + context-mode
   * instruction). Previously embedded in the payload as `artificerInstruction`;
   * now delivered via the system channel by the runtime adapter.
   */
  readonly systemPrompt: string;
}

export const ARTIFICER_PROTOCOL_INSTRUCTION = `You are an Artificer agent in a principle internalization pipeline. Your role is to transform the Scribe's formal principle draft into executable RuleHost code with a concise implementation summary, tests, and rollout notes.

PROTOCOL:
1. Review the scribeArtifact to understand the formal principle draft
2. Transform the principle draft into executable RuleHost code and a brief implementation summary
3. Preserve the lineage trace from scribe, philosopher, and dreamer artifacts
4. Identify risks associated with implementing this principle
5. The implementation summary should clearly describe what the code does and why

OWNER INTENT CONTRACT (when \`intentContract\` is present — PRI-703):
- \`intentContract\` is the Owner-intent anchor distilled from the real failure. Your rule exists to serve it.
- implementationCode MUST operationalize \`targetBehavior\` and MUST NOT implement \`forbiddenBehavior\`.
- If a repair/revision instruction (repairFeedback, revisionFeedback) contradicts the intentContract, the intentContract wins: implement the contract-faithful behavior and document the conflict in implementationSummary — do NOT silently satisfy the contradicting instruction.
- Use \`validationExpectation\` as your self-check before emitting: would an evaluator observing that expectation accept this rule as faithful?

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
  "implementationCode": "function evaluate(input, helpers) { if (input.action.canonicalKind === 'write' && typeof input.action.normalizedPath === 'string' && input.action.normalizedPath.startsWith('/system/')) { return { decision: 'block', matched: true, reason: 'write to system path' }; } return { decision: 'allow', matched: false, reason: 'no risk pattern' }; }",
  "goldenTraceCases": [
    {"caseId":"negative-1","kind":"negative","toolName":"write","params":{"path":"/system/file"},"expectedDecision":"block"},
    {"caseId":"positive-1","kind":"positive","toolName":"write","params":{"path":"/workspace/file"},"expectedDecision":"allow"}
  ],
  "affectedTools": ["write"],
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
- input.action contains toolName, normalizedPath, paramsSummary, and canonicalKind
- input.action.canonicalKind is the closed semantic kind of the current action: "read" | "search" | "write" | "execute" | "agent" | "other"
- CANONICALKIND-FIRST MATCHING (PRI-741): match behavior PRIMARILY by input.action.canonicalKind (e.g. input.action.canonicalKind === 'write'); use input.action.toolName only as an auxiliary condition to distinguish tools within the same kind
- When a HOST SEMANTIC CONTEXT block is present, affectedTools and EVERY goldenTraceCases toolName MUST be a real host tool name from that list — activation replay is machine-validated against the host declaration, and generic LLM vocabulary names (write_file, edit_file, bash, run_shell_command, delete_file, ...) are NOT real host tools and WILL be rejected
- When NO HOST SEMANTIC CONTEXT block is present you have no authoritative host tool knowledge: match by canonicalKind and NEVER invent host-specific tool names
- input.action.paramsSummary is an OBJECT (a map of parameter names to values), NOT a string
- NEVER call string methods on paramsSummary itself — paramsSummary.includes(...), paramsSummary.startsWith(...), paramsSummary.match(...) are always bugs and will crash with "is not a function"
- To inspect a parameter, access its specific key (e.g. paramsSummary.path) and guard its type at runtime (typeof paramsSummary.path === 'string') before using it as a string
- For path logic prefer input.action.normalizedPath (a normalized string) over reading raw params strings
- implementationCode MUST be deterministic and self-contained: no imports, require, eval, Function, I/O, network, timers, Date.now, or randomness
- goldenTraceCases MUST contain 2-10 cases with at least one positive allow case and one negative block case
- goldenTraceCases expectedDecision MUST be only "allow" or "block" — do NOT emit "propose_correction", "requireApproval", or "auto_correct" (seed-user MVP only supports allow/block; all other action types are rejected by the schema validator)
- affectedTools MUST contain the non-empty tool names the rule can match (see the HOST SEMANTIC CONTEXT / canonicalKind-first rules above)

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

ADVERSARIAL CASE VOCABULARY NOTE (apply whenever replay evidence or repair feedback mentions case ids):
- Case ids such as "v2-unavailable", "v2-truncated", "v2-alias" (and any "v2-*" prefixed id) are INTERNAL EVALUATOR CASE NUMBERING — they describe which adversarial fixture was run, NOT a request to use context-version-2 features.
- NEVER respond to a case id by declaring \`requiresContextVersion\`, adding case-level \`ruleContext\`, or changing \`expectedDecision\` to satisfy the case NAME. Case names are labels, not instructions.
- Your output must ALWAYS satisfy the CONTEXT MODE block above (v1/v2 contract) regardless of which case ids appear in the feedback text.
- In v1 mode the ONLY legal decisions are "allow" and "block"; the ONLY legal field set is the one in OUTPUT FORMAT above. Any field not listed there (e.g. requiresContextVersion, ruleContext) is a contract violation and WILL be rejected.

PRIOR OUTPUT-CONTRACT REJECTIONS (when \`priorValidatorErrors\` is present):
- Your previous attempt was rejected by the OUTPUT CONTRACT GATE (schema validation) — it never reached evaluation. The \`priorValidatorErrors.errors\` list contains the exact, verbatim rejection reasons.
- The highest-priority fix is to make your JSON satisfy EVERY listed rejection reason. Re-read each error, map it to the OUTPUT FORMAT and CONTEXT MODE rules, and correct the exact fields it names.
- These errors describe YOUR output's shape, not the principle and not the test cases — do not change the behavioral intent while fixing them.
- After addressing every listed error, re-check the full OUTPUT FORMAT and CONTEXT MODE blocks once more before emitting.
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
 *
 * PRI-700 (Owner 决策 2026-09-07): bumped v3 → v4. (1) adversarial case-id
 * vocabulary note (v2-* ids are evaluator internal numbering, never a request
 * to declare context-version fields); (2) prior output-contract rejection
 * feedback block (priorValidatorErrors) — the repair attempt now receives the
 * verbatim schema-rejection reasons from its previous attempt.
 */
/**
 * PRI-741: bumped v4 → v5. (1) canonicalKind-first matching contract —
 * input.action.canonicalKind is the primary dispatch signal, the OUTPUT FORMAT
 * example demonstrates canonicalKind matching and no longer teaches the
 * phantom generic name `write_file`; (2) optional HOST SEMANTIC CONTEXT block
 * (hostSemanticContext): the real host tool names + kinds projected from the
 * ToolSemanticRegistry host layer, constraining affectedTools and
 * goldenTraceCases toolNames to host-dispatchable names.
 */
export const ARTIFICER_PROMPT_CONTRACT_VERSION = 'artificer-output-v2.prompt.v5';

/**
 * PRI-741: render the host semantic projection as a prompt block. Mirrors the
 * evaluator's TOOL CATALOG AUTHORITY pattern: the list is authoritative for
 * what really dispatches, and explicitly non-exhaustive for the host's total
 * toolset (read-only tools are never routed to the gate).
 */
function buildHostSemanticContextBlock(context: ArtificerHostSemanticContext): string {
  const toolList = context.tools.map((tool) => `${tool.rawToolName}→${tool.canonicalKind}`).join('; ');
  const hostLine = context.hostKinds.length > 0 ? `- Target host(s): ${context.hostKinds.join(', ')}\n` : '';
  return `
HOST SEMANTIC CONTEXT (authoritative — overrides your prior tool-name knowledge):
${hostLine}- Real host tools (rawToolName → canonicalKind): ${toolList}
- affectedTools and EVERY goldenTraceCases toolName MUST be one of the real host tool names listed above (activation is machine-validated against this exact list).
- This list is the declared dispatch surface; it is NOT the host's full toolset (read-only tools are not gated and are absent here).
`;
}

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
      + (input.contextMode === 'v2' ? V2_CONTEXT_INSTRUCTION : V1_CONTEXT_INSTRUCTION)
      // PRI-741: host semantic projection (absent = no block, prompt
      // unchanged for workspaces without a host declaration).
      + (input.hostSemanticContext !== undefined ? buildHostSemanticContextBlock(input.hostSemanticContext) : '')
      // PRI-714: language directive for human-readable implementation fields
      // (empty string when outputLanguage is undefined).
      + buildLanguageDirective(input.outputLanguage, 'implementation');
    const promptInput: ArtificerPromptInput = {
      contextMode: input.contextMode,
      taskId: input.taskId,
      contextHash: input.contextHash,
      sourceScribeArtifactId: input.sourceScribeArtifactId,
      scribeArtifact: input.scribeArtifact,
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
      // PRI-700 因子 B: only include priorValidatorErrors when present, so
      // first-attempt prompts stay backward-compatible.
      ...(input.priorValidatorErrors !== undefined ? { priorValidatorErrors: input.priorValidatorErrors } : {}),
      // PRI-703 Phase 1: only include intentContract when present (pre-contract
      // scribe artifacts), so prompts stay backward-compatible.
      ...(input.intentContract !== undefined ? { intentContract: input.intentContract } : {}),
      // PRI-741: only include hostSemanticContext when present, so prompts
      // stay backward-compatible for host-neutral workspaces.
      ...(input.hostSemanticContext !== undefined ? { hostSemanticContext: input.hostSemanticContext } : {}),
    };

    const message = serializePromptInput(promptInput);

    return { message, promptInput, systemPrompt: artificerInstruction };
  }
}
