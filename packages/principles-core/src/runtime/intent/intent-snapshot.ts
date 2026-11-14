/**
 * IntentSnapshot — the server-authored strategic basis captured at Stage A.
 *
 * SPEC-PD-STRATEGIC-INTENT-ANCHORING-001 v1.2 §6.2 / §6.3 and
 * TECH-PD-STRATEGIC-INTENT-ANCHORING-001 v1.1 §3.3 / §3.4 / §3.5.
 *
 * Why this exists: `intentTension.intentDocHash` alone cannot reconstruct what
 * the Owner actually said — the version store has no lookup by content hash and
 * a direct edit of INTENT.md records no version at all. The snapshot therefore
 * stores the bounded section TEXT of the document that was actually injected,
 * with the server-computed hash and the capture time.
 *
 * Trust boundary (rc-1 / rc-5 / rc-8):
 *   - this module is pure: no I/O, no crypto, no clock — `capturedAt` is
 *     supplied by the caller;
 *   - the hash is NEVER computed from model output; it is the value the
 *     server-side reader produced from the raw file;
 *   - every persisted snapshot is re-validated element-wise before use.
 *
 * Placement: a sibling key of the Stage A artifact `contentJson`
 * (`{ ...output, intentSnapshot }`). It must not live inside `intentTension`,
 * whose schema is `additionalProperties: false`.
 */

import type { IntentDocSections, IntentLang } from './intent-doc.js';
import { assembleIntentDoc, parseIntentDocSections } from './intent-doc.js';

/** Version of the snapshot block shape (SPEC §6.3). */
export const INTENT_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * Per-section character cap (TECH §3.3 constraint 2 — "建议 1200 字符").
 * The cap bounds both the durable artifact and the rebuilt prompt, so a
 * truncated section is recorded explicitly (`truncated: true`) instead of
 * being silently shortened.
 */
export const INTENT_SNAPSHOT_SECTION_MAX_CHARS = 1200;

/** Canonical section keys, in document order. */
export const INTENT_SNAPSHOT_SECTION_KEYS = [
  'why',
  'desired_outcome',
  'non_negotiables',
  'stop_escalation',
  'current_strategic_focus',
] as const;

export type IntentSnapshotSectionKey = (typeof INTENT_SNAPSHOT_SECTION_KEYS)[number];

export interface IntentSnapshotSection {
  readonly key: IntentSnapshotSectionKey;
  /** The section body at capture time (bounded; empty when `missing`). */
  readonly text: string;
  /** True when the body exceeded INTENT_SNAPSHOT_SECTION_MAX_CHARS. */
  readonly truncated?: boolean;
  /** True when the section header/body was absent or empty in the document. */
  readonly missing?: boolean;
}

export interface IntentSnapshot {
  readonly schemaVersion: typeof INTENT_SNAPSHOT_SCHEMA_VERSION;
  /** Server-computed content hash of the document that was injected. */
  readonly contentHash: string;
  /** ISO timestamp of the Stage A read (SPEC §6.4). */
  readonly capturedAt: string;
  /** Optional link to an existing IntentDocVersionStore row. */
  readonly intentVersionId?: string;
  readonly lang: IntentLang;
  readonly sections: readonly IntentSnapshotSection[];
}

/** Snapshot key -> `IntentDocSections` field (the existing parse model). */
const KEY_TO_DOC_FIELD: Record<IntentSnapshotSectionKey, keyof IntentDocSections> = {
  why: 'why',
  desired_outcome: 'desiredOutcome',
  non_negotiables: 'nonNegotiables',
  stop_escalation: 'stopEscalation',
  current_strategic_focus: 'currentStrategicFocus',
};

export interface BuildIntentSnapshotInput {
  /** Verbatim document content returned by the reader. */
  readonly raw: string;
  /** Server-computed hash returned by the reader (never the model's). */
  readonly contentHash: string;
  /** ISO capture timestamp supplied by the caller (keeps this module pure). */
  readonly capturedAt: string;
  readonly lang: IntentLang;
  readonly intentVersionId?: string;
  /** Per-section cap override (tests only). */
  readonly sectionMaxChars?: number;
}

/**
 * Build the snapshot from the raw document using the EXISTING parser.
 *
 * Sections are deterministic: `parseIntentDocSections(raw)` only, never model
 * text. A section that was absent (or empty) is recorded as `missing: true`
 * with an empty body — it is never back-filled from the model.
 */
export function buildIntentSnapshot(input: BuildIntentSnapshotInput): IntentSnapshot {
  const maxChars = input.sectionMaxChars ?? INTENT_SNAPSHOT_SECTION_MAX_CHARS;
  const parsed = parseIntentDocSections(input.raw);
  const sections: IntentSnapshotSection[] = INTENT_SNAPSHOT_SECTION_KEYS.map((key) => {
    const body = parsed[KEY_TO_DOC_FIELD[key]];
    if (typeof body !== 'string' || body.trim() === '') {
      return { key, text: '', missing: true };
    }
    if (body.length > maxChars) {
      return { key, text: body.slice(0, maxChars), truncated: true };
    }
    return { key, text: body };
  });

  return {
    schemaVersion: INTENT_SNAPSHOT_SCHEMA_VERSION,
    contentHash: input.contentHash,
    capturedAt: input.capturedAt,
    lang: input.lang,
    sections,
    ...(input.intentVersionId !== undefined ? { intentVersionId: input.intentVersionId } : {}),
  };
}

/**
 * Rebuild the document view used by the Stage A prompt.
 *
 * The prompt is always rebuilt from the snapshot (never from disk), so the
 * first attempt and every retry receive the SAME strategic bytes
 * (SPEC §6.6 / TECH §5.4 step 5).
 */
export function intentSnapshotSectionsToDoc(snapshot: IntentSnapshot): IntentDocSections {
  const doc: IntentDocSections = {};
  for (const section of snapshot.sections) {
    if (section.missing === true) continue;
    doc[KEY_TO_DOC_FIELD[section.key]] = section.text;
  }
  return doc;
}

/** The prompt-ready `intentDoc.raw`, rebuilt deterministically from sections. */
export function renderIntentSnapshotDoc(snapshot: IntentSnapshot): string {
  return assembleIntentDoc(intentSnapshotSectionsToDoc(snapshot));
}

/**
 * Narrow the snapshot to the sections the model declared relevant.
 *
 * SPEC §6.3 asks for only the declared `relevantSections` to be stored. Those
 * fields only exist AFTER the model answers, while the capture must happen
 * BEFORE the call, so capture keeps all five bounded sections and the artifact
 * applies the declared filter here.
 *
 * When the model declared none (no `intentTension`, or an empty
 * `relatedIntentFields`), there is nothing to narrow by. Storing an empty
 * array would degrade the artifact to a hash-only record — exactly what
 * SPEC §6.2 rejects — so the bounded capture is kept as the traceable basis
 * that the diagnosis actually received.
 */
export function filterIntentSnapshotSections(
  snapshot: IntentSnapshot,
  relatedKeys: readonly string[],
): IntentSnapshot {
  if (relatedKeys.length === 0) return snapshot;
  const declared = new Set<string>(relatedKeys);
  const sections = snapshot.sections.filter((section) => declared.has(section.key));
  return { ...snapshot, sections };
}

/** True when the value is a well-formed `IntentSnapshot` (rc-1 / rc-4). */
export function isValidIntentSnapshot(value: unknown): value is IntentSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;

  if (record.schemaVersion !== INTENT_SNAPSHOT_SCHEMA_VERSION) return false;
  if (typeof record.contentHash !== 'string' || !record.contentHash.startsWith('sha256:')) return false;
  if (record.contentHash.length <= 'sha256:'.length) return false;
  if (typeof record.capturedAt !== 'string' || record.capturedAt.trim() === '') return false;
  if (record.lang !== 'zh-CN' && record.lang !== 'en') return false;
  if (Object.hasOwn(record, 'intentVersionId') && record.intentVersionId !== undefined) {
    if (typeof record.intentVersionId !== 'string' || record.intentVersionId.trim() === '') return false;
  }
  if (!Array.isArray(record.sections)) return false;

  const seen = new Set<string>();
  for (const section of record.sections) {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) return false;
    const entry = section as Record<string, unknown>;
    if (typeof entry.key !== 'string') return false;
    if (!(INTENT_SNAPSHOT_SECTION_KEYS as readonly string[]).includes(entry.key)) return false;
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    if (typeof entry.text !== 'string') return false;
    if (Object.hasOwn(entry, 'truncated') && typeof entry.truncated !== 'boolean') return false;
    if (Object.hasOwn(entry, 'missing') && typeof entry.missing !== 'boolean') return false;
    if (entry.truncated === true && entry.missing === true) return false;
  }
  return true;
}
