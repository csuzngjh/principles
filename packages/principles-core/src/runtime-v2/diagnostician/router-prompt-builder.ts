/**
 * RouterPromptBuilder — Stage C prompt builder for the split diagnostician pipeline.
 *
 * The Router stage receives both Stage A (Root Cause) and Stage B (Distiller)
 * artifacts and produces the final `DiagnosticianOutputV1` — the unchanged
 * downstream contract consumed by the rest of the system.
 *
 * Unlike the monolithic DiagnosticianPromptBuilder which runs the full 5-phase
 * protocol, the Router does NOT re-derive root causes or invent new principles.
 * It routes what the distiller produced into the appropriate recommendation
 * taxonomy kind(s).
 *
 * @see PRI-372 — Split diagnostician into Stage A (Root Cause) + Stage B (Distiller) + Stage C (Router)
 */

import type { TSchema } from '@sinclair/typebox';
import type { SchemaPromptAdapter } from '../adapter/schema-prompt-adapter.js';
import { DefaultSchemaPromptAdapter } from '../adapter/schema-prompt-adapter.js';
import { DiagnosticianOutputV1Schema } from '../diagnostician-output.js';
import type { DiagRootCauseOutputV1 } from './diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from './diag-distiller-output.js';
import type { BuildPromptOptions } from '../diagnostician-prompt-builder.js';
import type { OutputLanguage } from '../language-directive.js';
import { buildLanguageDirective } from '../language-directive.js';

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
  /** TypeBox schema for output validation (default: DiagnosticianOutputV1Schema) */
  schema?: TSchema;
  /** Output language directive (default: none) */
  outputLanguage?: OutputLanguage;
}

// ── Context input ────────────────────────────────────────────────────────────

/**
 * Structured input for the Router stage, carrying both Stage A and Stage B
 * artifacts with their IDs for lineage tracing.
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
}

// ── Prompt input & result ────────────────────────────────────────────────────

/**
 * Prompt input for the Router stage — the JSON message sent to the LLM.
 *
 * Unlike the monolithic DiagnosticianPromptBuilder's PromptInput, the router
 * carries Stage A and Stage B artifacts directly rather than a full
 * DiagnosticianContextPayload with conversation window and source refs.
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
  /** Artifact ID of the Stage B (Distiller) output for lineage */
  distillerArtifactId: string;
  /** Stage B output — distilled principle and grounding */
  distillerOutput: DiagDistillerOutputV1;
  /** Router instruction — the system-level directive for the LLM */
  routerInstruction: string;
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
}

// ── Builder class ────────────────────────────────────────────────────────────

/**
 * Prompt builder for Stage C (Router) of the split diagnostician pipeline.
 *
 * The Router takes the root cause from Stage A and the distilled principle
 * from Stage B, then decides the concrete carrier(s) — the recommendation
 * taxonomy kind(s) — and assembles the final `DiagnosticianOutputV1`.
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
    this.schema = opts.schema ?? DiagnosticianOutputV1Schema;
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
  buildRouterInstruction(opts: RouterPromptBuilderOptions = {}): string {
    const adapter = opts.adapter ?? this.adapter;
    const schema = opts.schema ?? this.schema;
    const {outputLanguage} = opts;

    const example = adapter.generateExample(schema);
    const constraints = adapter.generateConstraints(schema);
    const languageDirective = buildLanguageDirective(outputLanguage);

    return `You are a principle router. Your job is to take an abstracted principle and root cause, and decide the concrete carrier(s).

INPUT:
You receive two structured artifacts:
1. Stage A Root Cause output — contains the causal chain, root cause classification, and evidence.
2. Stage B Distiller output — contains the abstracted principle, rationale, core axiom grounding, scope, and confidence.

ROUTING RULES:
Based on the distiller's abstracted principle and the root cause from Stage A, decide the recommendation kind:

- If the principle is broadly applicable across scenarios → kind: "principle"
  (MUST include abstractedPrinciple field)
- If a specific trigger pattern can be identified for deterministic interception → kind: "rule"
  (MUST include triggerPattern and action fields)
- If code/tool enforcement is possible and practical → kind: "implementation"
- If a prompt directive can enforce the behavior → kind: "prompt"
- If insufficient confidence or the finding is too specific/single-instance → kind: "defer"

OUTPUT REQUIREMENTS:
Your output MUST match DiagnosticianOutputV1Schema. Key fields:

- violatedPrinciples: array of violated principles, derived from Stage A's rootCause + Stage B's grounding
  - title: short descriptive name for the violated principle (REQUIRED, 3-8 words)
  - principleId: if the principle corresponds to a core axiom (e.g. T-01 through T-10), include the axiom ID; otherwise omit
  - rationale: explanation of why this principle was violated (REQUIRED)
- recommendations: one or more entries with the appropriate kind from the routing rules above
- rootCause: MUST match Stage A's rootCause exactly — do not rephrase or re-derive
- evidence: MUST match Stage A's evidence entries
- confidence: MUST match Stage B's confidence value
- summary: a concise summary combining Stage A's root cause and Stage B's abstracted principle

CONSTRAINT:
You MUST NOT re-derive the root cause or invent new principles. Route what the distiller produced.

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
   * @param context - Structured input carrying Stage A and Stage B artifacts.
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

    const routerInstruction = this.buildRouterInstruction({ outputLanguage });

    const promptInput: RouterPromptInput = {
      taskId: context.rootCauseOutput.taskId,
      rootCauseArtifactId: context.rootCauseArtifactId,
      rootCauseOutput: context.rootCauseOutput,
      distillerArtifactId: context.distillerArtifactId,
      distillerOutput: context.distillerOutput,
      routerInstruction,
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput };
  }
}
