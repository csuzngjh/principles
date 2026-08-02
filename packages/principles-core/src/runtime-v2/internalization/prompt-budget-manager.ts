/**
 * Layer 1 — PromptBudgetManager: budgeted context allocation (design §6.3).
 *
 * Pure logic only (Core vs Plugin boundary, `antipattern-core-io`).
 *
 * `allocateContext` takes a manifest + the available field values (as a
 * `ReadonlyMap<string, unknown>`, rc-1) and produces an `AllocatedContext`:
 * which fields fit the budget, which were truncated, which were dropped, and
 * which were absent. It is a PURE allocation function — it does NOT decide
 * whether to fall back to full-predecessor injection; that decision lives in
 * `resolveInjection` (resolve-injection.ts, task 5.10).
 *
 * Key correctness properties (design §6.3 postconditions):
 *   - `usedTokens <= budgetTokens`
 *   - every dropped/truncated field has a TruncationRecord AND emits a
 *     `context_truncated` event (rc-9 — never silently lose a field; the base
 *     proposal `break`ed on budget exhaustion, dropping remaining fields
 *     without record — ERR-002)
 *   - identical input always yields identical output (total order by
 *     (rank ASC, path ASC), no randomness, no time dependency)
 *   - unknown values go through `safeStringifyPreview` (rc-8) before token
 *     estimation
 *
 * budgetTokens scope (design §6.2.1 / §6.3 — MUST be reflected in comments):
 * covers ONLY manifest-declared injection fields (tier0/tier1/tier2). Does NOT
 * include core grounding, runner base instructions, or output-schema
 * descriptions. `usedTokens <= budgetTokens` is an injection-field budget
 * ceiling, NOT a prompt-total-length hard cap.
 */

import type { ContextManifest } from './context-manifest.js';
import { rankOf, declaredFields } from './context-manifest.js';
import type { SummaryRunnerKind } from './artifact-summary.js';
import { safeStringifyPreview } from '../adapter/output-repair-contract.js';

/** char/4 heuristic; no tokenizer dependency. Monotonically non-decreasing, pure. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Max chars of a single field's serialized preview before token estimation. */
export const FIELD_PREVIEW_MAX_CHARS = 600;

/**
 * Below this remaining budget, a field is dropped whole rather than
 * partially truncated — a partial slice shorter than this carries too little
 * signal to be worth the slot. Expressed in tokens (≈ 4 chars each).
 */
export const MIN_USEFUL_TOKENS = 8;

/** Appended to partially-truncated field text so truncation is explicit (rc-9). */
export const TRUNCATION_MARKER = '…[budget-truncated]';

export interface TruncationRecord {
  readonly fieldPath: string;
  readonly reason: 'budget_exceeded' | 'partially_truncated';
  readonly remainingBudgetTokens: number;
  readonly keptChars: number;
  readonly droppedChars: number;
}

export interface AllocatedContext {
  readonly manifestId: string;
  /** Fields that fit (fully or partially) into the budget. */
  readonly fields: Readonly<Record<string, string>>;
  /** Fields dropped/truncated, each with a reason (rc-9). */
  readonly truncated: readonly TruncationRecord[];
  /** Manifest-declared paths not present in the available map. */
  readonly absent: readonly string[];
  readonly usedTokens: number;
  readonly budgetTokens: number;
}

export interface ContextTruncatedEvent {
  readonly type: 'context_truncated';
  readonly runnerKind: SummaryRunnerKind;
  readonly manifestId: string;
  readonly fieldPath: string;
  readonly reason: TruncationRecord['reason'];
  readonly remainingBudgetTokens: number;
}

interface ScoredField {
  readonly path: string;
  readonly text: string;
  readonly tokens: number;
  readonly rank: number;
}

/**
 * Allocate manifest-declared fields into the token budget (design §6.3).
 *
 * Preconditions: `manifest.budgetTokens > 0`; `available` values are `unknown`
 * (rc-1) and are narrowed only via `safeStringifyPreview`.
 *
 * Postconditions:
 *   - `usedTokens <= budgetTokens`
 *   - every dropped/truncated field has a TruncationRecord and emitted a
 *     `context_truncated` event (rc-9)
 *   - identical input → identical output (total order, deterministic)
 *
 * Loop invariant while traversing: `usedTokens + remainingBudget === budgetTokens`
 * (until a partial truncate zeroes remaining).
 *
 * NOTE: this function does NOT perform the information-floor fallback (design
 * §6.2.2). The fallback is decided by `resolveInjection` after reading this
 * function's `absent` array.
 */
export function allocateContext(
  manifest: ContextManifest,
  available: ReadonlyMap<string, unknown>,
  emit: (event: ContextTruncatedEvent) => void,
): AllocatedContext {
  const paths = declaredFields(manifest);
  const scored: ScoredField[] = [];
  const absent: string[] = [];

  // Score every present path; record absent ones.
  for (const p of paths) {
    if (!available.has(p)) {
      absent.push(p);
      continue;
    }
    const text = safeStringifyPreview(available.get(p), FIELD_PREVIEW_MAX_CHARS);
    scored.push({
      path: p,
      text,
      tokens: estimateTokens(text),
      rank: rankOf(p, manifest),
    });
  }

  // Total order: (rank ASC, path ASC). Deterministic regardless of map
  // insertion order or tier declaration order.
  scored.sort((a, b) => a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const fields: Record<string, string> = {};
  const truncated: TruncationRecord[] = [];
  let remaining = manifest.budgetTokens;

  for (const f of scored) {
    if (f.tokens <= remaining) {
      // Fits fully.
      fields[f.path] = f.text;
      remaining -= f.tokens;
    } else if (remaining > MIN_USEFUL_TOKENS) {
      // Partial truncate: keep a prefix that fits, mark explicitly.
      const keptChars = Math.max(0, remaining * 4 - TRUNCATION_MARKER.length);
      const kept = f.text.slice(0, keptChars) + TRUNCATION_MARKER;
      fields[f.path] = kept;
      const rec: TruncationRecord = {
        fieldPath: f.path,
        reason: 'partially_truncated',
        remainingBudgetTokens: remaining,
        keptChars: kept.length,
        droppedChars: f.text.length - kept.length,
      };
      truncated.push(rec);
      emit({
        type: 'context_truncated',
        runnerKind: manifest.runnerKind,
        manifestId: manifest.manifestId,
        fieldPath: f.path,
        reason: rec.reason,
        remainingBudgetTokens: remaining,
      });
      remaining = 0;
    } else {
      // Drop whole: remaining budget too small for a useful partial. Do NOT
      // break — keep traversing so every remaining field is recorded (rc-9 /
      // ERR-002: the base proposal broke here, silently losing the rest).
      const rec: TruncationRecord = {
        fieldPath: f.path,
        reason: 'budget_exceeded',
        remainingBudgetTokens: remaining,
        keptChars: 0,
        droppedChars: f.text.length,
      };
      truncated.push(rec);
      emit({
        type: 'context_truncated',
        runnerKind: manifest.runnerKind,
        manifestId: manifest.manifestId,
        fieldPath: f.path,
        reason: rec.reason,
        remainingBudgetTokens: remaining,
      });
    }
  }

  return {
    manifestId: manifest.manifestId,
    fields,
    truncated,
    absent,
    usedTokens: manifest.budgetTokens - remaining,
    budgetTokens: manifest.budgetTokens,
  };
}
