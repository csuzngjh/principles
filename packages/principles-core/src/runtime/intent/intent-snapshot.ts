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
import {
  assembleIntentDoc,
  classifyIntentSectionContent,
  parseIntentDocSections,
} from './intent-doc.js';

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
  /**
   * True when the body is the shipped template / TODO placeholder rather than
   * Owner-authored content. Mutually exclusive with `missing`.
   *
   * Optional for backward compatibility: a snapshot written before this flag
   * existed is re-classified deterministically by
   * `deriveAuthoredSnapshotSectionKeys()` — historical template text is never
   * trusted just because the flag is absent.
   */
  readonly placeholder?: boolean;
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
    const analysis = classifyIntentSectionContent(KEY_TO_DOC_FIELD[key], body, input.lang);
    if (analysis.state === 'missing') {
      return { key, text: '', missing: true };
    }
    const text = typeof body === 'string' ? body : '';
    const bounded = text.length > maxChars ? text.slice(0, maxChars) : text;
    const truncated = text.length > maxChars ? { truncated: true as const } : {};
    // A placeholder still stores its (bounded) text for audit, but is marked so
    // no downstream stage can mistake a template question for Owner intent.
    return analysis.state === 'placeholder'
      ? { key, text: bounded, placeholder: true, ...truncated }
      : { key, text: bounded, ...truncated };
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
 * The authoritative "this section is real Owner intent" set for a snapshot.
 *
 * Deterministic and snapshot-local: the explicit `missing` / `placeholder`
 * flags are honoured, and every other section is RE-CLASSIFIED from its stored
 * text with the same pure rules used at capture time. Re-classification is what
 * makes a pre-flag (historical) snapshot safe: a template body is rejected even
 * though it carries no `placeholder` marker.
 */
export function deriveAuthoredSnapshotSectionKeys(
  snapshot: IntentSnapshot,
): ReadonlySet<IntentSnapshotSectionKey> {
  const authored = new Set<IntentSnapshotSectionKey>();
  for (const section of snapshot.sections) {
    if (section.missing === true || section.placeholder === true) continue;
    const analysis = classifyIntentSectionContent(
      KEY_TO_DOC_FIELD[section.key],
      section.text,
      snapshot.lang,
    );
    if (analysis.state === 'authored') authored.add(section.key);
  }
  return authored;
}

/** True when the snapshot carries at least one Owner-authored section. */
export function hasAuthoredSnapshotSections(snapshot: IntentSnapshot): boolean {
  return deriveAuthoredSnapshotSectionKeys(snapshot).size > 0;
}

/**
 * Section-level variant used by tolerant projections (FormationContext), where
 * the value is untrusted JSON rather than a validated `IntentSnapshot`.
 *
 * Returns false for an unknown key, a missing/placeholder entry, or a body that
 * re-classifies as template / blank content.
 */
export function isAuthoredSnapshotSection(
  section: unknown,
  lang: IntentLang,
): boolean {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return false;
  const entry = section as Record<string, unknown>;
  if (typeof entry.key !== 'string') return false;
  if (!(INTENT_SNAPSHOT_SECTION_KEYS as readonly string[]).includes(entry.key)) return false;
  if (entry.missing === true || entry.placeholder === true) return false;
  if (typeof entry.text !== 'string') return false;
  const key = entry.key as IntentSnapshotSectionKey;
  return classifyIntentSectionContent(KEY_TO_DOC_FIELD[key], entry.text, lang).state === 'authored';
}

/**
 * Rebuild the document view used by the Stage A prompt.
 *
 * The prompt is always rebuilt from the snapshot (never from disk), so the
 * first attempt and every retry receive the SAME strategic bytes
 * (SPEC §6.6 / TECH §5.4 step 5).
 *
 * Only Owner-authored sections are rendered: a template body must never reach
 * the model as a strategic instruction (SPEC §20.1).
 */
export function intentSnapshotSectionsToDoc(snapshot: IntentSnapshot): IntentDocSections {
  const authored = deriveAuthoredSnapshotSectionKeys(snapshot);
  const doc: IntentDocSections = {};
  for (const section of snapshot.sections) {
    if (!authored.has(section.key)) continue;
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
 * Non-authored sections (missing / template placeholder) are ALWAYS dropped —
 * they are not strategic evidence and must never be persisted as if they were.
 *
 * Three cases, deliberately distinct (SPEC §20.1):
 *   - no declaration (`relatedKeys` empty) → keep every AUTHORED section;
 *   - partial declaration                 → keep `authored ∩ declared`;
 *   - declaration with NO valid entry     → return an explicitly EMPTY section
 *     list. Falling back to the full capture here would let rejected sections
 *     re-enter the strategic basis, which is exactly the defect this guards.
 */
export function filterIntentSnapshotSections(
  snapshot: IntentSnapshot,
  relatedKeys: readonly string[],
): IntentSnapshot {
  const authored = deriveAuthoredSnapshotSectionKeys(snapshot);
  const declared = new Set<string>(relatedKeys);
  const sections = snapshot.sections.filter(
    (section) => authored.has(section.key) && (declared.size === 0 || declared.has(section.key)),
  );
  return { ...snapshot, sections };
}

/** Explicit "no usable strategic sections" projection (never the full capture). */
export function emptyIntentSnapshotSections(snapshot: IntentSnapshot): IntentSnapshot {
  return { ...snapshot, sections: [] };
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
    if (Object.hasOwn(entry, 'placeholder') && typeof entry.placeholder !== 'boolean') return false;
    if (entry.truncated === true && entry.missing === true) return false;
    // `missing` (nothing there) and `placeholder` (template text there) are
    // mutually exclusive by definition.
    if (entry.missing === true && entry.placeholder === true) return false;
  }
  return true;
}
