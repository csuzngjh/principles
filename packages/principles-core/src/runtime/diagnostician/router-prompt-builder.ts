/**
 * RouterPromptBuilder — Stage C prompt builder for the split diagnostician pipeline.
 *
 * The Router stage receives both Stage A (Root Cause) and Stage B (Distiller)
 * artifacts and produces the final `DiagnosticianOutputV2` — the only
 * production diagnostician contract (PRI-1146 V2 Only / Clean Break).
 *
 * Unlike the monolithic DiagnosticianPromptBuilder which runs the full 5-phase
 * protocol, the Router does NOT re-derive root causes or invent new principles.
 * It routes what the distiller produced into the appropriate recommendation
 * taxonomy kind(s).
 *
 * V2 contract obligations baked into the instruction (SPEC v0.6 §3/§4):
 *   - every recommendation carries an artifact-locally-unique `recommendationRef`;
 *   - every rule recommendation carries a `principleAssociation`;
 *   - association targets are either a same-artifact `recommendation_ref` to the
 *     unique principle recommendation, or a `canonical_principle` id drawn from
 *     the system-provided trusted context below — never a model-invented id,
 *     never a free-text relation, never a database candidate UUID;
 *   - when the relation cannot be determined, the model MUST emit
 *     `status: "unresolved"` with a reason instead of guessing.
 *
 * @see PRI-372 — Split diagnostician into Stage A (Root Cause) + Stage B (Distiller) + Stage C (Router)
 * @see PRI-1146 — Diagnostician Output V2 Only
 */

import type { TSchema } from '@sinclair/typebox';
import type { SchemaPromptAdapter } from '../adapter/schema-prompt-adapter.js';
import { DefaultSchemaPromptAdapter } from '../adapter/schema-prompt-adapter.js';
import { DiagnosticianOutputV2Schema } from '../diagnostician-output.js';
import type { DiagRootCauseOutputV1 } from './diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from './diag-distiller-output.js';
import type { BuildPromptOptions } from '../diagnostician-prompt-builder.js';
import type { OutputLanguage } from '../language-directive.js';
import { buildLanguageDirective } from '../language-directive.js';
import type { RouterTrustedPrinciple } from '../internalization/router-context-evidence.js';

// ── Options ──────────────────────────────────────────────────────────────────

/**
 * Options for RouterPromptBuilder constructor and buildRouterInstruction().
 *
 * Uses opts-object pattern to stay within max-params limit and allow
 * partial overrides at both construction and method-call time.
 *
 * @see PRI-372
 */
export interface RouterPromptBuilderOptions {
  /** Schema prompt adapter (default: DefaultSchemaPromptAdapter) */
  adapter?: SchemaPromptAdapter;
  /** TypeBox schema for output validation (default: DiagnosticianOutputV2Schema) */
  schema?: TSchema;
  /** Output language directive (default: none) */
  outputLanguage?: OutputLanguage;
}

// ── Trusted canonical principle context ─────────────────────────────────────

// RouterTrustedPrinciple (the exposure entry contract) is defined in
// ../internalization/router-context-evidence.ts — the evidence module owns the
// shape so the prompt input and the persisted receipt can never drift.

/**
 * Render the trusted canonical principle allowlist section of the instruction.
 * When the allowlist is empty the block states that canonical_principle
 * targets are unavailable this run, so the model must use recommendation_ref
 * targets or unresolved instead.
 */
function renderTrustedContextBlock(principles: readonly RouterTrustedPrinciple[]): string {
  if (principles.length === 0) {
    return `
TRUSTED CANONICAL PRINCIPLES:
(none available this run — the system did not expose any canonical principle id. You MUST NOT use a canonical_principle association target; link rules to a principle recommendation in this output via recommendation_ref, or use status "unresolved" with reason "principle_not_in_context".)
`;
  }
  const lines = principles.map((p) => `- principleId: ${p.principleId} (status: ${p.status}, version: ${p.version}) text: ${p.text}`);
  return `
TRUSTED CANONICAL PRINCIPLES (the ONLY canonical ids you may reference in principleAssociation targets and violatedPrinciples.principleId):
${lines.join('\n')}
`;
}

// ── Context input ────────────────────────────────────────────────────────────

/**
 * Structured input for the Router stage, carrying both Stage A and Stage B
 * artifacts with their IDs for lineage tracing, plus the system-owned trusted
 * canonical principle context (SPEC v0.6 §5).
 *
 * @see PRI-372
 */
export interface RouterContextInput {
  /** Artifact ID of the Stage A (Root Cause) output */
  rootCauseArtifactId: string;
  /** Stage A output — the root cause analysis result */
  rootCauseOutput: DiagRootCauseOutputV1;
  /** Artifact ID of the Stage B (Distiller) output */
  distillerArtifactId: string;
  /** Stage B output — the distilled principle and grounding */
  distillerOutput: DiagDistillerOutputV1;
  /**
   * Canonical principles actually exposed to the model in this run. Empty when
   * the ledger holds no eligible principles — in that case the prompt must tell
   * the model that canonical_principle targets are unavailable this run.
   */
  trustedCanonicalPrinciples: readonly RouterTrustedPrinciple[];
}

// ── Prompt input & result ────────────────────────────────────────────────────

/**
 * Prompt input for the Router stage — the JSON message sent to the LLM.
 *
 * Unlike the monolithic DiagnosticianPromptBuilder's PromptInput, the router
 * carries Stage A and Stage B artifacts directly rather than a full
 * DiagnosticianContextPayload with conversation window and source refs.
 * The trusted canonical principles travel inside this payload (the runtime
 * adapter ignores StartRunInput.contextItems), which is exactly what the
 * trustedContextReceipt digests.
 *
 * @see PRI-372
 */
export interface RouterPromptInput {
  /** Task being diagnosed — from Stage A output */
  taskId: string;
  /** Artifact ID of the Stage A (Root Cause) output for lineage */
  rootCauseArtifactId: string;
  /** Stage A output — root cause analysis result */
  rootCauseOutput: DiagRootCauseOutputV1;
  /** Artifact ID of the Stage B (Distiller) output */
  distillerArtifactId: string;
  /** Stage B output — distilled principle and grounding */
  distillerOutput: DiagDistillerOutputV1;
  /** Canonical principles exposed to the model this run (system-owned allowlist). */
  trustedCanonicalPrinciples: readonly RouterTrustedPrinciple[];
}

/**
 * Build result for the Router stage — follows the same pattern as PromptBuildResult.
 *
 * @see PRI-372
 */
export interface RouterPromptBuildResult {
  /** JSON string — the exact value to pass as openclaw agent --message argument */
  readonly message: string;
  /** The RouterPromptInput object that was serialized to JSON */
  readonly promptInput: RouterPromptInput;
  /**
   * PRI-633: base-layer system prompt (role + routing protocol). Previously
   * embedded in the payload as `routerInstruction`; now delivered via the
   * system channel by the runtime adapter.
   */
  readonly systemPrompt: string;
}

// ── Builder class ────────────────────────────────────────────────────────────

/**
 * Prompt builder for Stage C (Router) of the split diagnostician pipeline.
 *
 * The Router takes the root cause from Stage A and the distilled principle
 * from Stage B, then decides the concrete carrier(s) — the recommendation
 * taxonomy kind(s) — and assembles the final `DiagnosticianOutputV2`.
 *
 * Key constraint: the Router MUST NOT re-derive the root cause or invent
 * new principles. It routes what the distiller produced.
 *
 * @see PRI-372
 */
export class RouterPromptBuilder {
  private readonly adapter: SchemaPromptAdapter;
  private readonly schema: TSchema;

  constructor(opts: RouterPromptBuilderOptions = {}) {
    this.adapter = opts.adapter ?? new DefaultSchemaPromptAdapter();
    this.schema = opts.schema ?? DiagnosticianOutputV2Schema;
  }

  /**
   * Build the router instruction string — the system-level directive that
   * tells the LLM its role, input format, routing rules, output requirements,
   * and constraints.
   *
   * @param opts - Optional overrides for adapter, schema, and outputLanguage.
   *   When provided, these override the constructor defaults for this call only.
   * @returns The router instruction string.
   *
   * @see PRI-372
   */
  buildRouterInstruction(opts: RouterPromptBuilderOptions & { trustedCanonicalPrinciples?: readonly RouterTrustedPrinciple[] } = {}): string {
    const adapter = opts.adapter ?? this.adapter;
    const schema = opts.schema ?? this.schema;
    const { outputLanguage, trustedCanonicalPrinciples } = opts;

    const example = adapter.generateExample(schema);
    const constraints = adapter.generateConstraints(schema);
    const languageDirective = buildLanguageDirective(outputLanguage);

    const trustedContextBlock = renderTrustedContextBlock(trustedCanonicalPrinciples ?? []);

    return `You are a principle router. Your job is to take an abstracted principle and root cause, and decide the concrete carrier(s).

INPUT:
You receive two structured artifacts:
1. Stage A Root Cause output — contains the causal chain, root cause classification, and evidence.
2. Stage B Distiller output — contains the abstracted principle, rationale, core axiom grounding, scope, and confidence.
${trustedContextBlock}
ROUTING RULES:
Based on the distiller's abstracted principle and the root cause from Stage A, decide the recommendation kind:

- If the principle is broadly applicable across scenarios → kind: "principle"
  (MUST include abstractedPrinciple field)
- If a specific trigger pattern can be identified for deterministic interception → kind: "rule"
  (MUST include triggerPattern and action fields)
- If code/tool enforcement is possible and practical → kind: "implementation"
- If a prompt directive can enforce the behavior → kind: "prompt"
- If insufficient confidence or the finding is too specific/single-instance → kind: "defer"

Default: "principle" is the preferred kind. Only use "defer" for noise signals or genuinely insufficient evidence.

OUTPUT REQUIREMENTS (DiagnosticianOutputV2 — schemaVersion MUST be the literal "diagnostician-output-v2"):
Your output MUST match DiagnosticianOutputV2Schema. You only need to generate these fields:

- schemaVersion: the literal string "diagnostician-output-v2"
- violatedPrinciples: array of violated principles, derived from Stage A's rootCause + Stage B's grounding
  - title: short descriptive name for the violated principle (REQUIRED, 3-8 words)
  - principleId: ONLY if the principle corresponds to an id listed in TRUSTED CANONICAL PRINCIPLES above (or a core axiom e.g. T-01..T-10); otherwise omit
  - rationale: explanation of why this principle was violated (REQUIRED)
- recommendations: one or more entries with the appropriate kind from the routing rules above. EVERY entry MUST include:
  - recommendationRef: a short unique id you invent, unique within this output (e.g. "principle-1", "rule-1"). NEVER a database id/UUID, NEVER reused across entries.
- summary: a concise summary combining Stage A's root cause and Stage B's abstracted principle

For EVERY kind:"rule" recommendation you MUST also include a principleAssociation object, choosing exactly one of:
  - { "status": "linked", "relation": "implements",
      "target": { "type": "recommendation_ref", "recommendationRef": "<ref of the principle entry in THIS output>" },
      "rationale": "<why this rule implements that principle>", "evidenceRefs": ["<sourceRef of an evidence entry in this output>"] }
    — use this when the rule implements a principle recommendation emitted in the same output.
  - { "status": "linked", "relation": "implements",
      "target": { "type": "canonical_principle", "principleId": "<id copied EXACTLY from TRUSTED CANONICAL PRINCIPLES above>" },
      "rationale": "...", "evidenceRefs": ["..."] }
    — use this ONLY for principles listed verbatim in TRUSTED CANONICAL PRINCIPLES. Never invent, guess, or partially match an id.
  - { "status": "unresolved", "reason": "no_supported_target" | "ambiguous_target" | "insufficient_evidence" | "principle_not_in_context" }
    — use this when you cannot prove a single target. "unresolved" is a VALID diagnosis result, not a failure; do NOT force a link.
- evidenceRefs MUST reference sourceRef values that appear in this output's evidence array. Free-text rationale alone is NEVER a substitute for the structured association.

The following fields are auto-filled by the system from upstream artifacts — do NOT generate them:
- rootCause (copied from Stage A)
- evidence (copied from Stage A)
- confidence (copied from Stage B)

CONSTRAINT:
You MUST NOT re-derive the root cause or invent new principles. Route what the distiller produced.
You MUST NOT output candidate ids, database UUIDs, or any id not listed in the trusted context as a principleAssociation target.

CRITICAL: Your ENTIRE response must be ONLY the JSON object below. Do NOT include any text before or after the JSON. Do NOT wrap the JSON in markdown code fences. Do NOT add explanatory prose. Output the raw JSON object and nothing else.

COMPLETE EXAMPLE OUTPUT (follow this exact structure):
${example}

IMPORTANT: The example above is ILLUSTRATIVE ONLY. Your output MUST be based on the actual Stage A and Stage B data provided — do not copy the example text verbatim.

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences, no prose before or after
- Do NOT read files, call tools, or write to any database
${constraints}${languageDirective}`;
  }

  /**
   * Build the full prompt for the Router stage, combining the router
   * instruction with the structured Stage A + Stage B context.
   *
   * @param context - Structured input carrying Stage A and Stage B artifacts
   *   plus the trusted canonical principle allowlist.
   * @param opts - Build options including outputLanguage.
   * @returns RouterPromptBuildResult with JSON message and RouterPromptInput object.
   *
   * @see PRI-372
   */
  buildPrompt(
    context: RouterContextInput,
    opts: BuildPromptOptions = {},
  ): RouterPromptBuildResult {
    const { outputLanguage } = opts;

    const routerInstruction = this.buildRouterInstruction({
      outputLanguage,
      trustedCanonicalPrinciples: context.trustedCanonicalPrinciples,
    });

    const promptInput: RouterPromptInput = {
      taskId: context.rootCauseOutput.taskId,
      rootCauseArtifactId: context.rootCauseArtifactId,
      rootCauseOutput: context.rootCauseOutput,
      distillerArtifactId: context.distillerArtifactId,
      distillerOutput: context.distillerOutput,
      trustedCanonicalPrinciples: context.trustedCanonicalPrinciples,
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput, systemPrompt: routerInstruction };
  }
}
