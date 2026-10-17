import { buildCoreAxiomBlock } from '../core-principles/core-axiom-block.js';
import type { CoreAxiomBlockOptions } from '../core-principles/core-axiom-block.js';
import type { OutputLanguage } from '../language-directive.js';
import { buildLanguageDirective } from '../language-directive.js';
import type { FormationContext } from './formation-context.js';

export interface ScribePromptBuilderInput {
  taskId: string;
  contextHash: string;
  sourcePhilosopherArtifactId: string;
  /**
   * PRI-816 (R-01): authoritative dreamer artifact id, extracted by the
   * runner from the philosopher artifact's `sourceDreamerArtifactId`. When
   * present the scribe copies it into `sourceTrace.dreamerArtifactId`;
   * when absent the field stays optional (pre-PRI-508 flows).
   */
  sourceDreamerArtifactId?: string;
  philosopherArtifact: unknown;
  /**
   * PRI-838: bounded projection of the formation evidence this formation was
   * built from (dreamer proposals + source diagnosis + provenance). Absent when
   * the dreamer artifact could not be resolved — the prompt then keeps its
   * pre-PRI-838 shape exactly (legacy / degraded compatibility).
   */
  formationContext?: FormationContext;
  /** Owner's preferred language for principle generation (PRI-336). */
  outputLanguage?: OutputLanguage;
  /** Inject core axiom grounding section (default: false). */
  coreGrounding?: boolean;
}

export interface ScribePromptInput {
  taskId: string;
  contextHash: string;
  sourcePhilosopherArtifactId: string;
  sourceDreamerArtifactId?: string;
  philosopherArtifact: unknown;
  /** PRI-838: present only when formation evidence resolved for this run. */
  formationContext?: FormationContext;
  promptContractVersion: string;
}

export interface ScribePromptBuildResult {
  readonly message: string;
  readonly promptInput: ScribePromptInput;
  /**
   * PRI-633: base-layer system prompt (role + protocol). Previously embedded
   * in the payload as `scribeInstruction`; now delivered via the system
   * channel by the runtime adapter.
   */
  readonly systemPrompt: string;
}

/**
 * PRI-838: the formation-evidence addendum (system-prompt half of the repair).
 *
 * The CANDIDATE PRIORITY contract below is reused **byte-identical** from the
 * frozen PRI-815 Phase A addendum (`scripts/pri-815/b-addendum.mjs`,
 * `B_ADDENDUM_VERSION = 'pri815-b-addendum.v1'`). That exact text is the
 * information channel which produced the measured
 * `NET_ADVANTAGE = 85.7pp` (W=19 / L=1 / T=1) in PR #1753, so re-deriving or
 * paraphrasing it would discard the only quantitative evidence we have for it.
 *
 * Two deliberate deltas from the frozen text, both required to productionise it:
 *   1. the locator paragraph — the production payload nests the three blocks
 *      under `formationContext`, where the harness passed them flat;
 *   2. one degradation bullet — production formations include legacy artifacts
 *      with no resolvable diagnosis (PRI-838 Phase 4 Case 2/3), and the model
 *      must be told to degrade rather than invent a missing source intent.
 *
 * Every other line is unchanged.
 */
export const FORMATION_EVIDENCE_ADDENDUM_VERSION = 'pri815-b-addendum.v1';

export const FORMATION_EVIDENCE_ADDENDUM = `

ADDITIONAL CONTEXT (formation evidence recovery):
Your input additionally carries \`formationContext\` — the ORIGINAL FORMATION EVIDENCE that started this formation:
- formationContext.sourceDiagnosis: the diagnostician output that started this formation, including its rootCause, summary, violatedPrinciples and evidence array (the primary source intent).
- formationContext.dreamerProposals: ALL alternative candidates the Dreamer proposed (not only the selected one), each with badDecision / betterDecision / rationale / confidence / riskLevel / strategicPerspective. \`priorityRank\` is a derived reading aid over the Dreamer's own signals, not an authority.
- formationContext.provenance: lineage ids linking this formation back to the source pain and diagnosis.

CANDIDATE PRIORITY (must obey):
source intent (sourceDiagnosis) > critique conclusions (philosopherArtifact) > proposals as candidate evidence (dreamerProposals).
- The philosopher's critique already evaluated the proposals: do NOT revive a proposal the critique explicitly rejected.
- Do NOT merge mutually exclusive proposals into one principle.
- Use the proposals as EVIDENCE for specificity (concrete failure modes, concrete better decisions), never to widen the principle's scope beyond the source intent.
- Ground every concrete claim in the formation evidence (diagnosis evidence, a proposal's concrete decision, or the critique). Do NOT invent specifics that are absent from this formation context.
- Longer output is not better: the goal is a MORE FAITHFUL, MORE SPECIFIC, correctly-bounded principle, not a longer one.
- When \`formationContext.sourceDiagnosis\` is absent, the source intent is UNAVAILABLE: say so in \`risks\` instead of inventing one, and let the critique conclusions carry the intent.
- All other PROTOCOL, OUTPUT FORMAT and CONSTRAINTS above remain unchanged.`;

/**
 * Build the Scribe protocol instruction with optional core axiom grounding.
 *
 * When `coreGrounding` is true, a CORE AXIOMS section is injected so the
 * Scribe can ensure the formal principle draft is consistent with the
 * existing core principle framework.
 *
 * When `formationEvidence` is true (PRI-838), the formation-evidence addendum
 * is appended after the CONSTRAINTS section — the same system-channel placement
 * the validated PRI-815 Phase A Arm B used.
 */
export function buildScribeProtocolInstruction(
  opts: CoreAxiomBlockOptions & { outputLanguage?: OutputLanguage; formationEvidence?: boolean } = {},
): string {
  const { outputLanguage, formationEvidence = false, ...axiomOpts } = opts;
  const coreAxiomsBlock = buildCoreAxiomBlock({ ...axiomOpts, outputLanguage });
  const languageDirective = buildLanguageDirective(outputLanguage);
  const formationEvidenceBlock = formationEvidence ? FORMATION_EVIDENCE_ADDENDUM : '';

  return `You are a Scribe agent in a principle internalization pipeline. Your role is to distill the Philosopher's analysis into a formal, implementable principle draft.

PROTOCOL:
1. Review the philosopherArtifact to understand the philosophical thesis and principle candidate
2. Transform the philosopher's analysis into a formal principle draft with clear statement, rationale, applicability, and anti-patterns
3. Preserve the lineage trace from dreamer and philosopher artifacts
4. Identify risks associated with applying this principle
5. The principle draft should be concrete enough to guide implementation, not just philosophical
${coreAxiomsBlock}OUTPUT FORMAT (pure JSON, no markdown):
{
  "taskId": "<from input>",
  "sourcePhilosopherArtifactId": "<copy exactly from input.sourcePhilosopherArtifactId>",
  "principleDraft": {
    "title": "<concise principle title, <=100 chars>",
    "statement": "<formal principle statement describing what should always be done>",
    "rationale": "<why this principle addresses the root cause>",
    "applicability": ["<context where this principle applies>"],
    "antiPatterns": ["<pattern this principle forbids>"],
    "confidence": 0.8
  },
  "intentContract": {
    "ownerIntent": "<what the Owner actually wants to prevent or achieve, one concrete sentence>",
    "targetBehavior": "<the observable behavior a compliant agent must exhibit>",
    "forbiddenBehavior": "<the behavior this principle explicitly forbids — the failure family>",
    "evidenceSource": "<which real evidence (pain/diagnosis) this intent is distilled from>",
    "validationExpectation": "<what an evaluator should observe to accept a rule as faithful to this intent>"
  },
  "sourceTrace": {
    "dreamerArtifactId": "<copy exactly from input.sourceDreamerArtifactId; omit when input does not carry one>",
    "philosopherArtifactId": "<copy exactly from input.sourcePhilosopherArtifactId>"
  },
  "risks": ["<risk 1>", "<risk 2>"],
  "ownerRequirementGaps": ["<Owner-attributed requirement NOT carried into the contract, with the reason — omit the field entirely when none>"],
  "executionConditions": {
    "version": 1,
    "requiredFacts": [
      {"factKind": "<trusted external fact kind the principle's enforcement depends on, e.g. design_approval>", "required": true, "textualBasis": "<the Owner-attributed text this requirement was read from>"}
    ]
  },
  "generatedAt": "<ISO-8601 timestamp>"
}

INTENT CONTRACT (required — the alignment anchor for every downstream stage):
- The intentContract is read by rule generation, evaluation, and repair. Vague wording there becomes incoherent rules downstream.
- ownerIntent: one concrete sentence about what the Owner wants — never a slogan. BAD: "be careful with configs". GOOD: "avoid the agent guessing configuration contracts from example files".
- targetBehavior: the observable action a compliant agent performs (what a reviewer could SEE in a tool trajectory).
- forbiddenBehavior: the failure family this principle exists to kill — mirror the diagnosed pain, not a generic vice.
- evidenceSource: name the actual pain/diagnosis facts this distills from.
- validationExpectation: what evidence an evaluator should demand before accepting a rule as faithful. A later repair round checks required changes against this field: a change that contradicts it is flagged, not blindly implemented.

OWNER-SOURCE GROUNDING (applies when formation evidence is present):
- The requirements source is the diagnosis's Owner-attributed statements: rootCause, summary, violatedPrinciples, and evidence notes that state what the OWNER requires (e.g. "Owner 明确……必须先确认"). The diagnosis's implementation recommendations (kind=implementation / rule / principle) are the pipeline's own DESIGN PROPOSALS — candidate answers, never Owner requirements.
- Every requirement you write into intentContract (ownerIntent / targetBehavior / forbiddenBehavior / validationExpectation) MUST be grounded in those Owner-attributed statements. A mechanism that appears only in recommendations or upstream proposals (e.g. a persisted confirmation-record store, an authorization table, a new input field) MUST NOT be presented as Owner-mandated: either omit it, or carry it as an explicitly derived implementation choice and mark it in risks with the prefix "derived_mechanism:".
- Coverage check (when formation evidence is present): enumerate the Owner-attributed requirements you can see, then check each one against your contract. If any of them is NOT carried into the contract — narrowed (e.g. a requirement covering reads AND writes carried as write-only), partially carried, or dropped — you MUST declare it in the structured "ownerRequirementGaps" output field (one entry per uncovered requirement: the requirement and why it is not carried). The field is machine-consumed: the pipeline surfaces it to the Owner and the evaluator is obliged to treat those requirements as uncovered — an unresolved gap can only be closed by the Owner, never by silence. Silence about a dropped requirement is a fidelity defect, not a simplification.

EXECUTION CONDITIONS (required — SPEC-RULECODE-QUALITY-001 A1):
- "executionConditions" declares WHICH trusted external facts the principle's enforcement depends on — facts a per-tool-call rule input can never establish by itself (an Owner approval, an external confirmation, a host-side decision). Rule generation is gated on these being resolvable through a trusted-facts source; the generator can never self-declare them satisfied.
- Ground each entry in the SAME Owner-attributed statements as the contract: textualBasis quotes (or precisely cites) the text that states the requirement. NEVER invent a fact requirement that no Owner-attributed text states, and NEVER omit one that it does state.
- factKind vocabulary: use "design_approval" for requirements that an Owner/authority confirm a design BEFORE implementation. Use an empty requiredFacts array ("requiredFacts": []) when the principle is enforceable purely from the observable tool-call input and history window — that is a valid, common answer.
- required: true = the fact MUST be resolvable for a faithful rule to exist. Entries with required:false may be omitted entirely.
- executionConditions MUST be a nested JSON OBJECT with version exactly 1 — never a JSON-encoded string.

CONSTRAINTS:
- Output ONLY valid JSON (no markdown, no explanatory text, no code fences)
- principleDraft.title MUST be a non-empty string (concise, <=100 chars)
- principleDraft.statement MUST be a non-empty string describing the principle
- PD_PROMPT_CAPACITY_V1 R-B1 (prompt.v5): principleDraft.statement is the ONLY text injected into the agent prompt, and that prompt surface has a hard character budget. Write it in the SHORTEST wording that stays sufficient: keep the trigger condition (when it applies), the required action (what must be done), and any necessary exception (when it does not apply) — nothing else. Do NOT move explanatory detail into the statement; rationale, evidence, and history belong in principleDraft.rationale / risks / intentContract, which are NOT injected and have no such pressure. Never pad, never add examples inside the statement, and never trade a necessary trigger/exception for brevity — if any of the three parts disappears, the statement is wrong, not shorter
- principleDraft.rationale MUST be a non-empty string
- principleDraft.applicability MUST be an array of strings (at least one recommended)
- principleDraft.antiPatterns MUST be an array of strings (can be empty)
- principleDraft.confidence MUST be a number between 0.0 and 1.0 (NOT a string, NOT a percentage)
- intentContract is REQUIRED and every one of its five fields MUST be a non-empty string (no placeholders, no "TBD")
- intentContract itself MUST be a nested JSON OBJECT — never a JSON-encoded string (do not double-encode it as a string containing JSON)
- intentContract.ownerIntent / targetBehavior / forbiddenBehavior MUST stay consistent with principleDraft.statement and antiPatterns — they express the SAME intent at different precision, never a different one; shortening the statement MUST NOT drop or weaken any of these anchors
- sourcePhilosopherArtifactId MUST be copied exactly from input.sourcePhilosopherArtifactId (non-empty string)
- sourceTrace.philosopherArtifactId MUST be copied exactly from input.sourcePhilosopherArtifactId
- sourceTrace.dreamerArtifactId: when input.sourceDreamerArtifactId is provided, it MUST be copied exactly from input.sourceDreamerArtifactId (non-empty string); omit the field only when the input does not carry one. Never scrape artifact content for ids — use the input field
- risks MUST be an array of strings (can be empty if no risks identified)
- generatedAt MUST be the current ISO-8601 timestamp (use the actual current time, NOT a placeholder)
- executionConditions is REQUIRED: a nested JSON object { "version": 1, "requiredFacts": [...] }; use "requiredFacts": [] when the principle needs no trusted external fact. Every entry needs non-empty factKind, boolean required, non-empty textualBasis (see EXECUTION CONDITIONS above)
- If the CORE AXIOMS section is provided, ensure the principle draft does not duplicate or contradict any existing core axiom. If overlap exists, note it in risks
${formationEvidenceBlock}${languageDirective}`;
}

/**
 * PRI-703 Phase 1 (Owner decision 2026-09-07): bumped v1 → v2. The scribe
 * output contract gains the required structured intentContract — the single
 * Owner-intent alignment anchor consumed by rule generation, evaluation, and
 * repair. Wire shape is additive; the hand-rolled validator enforces the five
 * non-empty fields when the key is present.
 */
/**
 * PRI-816: bumped v2 → v3. The OUTPUT FORMAT sourceTrace.dreamerArtifactId
 * instruction changed semantics — from "scrape the philosopher artifact for
 * an id (field name mismatched)" to "copy input.sourceDreamerArtifactId
 * exactly" — the prompt input gained `sourceDreamerArtifactId`, and the
 * CONSTRAINTS text tightened accordingly (audit R-01 lineage fix).
 */
/**
 * PRI-838: bumped v3 → v4. The prompt input gained the optional
 * `formationContext` block (dreamer proposals + source diagnosis + provenance)
 * and the system prompt conditionally carries the formation-evidence addendum
 * (`FORMATION_EVIDENCE_ADDENDUM`, the frozen Phase A text). Additive: the
 * OUTPUT FORMAT, the CONSTRAINTS, the validator and `ScribeOutputV1` are
 * unchanged, and a run without formation evidence emits exactly the v3 wire
 * shape plus the new version string.
 */
/**
 * PD_PROMPT_CAPACITY_V1 R-B1: bumped v4 → v5. The CONSTRAINTS gained the
 * statement-brevity requirement: the statement is the only text injected into
 * the budget-capped agent prompt, so it must be the shortest sufficient
 * wording that preserves the trigger condition, required action, and
 * necessary exception — rationale/evidence/history stay in their own
 * (uninjected) fields. Additive wire shape: the OUTPUT FORMAT, the validator,
 * and `ScribeOutputV1` are unchanged (deliberately NO hard char cap and no
 * silent truncation — content validation stays separate from host-capacity
 * prechecks), and a run on v5 emits exactly the v4 shape plus the new
 * version string.
 */
/**
 * Derivation fidelity (2026-10-12 r6): bumped v5 → v6. The INTENT CONTRACT
 * section gains the OWNER-SOURCE GROUNDING block. Live-chain evidence
 * (p1-final r4 chain): the Dreamer proposed a "persisted Owner
 * write-confirmation records" mechanism that appears NOWHERE in the Owner's
 * pain text — the diagnosis carried it only as an implementation
 * RECOMMENDATION — and the scribe wrote it into intentContract.targetBehavior /
 * validationExpectation as if Owner-mandated, while silently narrowing the
 * Owner's protected/ access requirement to write-only gating with no
 * disclosure. The evaluator then enforced the contract as the correctness
 * definition and the chain died demanding a check the RuleHost input contract
 * cannot express. v6 obliges the scribe to (a) ground contract requirements
 * in the diagnosis's Owner-attributed statements — never in implementation
 * recommendations, and (b) declare every Owner-attributed requirement NOT
 * carried into the contract. Additive: the OUTPUT FORMAT, the validator, and
 * `ScribeOutputV1` are unchanged; a run on v6 emits exactly the v5 wire shape
 * plus the new version string.
 */
/**
 * r6 review fixes (2026-10-12, Owner review of #2000): bumped v6 → v7.
 * (P1-2) The v6 gap disclosure was a free-text risks prefix
 * ("owner_requirement_gap:") with NO downstream consumer — a declared gap had
 * no deterministic path to Owner disposition, and the r6 chain still narrowed
 * the protected/ read requirement with only partial disclosure. Gaps now go
 * into the STRUCTURED "ownerRequirementGaps" output field: validated
 * (present-but-malformed is a hard rejection), carried on the artifact, read
 * by the pipeline result, and consumed by the evaluator as obligations the
 * contract does NOT cover. The derived_mechanism: risks prefix is unchanged
 * (informational mechanism disclosure). Wire shape is additive; a run on v7
 * emits exactly the v6 shape plus the new optional field and version string.
 */
/**
 * SPEC-RULECODE-QUALITY-001 A1 (2026-10-16): bumped v7 → v8. The OUTPUT
 * FORMAT gains the structured `executionConditions` declaration ({version:1,
 * requiredFacts:[{factKind,required,textualBasis}]}) + the EXECUTION
 * CONDITIONS instruction block: which trusted external facts the principle's
 * enforcement depends on, each grounded in the Owner-attributed text. The
 * artificer intent preflight consumes it BEFORE any generation call — a
 * declared required fact without a resolvable trusted source stops the chain
 * at a reviewable point with zero model calls; the generator can never
 * self-declare the fact satisfied. `requiredFacts: []` (enforceable from the
 * observable input alone) is a valid, expected answer. Wire shape is
 * additive; element validation is hand-rolled in DefaultScribeValidator
 * (present-but-malformed is a hard rejection).
 */
export const SCRIBE_PROMPT_CONTRACT_VERSION = 'scribe-output-v1.prompt.v8';

export class ScribePromptBuilder {
  private readonly coreGrounding: boolean;
  private readonly outputLanguage?: OutputLanguage;

  constructor(opts: { coreGrounding?: boolean; outputLanguage?: OutputLanguage } = {}) {
    this.coreGrounding = opts.coreGrounding ?? false;
    this.outputLanguage = opts.outputLanguage;
  }

  /**
   * Build a scribe prompt with optional core axiom grounding and language directive (PRI-336).
   */
  buildPrompt(input: ScribePromptBuilderInput): ScribePromptBuildResult {
    const coreGrounding = input.coreGrounding ?? this.coreGrounding;
    const outputLanguage = input.outputLanguage ?? this.outputLanguage;

    const scribeInstruction = buildScribeProtocolInstruction({
      coreGrounding,
      outputLanguage,
      formationEvidence: input.formationContext !== undefined,
    });

    const promptInput: ScribePromptInput = {
      taskId: input.taskId,
      contextHash: input.contextHash,
      sourcePhilosopherArtifactId: input.sourcePhilosopherArtifactId,
      ...(input.sourceDreamerArtifactId !== undefined
        ? { sourceDreamerArtifactId: input.sourceDreamerArtifactId }
        : {}),
      philosopherArtifact: input.philosopherArtifact,
      // PRI-838: only included when formation evidence actually resolved, so a
      // degraded run's payload stays byte-compatible with the v3 shape.
      ...(input.formationContext !== undefined ? { formationContext: input.formationContext } : {}),
      promptContractVersion: SCRIBE_PROMPT_CONTRACT_VERSION,
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput, systemPrompt: scribeInstruction };
  }
}
