/**
 * DistillerPromptBuilder — Stage B prompt builder for the split diagnostician pipeline.
 *
 * Constructs the prompt for the Distiller stage (Stage B). It receives the
 * Stage A root cause artifact as input and produces an abstracted principle
 * grounded on core axioms (T-01..T-10).
 *
 * ## Prompt Sections
 *
 * 1. Role — principle distiller identity
 * 2. Input — Stage A root cause output (structured data)
 * 3. Core Axioms — T-01..T-10 list (when coreGrounding=true)
 * 4. Output Requirements — DiagDistillerOutputV1Schema
 * 5. Quality Guard — abstract vs rule-like distinction
 *
 * @see PRI-372
 */

import type { TSchema } from '@sinclair/typebox';
import type { SchemaPromptAdapter } from '../adapter/schema-prompt-adapter.js';
import { DefaultSchemaPromptAdapter } from '../adapter/schema-prompt-adapter.js';
import { DiagDistillerOutputV1Schema } from './diag-distiller-output.js';
import type { DiagRootCauseOutputV1 } from './diag-rootcause-output.js';
import { CORE_PRINCIPLES } from '../core-principles/core-principle-registry.js';
import type { OutputLanguage } from '../language-directive.js';
import { buildLanguageDirective } from '../language-directive.js';
import type { BuildPromptOptions } from '../diagnostician-prompt-builder.js';

// ── Options ──────────────────────────────────────────────────────────────────

/**
 * Options for DistillerPromptBuilder constructor and buildDistillerInstruction.
 *
 * Uses an opts-object pattern to satisfy @typescript-eslint/max-params.
 *
 * @see PRI-372
 */
export interface DistillerPromptBuilderOptions {
  /** Schema prompt adapter (default: DefaultSchemaPromptAdapter) */
  adapter?: SchemaPromptAdapter;
  /** TypeBox schema for output validation (default: DiagDistillerOutputV1Schema) */
  schema?: TSchema;
  /** Output language directive (default: none) */
  outputLanguage?: OutputLanguage;
  /** Inject core axiom grounding section (default: false) */
  coreGrounding?: boolean;
}

// ── Context input ────────────────────────────────────────────────────────────

/**
 * Input context for the Distiller stage (Stage B).
 *
 * Contains the Stage A root cause artifact ID and output, plus an optional
 * coreGrounding flag that overrides the builder-level default.
 *
 * @see PRI-372
 */
export interface DistillerContextInput {
  /** Artifact ID of the Stage A root cause output — used for lineage tracing */
  rootCauseArtifactId: string;
  /** Stage A root cause output — the structured data to abstract from */
  rootCauseOutput: DiagRootCauseOutputV1;
  /** Override builder-level coreGrounding for this specific invocation */
  coreGrounding?: boolean;
}

// ── Prompt input & result ────────────────────────────────────────────────────

/**
 * PromptInput for the Distiller stage (Stage B).
 *
 * Unlike Stage A (which uses the full DiagnosticianContextPayload),
 * Stage B receives only the Stage A root cause artifact and the
 * distiller instruction.
 *
 * @see PRI-372
 */
export interface DistillerPromptInput {
  /** Artifact ID of the Stage A root cause output — for lineage tracing */
  rootCauseArtifactId: string;
  /** Stage A root cause output — the structured data to abstract from */
  rootCauseOutput: DiagRootCauseOutputV1;
  /** Distiller protocol instruction for the LLM */
  distillerInstruction: string;
}

/**
 * Build result for the Distiller stage (Stage B).
 *
 * Follows the same contract as PromptBuildResult but with a
 * DistillerPromptInput shape specific to Stage B.
 *
 * @see PRI-372
 */
export interface DistillerPromptBuildResult {
  /** JSON string — the exact value to pass as openclaw agent --message argument */
  readonly message: string;
  /** The DistillerPromptInput object that was serialized to JSON */
  readonly promptInput: DistillerPromptInput;
}

// ── Instruction builder ──────────────────────────────────────────────────────

/**
 * Build the Stage B distiller protocol instruction.
 *
 * When `coreGrounding` is true, the Core Axioms section is included with
 * the full T-01..T-10 list and a strict instruction prohibiting fabricated
 * axiom IDs. When false or undefined, the section is omitted.
 *
 * @see PRI-372
 */
export function buildDistillerProtocolInstruction(
  opts: DistillerPromptBuilderOptions = {},
): string {
  const adapter = opts.adapter ?? new DefaultSchemaPromptAdapter();
  const schema = opts.schema ?? DiagDistillerOutputV1Schema;
  const { outputLanguage, coreGrounding } = opts;

  const example = adapter.generateExample(schema);
  const constraints = adapter.generateConstraints(schema);
  const languageDirective = buildLanguageDirective(outputLanguage);

  // Core Axioms section — only when coreGrounding is true
  const coreAxiomsBlock = coreGrounding
    ? `
CORE AXIOMS:
The following core axioms are the system's foundational behavioral principles.
You MUST only reference axiom IDs from this list. Fabricating IDs not in this
list will cause validation failure.

${CORE_PRINCIPLES.map(p => `${p.id}: ${p.statement}`).join('\n')}

`
    : '';

  return `You are a principle distiller. Your job is to abstract a specific root cause into a general, cross-scenario principle.

INPUT:
You will receive the Stage A root cause output as structured data. This contains:
- summary: a concise description of the diagnosis
- causalChain: the 5-Whys causal chain
- rootCause: the classified root cause with category prefix
- rootCauseCategory: People | Design | Assumption | Tooling
- evidence: supporting evidence entries
- confidence: the Stage A confidence score
${coreAxiomsBlock}OUTPUT REQUIREMENTS:
Your output MUST match the following JSON schema exactly.

COMPLETE EXAMPLE OUTPUT (follow this exact structure):
${example}

Key fields:
- abstractedPrinciple: ≤200 chars, abstract, cross-scenario principle that grows from the root cause
- groundedOnCorePrincipleIds: subset of the provided axiom IDs above (empty array if none apply)
- sourceRootCauseArtifactId: MUST match the provided artifact ID exactly
- scope: 'general' | 'domain' | 'scenario'
- rationale: why this principle addresses the root cause
- confidence: 0-1 scale

QUALITY GUARD:
Your principle must be ABSTRACT, not rule-like. Avoid concrete trigger patterns,
specific tools, or implementation details. A principle is directional wisdom;
a rule is a boundary condition.

Examples:
- GOOD (abstract principle): "Prefer understanding the existing structure before modifying it"
- BAD (rule-like): "Always run grep before editing files" or "Never use as casts"
- GOOD (intent over technique): "Explicitly stated user constraints take precedence over inferred optimal paths"
- BAD (technique-specific): "Do not create project files in /tmp directory"

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences, no prose before or after
- Do NOT read files, call tools, or write to any database
- abstractedPrinciple MUST be ≤200 characters
- groundedOnCorePrincipleIds MUST only contain IDs from the provided axiom list${coreGrounding ? ' above' : ''}; fabricated IDs cause validation failure
- sourceRootCauseArtifactId MUST match the provided artifact ID
${constraints}${languageDirective}`;
}

// ── Prompt builder class ─────────────────────────────────────────────────────

/**
 * DistillerPromptBuilder — Stage B prompt builder for the split diagnostician pipeline.
 *
 * Receives the Stage A root cause artifact as input and produces an abstracted
 * principle grounded on core axioms (T-01..T-10).
 *
 * Uses an opts-object pattern for all methods to satisfy @typescript-eslint/max-params.
 *
 * @see PRI-372
 */
export class DistillerPromptBuilder {
  private readonly adapter: SchemaPromptAdapter;
  private readonly schema: TSchema;

  constructor(opts: DistillerPromptBuilderOptions = {}) {
    this.adapter = opts.adapter ?? new DefaultSchemaPromptAdapter();
    this.schema = opts.schema ?? DiagDistillerOutputV1Schema;
  }

  /**
   * Build the Stage B distiller protocol instruction.
   *
   * Contains the role definition, input description, core axioms section
   * (when coreGrounding=true), output requirements, and quality guard.
   *
   * @see PRI-372
   */
  buildDistillerInstruction(opts: DistillerPromptBuilderOptions = {}): string {
    return buildDistillerProtocolInstruction({
      adapter: opts.adapter ?? this.adapter,
      schema: opts.schema ?? this.schema,
      outputLanguage: opts.outputLanguage,
      coreGrounding: opts.coreGrounding,
    });
  }

  /**
   * Build the full prompt for Stage B.
   *
   * Constructs a DistillerPromptBuildResult containing the JSON message to pass
   * as the --message argument to the LLM agent. The message includes the
   * distiller instruction and the Stage A root cause context.
   *
   * Per DPB-02: Output is ONLY JSON — no markdown, no file ops, no tool calls.
   * Per DPB-05: This method only builds the prompt; it does NOT commit to PD database.
   *
   * @see PRI-372
   */
  buildPrompt(
    context: DistillerContextInput,
    opts: BuildPromptOptions = {},
  ): DistillerPromptBuildResult {
    const { outputLanguage } = opts;
    const coreGrounding = context.coreGrounding ?? opts.coreGrounding;

    const distillerInstruction = this.buildDistillerInstruction({
      outputLanguage,
      coreGrounding,
    });

    const promptInput: DistillerPromptInput = {
      rootCauseArtifactId: context.rootCauseArtifactId,
      rootCauseOutput: context.rootCauseOutput,
      distillerInstruction,
    };

    const message = JSON.stringify(promptInput);

    return { message, promptInput };
  }
}
