/**
 * PRI-982 (SPEC-PD-IAER-001 FR-03) — ownerEvidenceSelection PI metadata field.
 *
 * The Owner-labelled evidence selection travels in `pi_metadata` inside
 * diagnosticJson (P4: no second task store). Contract pinned here:
 *
 *   - round-trip: serialize → parse preserves the selection verbatim;
 *   - ABSENT = legacy record (Owner has not attached evidence yet) — parses
 *     fine, hydrates as undefined;
 *   - present-but-malformed fails the WHOLE metadata (rc-3 fail-closed — a
 *     corrupted authority record must never silently degrade into "no
 *     selection", which would misread as owner_evidence_required);
 *   - merge carries the selection like every other PI field (P4 single
 *     rebuild point) so an NHR transition never drops it;
 *   - hydrate surfaces the selection on the PITaskRecord.
 *
 * Shape authority is `validateOwnerEvidenceSelectionShape`
 * (evidence-readiness.ts) — the same structural rules the readiness gate
 * enforces, reused here instead of a second divergent validator.
 */
import { describe, expect, it } from 'vitest';
import {
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  mergePITaskMetadata,
  parsePITaskMetadata,
  serializePITaskMetadata,
  type PITaskMetadata,
} from '../pitask-metadata.js';
import type { OwnerEvidenceSelection } from '../evidence-readiness.js';
import type { TaskRecord } from '../../task-status.js';

const BASE_METADATA: PITaskMetadata = {
  dependencyTaskIds: ['scribe-001'],
  channel: 'code_tool_hook',
  timeoutMs: 300_000,
  inputArtifactRefs: [],
  outputArtifactRefs: [],
};

const VALID_SELECTION: OwnerEvidenceSelection = {
  sourcePainId: 'pain_001',
  sourceNegativeToolCallId: 42,
  positiveToolCallIds: [7, 8],
  ownerDesiredOutcome: 'block writes outside the workspace',
};

function makeTaskRecord(diagnosticJson: string): TaskRecord {
  return {
    taskId: 'artificer-001',
    taskKind: 'artificer',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson,
  };
}

describe('PITaskMetadata.ownerEvidenceSelection (PRI-982 FR-03)', () => {
  it('round-trips a valid selection through serialize → parse', () => {
    const json = serializePITaskMetadata({ ...BASE_METADATA, ownerEvidenceSelection: VALID_SELECTION });
    const parsed = parsePITaskMetadata(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.ownerEvidenceSelection).toEqual(VALID_SELECTION);
  });

  it('parses legacy records without the field (ABSENT = owner has not attached evidence)', () => {
    const parsed = parsePITaskMetadata(createPITaskDiagnosticJson(BASE_METADATA));
    expect(parsed).not.toBeNull();
    expect(parsed?.ownerEvidenceSelection).toBeUndefined();
  });

  it('fails the WHOLE metadata when the selection is not a plain object', () => {
    const raw = JSON.parse(createPITaskDiagnosticJson(BASE_METADATA)) as Record<string, unknown>;
    (raw.pi_metadata as Record<string, unknown>).ownerEvidenceSelection = 'blocked please';
    expect(parsePITaskMetadata(JSON.stringify(raw))).toBeNull();
  });

  it('fails the WHOLE metadata when a selection field is malformed (rc-3, rc-4)', () => {
    const malformed: readonly unknown[] = [
      { ...VALID_SELECTION, sourcePainId: '' },
      { ...VALID_SELECTION, sourceNegativeToolCallId: 0 },
      { ...VALID_SELECTION, sourceNegativeToolCallId: '42' },
      { ...VALID_SELECTION, positiveToolCallIds: [] },
      { ...VALID_SELECTION, positiveToolCallIds: [7, 7] },
      { ...VALID_SELECTION, positiveToolCallIds: [7, '8'] },
      { ...VALID_SELECTION, positiveToolCallIds: [1, 2, 3, 4] },
      { ...VALID_SELECTION, ownerDesiredOutcome: '   ' },
      { sourcePainId: 'pain_001', sourceNegativeToolCallId: 42, positiveToolCallIds: [7] },
    ];
    for (const selection of malformed) {
      const raw = JSON.parse(createPITaskDiagnosticJson(BASE_METADATA)) as Record<string, unknown>;
      (raw.pi_metadata as Record<string, unknown>).ownerEvidenceSelection = selection;
      expect(parsePITaskMetadata(JSON.stringify(raw)), `expected null for ${JSON.stringify(selection)}`).toBeNull();
    }
  });

  it('merge carries the selection from the base record (single rebuild point)', () => {
    const base = {
      ...BASE_METADATA,
      ownerEvidenceSelection: VALID_SELECTION,
    } as PITaskMetadata & { taskId?: string };
    const merged = mergePITaskMetadata(
      { ...base, taskId: 'artificer-001', taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3 } as never,
      { humanReviewContext: undefined },
    );
    expect(merged.ownerEvidenceSelection).toEqual(VALID_SELECTION);
  });

  it('hydrates the selection onto the PITaskRecord', () => {
    const task = makeTaskRecord(
      serializePITaskMetadata({ ...BASE_METADATA, ownerEvidenceSelection: VALID_SELECTION }),
    );
    const hydrated = hydratePITaskRecord(task);
    expect(hydrated).not.toBeNull();
    expect(hydrated?.ownerEvidenceSelection).toEqual(VALID_SELECTION);
  });

  it('hydrates legacy records with ownerEvidenceSelection undefined', () => {
    const task = makeTaskRecord(createPITaskDiagnosticJson(BASE_METADATA));
    const hydrated = hydratePITaskRecord(task);
    expect(hydrated).not.toBeNull();
    expect(hydrated?.ownerEvidenceSelection).toBeUndefined();
  });
});
