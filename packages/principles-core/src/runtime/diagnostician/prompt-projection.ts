/**
 * Prompt Projection — SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §6.2.
 *
 * Stage B and Stage C used to send the full upstream artifacts. This module
 * produces a *projection*: the same semantics with verbatim P0 fields, bounded
 * P1 text, and dropped/trimmed P2 text, plus a manifest that records exactly
 * what changed.
 *
 * Hard rules:
 *   - Identifiers, evidence references and provenance are P0 and are never
 *     dropped or rewritten.
 *   - A field is truncated with an explicit record; JSON is never cut blindly
 *     at a string boundary and passed off as complete.
 *   - Trusted context (canonical principles) is copied verbatim. Its
 *     `contentDigest` binds the full text, so truncating it would invalidate
 *     the trust receipt. If the budget cannot hold it, the call is refused.
 *   - If P0 + P1 still exceed the budget, the projection reports
 *     `budgetExceeded` and the runner fails loud instead of sending it.
 */
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { DiagRootCauseOutputV1 } from './diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from './diag-distiller-output.js';
import type { DiagnosticContextBudget, DiagnosticStage } from './diagnostic-context-budget.js';

export interface CompressionEntry {
  readonly path: string;
  readonly priority: 'P1' | 'P2';
  readonly reason: string;
  readonly originalChars: number;
  readonly keptChars: number;
}

export interface CompressionManifest {
  readonly stage: DiagnosticStage;
  readonly originalChars: number;
  readonly keptChars: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly inputBudgetTokens: number | null;
  readonly dropped: readonly CompressionEntry[];
  readonly truncated: boolean;
  /** True only when every P0 identifier/evidence reference survived. */
  readonly keyEvidencePreserved: boolean;
  /** Output repair belongs to the adapter; recorded here for completeness. */
  readonly outputRepairApplied: boolean;
  readonly budgetExceeded: boolean;
  readonly overBudgetTokens: number;
}

export interface StageBProjectionInput {
  readonly rootCauseArtifactId: string;
  readonly rootCauseOutput: DiagRootCauseOutputV1;
}

export interface StageCProjectionInput {
  readonly rootCauseArtifactId: string;
  readonly rootCauseOutput: DiagRootCauseOutputV1;
  readonly distillerArtifactId: string;
  readonly distillerOutput: DiagDistillerOutputV1;
  /** Copied verbatim — never trimmed (see module doc). */
  readonly trustedContext: unknown;
  readonly validationFeedback?: { readonly attempt: number; readonly errors: readonly string[] };
}

interface Truncation {
  readonly path: string;
  readonly priority: 'P1' | 'P2';
  readonly reason: string;
  readonly originalChars: number;
  readonly keptChars: number;
}

const EVIDENCE_NOTE_LIMIT = 300;
const CAUSAL_STATEMENT_LIMIT = 800;
const RATIONALE_LIMIT = 1_000;
const AMBIGUITY_NOTE_LIMIT = 240;
const MAX_AMBIGUITY_NOTES = 5;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function truncateText(text: string, limit: number): { text: string; changed: boolean } {
  if (text.length <= limit) return { text, changed: false };
  return { text: `${text.slice(0, limit)}…`, changed: true };
}

function estimateValue(value: unknown): { chars: number; tokens: number } {
  const serialized = JSON.stringify(value) ?? '';
  return { chars: serialized.length, tokens: estimateTextTokens(serialized) };
}

interface AppliedCompression<T> {
  readonly value: T;
  readonly entries: readonly Truncation[];
}

/**
 * Stage B projections: trim explanatory text (P2) before causal narrative (P1).
 * Evidence `sourceRef` is the reference and is never touched; only `note` is
 * bounded.
 */
function compressStageB(input: StageBProjectionInput): AppliedCompression<StageBProjectionInput> {
  const rootCauseOutput = cloneJson(input.rootCauseOutput);
  const entries: Truncation[] = [];

  for (const [index, evidence] of rootCauseOutput.evidence.entries()) {
    const { text, changed } = truncateText(evidence.note, EVIDENCE_NOTE_LIMIT);
    if (!changed) continue;
    entries.push({
      path: `rootCauseOutput.evidence[${index}].note`,
      priority: 'P2',
      reason: 'evidence note is explanatory; sourceRef preserved as the reference',
      originalChars: evidence.note.length,
      keptChars: text.length,
    });
    evidence.note = text;
  }

  for (const [index, entry] of rootCauseOutput.causalChain.entries()) {
    const { text, changed } = truncateText(entry.statement, CAUSAL_STATEMENT_LIMIT);
    if (!changed) continue;
    entries.push({
      path: `rootCauseOutput.causalChain[${index}].statement`,
      priority: 'P1',
      reason: 'causal statement shortened; why-level and evidenceRefs preserved',
      originalChars: entry.statement.length,
      keptChars: text.length,
    });
    entry.statement = text;
  }

  return { value: { ...input, rootCauseOutput }, entries };
}

/**
 * Stage C additionally bounds the distiller's prose. Trusted context is copied
 * by reference into the projected value, never rewritten.
 */
function compressStageC(input: StageCProjectionInput): AppliedCompression<StageCProjectionInput> {
  const base = compressStageB({
    rootCauseArtifactId: input.rootCauseArtifactId,
    rootCauseOutput: input.rootCauseOutput,
  });
  const projectedB = base.value;
  const distillerOutput = cloneJson(input.distillerOutput);
  const entries: Truncation[] = [...base.entries];

  const rationale = truncateText(distillerOutput.rationale, RATIONALE_LIMIT);
  if (rationale.changed) {
    entries.push({
      path: 'distillerOutput.rationale',
      priority: 'P2',
      reason: 'rationale is explanatory prose; abstractedPrinciple and lineage preserved',
      originalChars: distillerOutput.rationale.length,
      keptChars: rationale.text.length,
    });
    distillerOutput.rationale = rationale.text;
  }

  if (distillerOutput.ambiguityNotes && distillerOutput.ambiguityNotes.length > MAX_AMBIGUITY_NOTES) {
    entries.push({
      path: 'distillerOutput.ambiguityNotes',
      priority: 'P2',
      reason: `only the first ${MAX_AMBIGUITY_NOTES} ambiguity notes are retained`,
      originalChars: distillerOutput.ambiguityNotes.length,
      keptChars: MAX_AMBIGUITY_NOTES,
    });
    distillerOutput.ambiguityNotes = distillerOutput.ambiguityNotes.slice(0, MAX_AMBIGUITY_NOTES);
  }

  if (distillerOutput.ambiguityNotes) {
    distillerOutput.ambiguityNotes = distillerOutput.ambiguityNotes.map((note, index) => {
      const trimmed = truncateText(note, AMBIGUITY_NOTE_LIMIT);
      if (trimmed.changed) {
        entries.push({
          path: `distillerOutput.ambiguityNotes[${index}]`,
          priority: 'P2',
          reason: 'ambiguity note shortened; the note itself is preserved',
          originalChars: note.length,
          keptChars: trimmed.text.length,
        });
      }
      return trimmed.text;
    });
  }

  return {
    value: {
      ...input,
      rootCauseOutput: projectedB.rootCauseOutput,
      distillerOutput,
    },
    entries,
  };
}

interface ProjectionOutcome<T> {
  readonly value: T;
  readonly manifest: CompressionManifest;
  readonly budgetExceeded: boolean;
}

interface FinishProjectionInput<T> {
  readonly stage: DiagnosticStage;
  readonly original: unknown;
  readonly projected: T;
  readonly entries: readonly Truncation[];
  readonly budget: DiagnosticContextBudget;
}

function finishProjection<T>(input: FinishProjectionInput<T>): ProjectionOutcome<T> {
  const { stage, original, projected, entries, budget } = input;
  const before = estimateValue(original);
  const after = estimateValue(projected);
  const budgetTokens = budget.inputBudgetTokens;
  const overBudgetTokens = budgetTokens === null ? 0 : Math.max(0, after.tokens - budgetTokens);
  return {
    value: projected,
    budgetExceeded: budgetTokens !== null && after.tokens > budgetTokens,
    manifest: {
      stage,
      originalChars: before.chars,
      keptChars: after.chars,
      estimatedTokensBefore: before.tokens,
      estimatedTokensAfter: after.tokens,
      inputBudgetTokens: budgetTokens,
      dropped: entries,
      truncated: entries.length > 0,
      // P0 policy: identifiers and evidence references are never modified.
      keyEvidencePreserved: true,
      outputRepairApplied: false,
      budgetExceeded: budgetTokens !== null && after.tokens > budgetTokens,
      overBudgetTokens,
    },
  };
}

export function projectStageBInput(
  input: StageBProjectionInput,
  budget: DiagnosticContextBudget,
): ProjectionOutcome<StageBProjectionInput> {
  const original = cloneJson(input);
  if (budget.inputBudgetTokens === null) {
    return finishProjection<StageBProjectionInput>({ stage: 'B', original, projected: input, entries: [], budget });
  }
  if (estimateValue(input).tokens <= budget.inputBudgetTokens) {
    return finishProjection<StageBProjectionInput>({ stage: 'B', original, projected: input, entries: [], budget });
  }
  const compressed = compressStageB(input);
  return finishProjection<StageBProjectionInput>({
    stage: 'B',
    original,
    projected: compressed.value,
    entries: compressed.entries,
    budget,
  });
}

export function projectStageCInput(
  input: StageCProjectionInput,
  budget: DiagnosticContextBudget,
): ProjectionOutcome<StageCProjectionInput> {
  const original = cloneJson(input);
  if (budget.inputBudgetTokens === null) {
    return finishProjection<StageCProjectionInput>({ stage: 'C', original, projected: input, entries: [], budget });
  }
  if (estimateValue(input).tokens <= budget.inputBudgetTokens) {
    return finishProjection<StageCProjectionInput>({ stage: 'C', original, projected: input, entries: [], budget });
  }
  const compressed = compressStageC(input);
  return finishProjection<StageCProjectionInput>({
    stage: 'C',
    original,
    projected: compressed.value,
    entries: compressed.entries,
    budget,
  });
}
