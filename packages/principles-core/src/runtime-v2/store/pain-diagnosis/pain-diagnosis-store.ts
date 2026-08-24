/**
 * PainDiagnosisStore — durable link between a canonical pain_id and the
 * diagnostician's root-cause attribution for it (Pain Diagnosis Persistence
 * SPEC §4/§5).
 *
 * `pain_events` lives in trajectory.db (host-runtime) while diagnoses are
 * produced by the core runtime writing to `.pd/state.db`, so the two stores
 * are physically separate databases. `pain_id` is a LOGICAL association key —
 * there is no cross-database foreign key. Mixed failures (e.g. an unstable
 * third-party API the agent also failed to guard) are represented as multiple
 * rows sharing one pain_id (one per diagnosis run), NOT a `Mixed` enum value
 * — the RootCauseCategory union stays strictly four-valued (SPEC §9).
 */

import type { RootCauseCategory } from '../../diagnostician/diag-rootcause-output.js';

/** Evidence entry persisted alongside the diagnosis (same shape as DiagnosticianEvidence). */
export interface PainDiagnosisEvidence {
  sourceRef: string;
  note: string;
}

/** A persisted diagnosis row, 1:N per pain_id. */
export interface PainDiagnosisRecord {
  /** Deterministic idempotency key: `${taskId}::${diagnosisId}`. */
  id: string;
  /** Canonical pain id — logical link to trajectory.db pain_events.canonical_pain_id (no FK). */
  painId: string;
  /** The diagnostician task that produced this diagnosis. */
  taskId: string;
  /** diagnosisId from DiagnosticianOutputV1. */
  diagnosisId: string;
  /** Root-cause category parsed from the validated rootCause prefix. */
  category: RootCauseCategory;
  /** Full root cause statement, category prefix included. */
  rootCause: string;
  /** Supporting evidence entries (evidence_json column). */
  evidence: PainDiagnosisEvidence[];
  /** Diagnosis confidence (0..1) — admission gating is NOT re-evaluated here. */
  confidence: number | null;
  /** Artifact row holding the full diagnostician output, when a candidate exists. */
  artifactId: string | null;
  createdAt: string;
}

/** Input for recordPainDiagnosis — id/createdAt are derived. */
export interface PainDiagnosisWriteInput {
  painId: string;
  taskId: string;
  diagnosisId: string;
  category: RootCauseCategory;
  rootCause: string;
  evidence: readonly PainDiagnosisEvidence[];
  confidence: number | null;
  artifactId?: string | null;
}

export interface PainDiagnosisStore {
  /**
   * Persist one diagnosis row. Idempotent per (taskId, diagnosisId): replaying
   * the same diagnosis completion does not duplicate rows.
   */
  recordPainDiagnosis(input: PainDiagnosisWriteInput): Promise<PainDiagnosisRecord>;

  /** All diagnosis rows for a pain, oldest first. */
  getDiagnosesByPainId(painId: string): Promise<PainDiagnosisRecord[]>;
}

const VALID_CATEGORIES: ReadonlySet<string> = new Set(['People', 'Design', 'Assumption', 'Tooling']);

export function isRootCauseCategory(value: unknown): value is RootCauseCategory {
  return typeof value === 'string' && VALID_CATEGORIES.has(value);
}

/**
 * Parse the root-cause category from a DiagnosticianOutputV1.rootCause prefix
 * ("People: ...", "Design: ...", "Assumption: ...", "Tooling: ...").
 *
 * The split-pipeline validator (DefaultDiagRootCauseValidator step 4b) and the
 * router merge (Stage A rootCause wins, EP-07) make the prefix reliable for
 * real pipeline outputs; outputs without a parseable prefix return null so the
 * caller can degrade observably instead of persisting an unknown category.
 *
 * Pure function — no I/O, never throws.
 */
export function parseRootCauseCategory(rootCause: string): RootCauseCategory | null {
  for (const category of ['People', 'Design', 'Assumption', 'Tooling'] as const) {
    if (rootCause.startsWith(`${category}: `)) return category;
  }
  return null;
}

/** Deterministic row id — idempotency key for diagnosis replays. */
export function buildPainDiagnosisId(taskId: string, diagnosisId: string): string {
  return `${taskId}::${diagnosisId}`;
}
