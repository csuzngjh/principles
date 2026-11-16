/**
 * SIA v1.2 · PRI-1216 — formation evidence carries the strategic basis.
 *
 * SPEC §9.2: `sourceDiagnosis` is the ONLY entry point for strategic reading
 * downstream, so it must expose Stage A's `intentTension` verbatim, and
 * `provenance` must carry the identity of the exact IntentSnapshot used.
 *
 * Legacy artifacts (no strategic keys) must keep producing the same context —
 * the new fields are additive, never a new required dependency.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { PIArtifactRecord } from '../pi-artifact.js';
import {
  FORMATION_INTENT_SECTIONS_MAX_CHARS,
  resolveFormationContext,
  type FormationTaskView,
} from '../formation-context.js';
import { assembleIntentContractV2 } from '../intent-contract.js';

const NOW = '2026-11-14T00:00:00.000Z';
const DREAMER_TASK = 'dreamer-task-1';
const DIAG_TASK = 'diag-router-task-1';

function artifact(overrides: Partial<PIArtifactRecord> & Pick<PIArtifactRecord, 'artifactId' | 'sourceTaskId' | 'contentJson'>): PIArtifactRecord {
  return {
    artifactKind: 'principle',
    lineageArtifactIds: [],
    validationStatus: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const TASKS: Record<string, FormationTaskView> = {
  [DREAMER_TASK]: { taskKind: 'dreamer', status: 'succeeded', dependencyTaskIds: [DIAG_TASK] },
  [DIAG_TASK]: { taskKind: 'diag_router', status: 'succeeded', dependencyTaskIds: [] },
};

function diagnosisContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: DIAG_TASK,
    rootCause: 'the action bypassed the recorded strategic intent',
    summary: 'strategic drift on a safety-relevant write',
    violatedPrinciples: [{ principleId: 'T-01', title: 'Safety first', rationale: 'unsafe write' }],
    evidence: [{ sourceRef: 'diag#ev1', note: 'observed bypass' }],
    recommendations: ['verify against the intent before writing'],
    confidence: 0.8,
    intentTension: {
      source: 'action_drift',
      evidenceStrength: 'strong',
      relatedIntentFields: ['why', 'non_negotiables'],
      evidence: ['diag#ev1'],
      explanation: 'the action drifted from the stated owner intent',
      intentDocHash: 'sha256:stage-a-hash',
    },
    intentSnapshot: {
      contentHash: 'sha256:stage-a-hash',
      capturedAt: NOW,
      sections: [
        { key: 'why', text: 'protect owner intent' },
        { key: 'non_negotiables', text: 'never merge unverified state' },
      ],
    },
    ...overrides,
  };
}

async function resolve(content: Record<string, unknown>) {
  const store = new MemoryPIArtifactStore();
  await store.upsertArtifact(artifact({
    artifactId: 'pi-art-dreamer-1',
    sourceTaskId: DREAMER_TASK,
    contentJson: JSON.stringify({ valid: true, taskId: DREAMER_TASK, candidates: [], contextRefs: [], sourcePainId: 'pain-1', generatedAt: NOW }),
  }));
  await store.upsertArtifact(artifact({
    artifactId: 'pi-art-diag-1',
    sourceTaskId: DIAG_TASK,
    contentJson: JSON.stringify(content),
  }));
  const emitEvent = vi.fn();
  const context = await resolveFormationContext({
    taskId: 'scribe-task-1',
    sourceDreamerArtifactId: 'pi-art-dreamer-1',
    artifactStore: store,
    lookupTask: async (id) => TASKS[id] ?? null,
    emitEvent,
  });
  return { context, emitEvent };
}

describe('formation context — strategic basis (SIA v1.2)', () => {
  it('projects intentTension and the captured snapshot sections', async () => {
    const { context } = await resolve(diagnosisContent());
    expect(context?.sourceDiagnosis?.intentTension).toEqual({
      source: 'action_drift',
      evidenceStrength: 'strong',
      relatedIntentFields: ['why', 'non_negotiables'],
      evidence: ['diag#ev1'],
      explanation: 'the action drifted from the stated owner intent',
      intentDocHash: 'sha256:stage-a-hash',
    });
    expect(context?.sourceDiagnosis?.intentSnapshot).toEqual({
      contentHash: 'sha256:stage-a-hash',
      capturedAt: NOW,
      sections: [
        { key: 'why', text: 'protect owner intent' },
        { key: 'non_negotiables', text: 'never merge unverified state' },
      ],
    });
    expect(context?.provenance.strategicIntent).toEqual({
      contentHash: 'sha256:stage-a-hash',
      capturedAt: NOW,
    });
  });

  it('keeps legacy artifacts working — no strategic keys, no new requirement', async () => {
    const content = diagnosisContent();
    delete content.intentTension;
    delete content.intentSnapshot;
    const { context } = await resolve(content);
    expect(context?.sourceDiagnosis).toBeDefined();
    expect(context?.sourceDiagnosis?.intentTension).toBeUndefined();
    expect(context?.sourceDiagnosis?.intentSnapshot).toBeUndefined();
    expect(context?.provenance.strategicIntent).toBeUndefined();
    expect(context?.provenance.sourceDiagnosisTaskId).toBe(DIAG_TASK);
  });

  it('records a malformed strategic value instead of failing the formation', async () => {
    const { context } = await resolve(diagnosisContent({ intentTension: 'action_drift', intentSnapshot: { capturedAt: NOW } }));
    expect(context?.sourceDiagnosis?.omittedFields).toEqual(expect.arrayContaining(['intentTension', 'intentSnapshot']));
    expect(context?.provenance.strategicIntent).toBeUndefined();
  });

  it('sacrifices diagnosis narrative before the captured strategic sections (P1-2)', async () => {
    const longText = 'x'.repeat(900);
    const content = diagnosisContent({
      rootCause: 'r'.repeat(900),
      evidence: Array.from({ length: 6 }, (_, index) => ({ sourceRef: `diag#ev${index}`, note: 'e'.repeat(200) })),
      intentSnapshot: {
        contentHash: 'sha256:stage-a-hash',
        capturedAt: NOW,
        sections: [
          { key: 'why', text: longText },
          { key: 'desired_outcome', text: longText },
          { key: 'non_negotiables', text: longText },
          { key: 'stop_escalation', text: longText },
        ],
      },
    });
    const { context } = await resolve(content);

    const notes = context?.truncationNotes.join(' ') ?? '';
    // Loss order is the contract: evidence first, strategic sections last.
    expect(notes).toContain('diagnosis evidence dropped');
    const evidenceAt = notes.indexOf('diagnosis evidence dropped');
    const snapshotAt = notes.indexOf('intent snapshot section dropped');
    expect(evidenceAt).toBeGreaterThanOrEqual(0);
    expect(snapshotAt).toBeGreaterThan(evidenceAt);
    // The strategic basis still arrives (only its own cap was applied).
    expect(context?.sourceDiagnosis?.intentSnapshot?.sections.length).toBeGreaterThan(0);
    expect(context?.provenance.strategicIntent?.contentHash).toBe('sha256:stage-a-hash');
  });

  it('never drops the whole strategic snapshot with the diagnosis block (P1-2)', async () => {
    const longText = 'x'.repeat(900);
    const content = diagnosisContent({
      rootCause: 'r'.repeat(900),
      summary: 's'.repeat(900),
      evidence: Array.from({ length: 20 }, (_, index) => ({ sourceRef: `diag#ev${index}`, note: 'e'.repeat(200) })),
      intentSnapshot: {
        contentHash: 'sha256:stage-a-hash',
        capturedAt: NOW,
        sections: [
          { key: 'why', text: longText },
          { key: 'desired_outcome', text: longText },
          { key: 'non_negotiables', text: longText },
          { key: 'stop_escalation', text: longText },
        ],
      },
    });
    const { context } = await resolve(content);

    // Whatever the budget did to the narrative, the strategic basis survives.
    expect(context?.sourceDiagnosis).toBeDefined();
    expect(context?.sourceDiagnosis?.intentSnapshot).toBeDefined();
    expect(context?.sourceDiagnosis?.intentSnapshot?.sections.length).toBeGreaterThan(0);
    expect(context?.provenance.strategicIntent?.contentHash).toBe('sha256:stage-a-hash');
  });

  it('trims the snapshot sections when the strategic basis itself is over budget', async () => {
    const longText = 'x'.repeat(900);
    const content = diagnosisContent({
      intentSnapshot: {
        contentHash: 'sha256:stage-a-hash',
        capturedAt: NOW,
        sections: [
          { key: 'why', text: longText },
          { key: 'desired_outcome', text: longText },
          { key: 'non_negotiables', text: longText },
          { key: 'stop_escalation', text: longText },
        ],
      },
    });
    const { context } = await resolve(content);
    const sections = context?.sourceDiagnosis?.intentSnapshot?.sections ?? [];
    const total = sections.reduce((sum, section) => sum + section.text.length, 0);
    expect(sections.length).toBeLessThan(4);
    expect(total).toBeLessThanOrEqual(FORMATION_INTENT_SECTIONS_MAX_CHARS);
    expect(sections.every((section) => section.text.length <= 600)).toBe(true);
    expect(context?.truncationNotes.join(' ')).toContain('intent snapshot section dropped');
    // The diagnosis block itself is still present.
    expect(context?.sourceDiagnosis?.rootCause).toContain('bypassed');
  });

  it('does not resolve a diagnosis through a non-succeeded stage', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(artifact({
      artifactId: 'pi-art-dreamer-2',
      sourceTaskId: DREAMER_TASK,
      contentJson: JSON.stringify({ valid: true, taskId: DREAMER_TASK, candidates: [], contextRefs: [], generatedAt: NOW }),
    }));
    const context = await resolveFormationContext({
      taskId: 'scribe-task-2',
      sourceDreamerArtifactId: 'pi-art-dreamer-2',
      artifactStore: store,
      lookupTask: async (id) => (id === DREAMER_TASK
        ? TASKS[DREAMER_TASK] ?? { taskKind: 'dreamer', status: 'succeeded', dependencyTaskIds: [] }
        : { taskKind: 'diag_router', status: 'running', dependencyTaskIds: [] }),
      emitEvent: vi.fn(),
    });
    expect(context?.sourceDiagnosis).toBeUndefined();
    expect(context?.provenance.strategicIntent).toBeUndefined();
  });

  // ── P1-1: the projected strategic half needs a SERVER-captured snapshot ────

  it('P1-1: drops the model intentTension when no snapshot was captured', async () => {
    const content = diagnosisContent();
    delete content.intentSnapshot;
    const { context } = await resolve(content);
    const diagnosis = context?.sourceDiagnosis;
    expect(diagnosis).toBeDefined();
    expect(diagnosis?.intentTension).toBeUndefined();
    expect(diagnosis?.omittedFields).toContain('intentTension');
    expect(context?.provenance.strategicIntent).toBeUndefined();
    // Ordinary diagnosis material is untouched.
    expect(diagnosis?.rootCause).toContain('bypassed');
    expect(diagnosis?.evidence).toHaveLength(1);
  });

  it('P1-1: drops the model intentTension when the snapshot is malformed', async () => {
    const { context } = await resolve(diagnosisContent({ intentSnapshot: { capturedAt: NOW } }));
    expect(context?.sourceDiagnosis?.intentSnapshot).toBeUndefined();
    expect(context?.sourceDiagnosis?.intentTension).toBeUndefined();
    expect(context?.sourceDiagnosis?.omittedFields).toEqual(
      expect.arrayContaining(['intentSnapshot', 'intentTension']),
    );
  });

  it('P1-1: an empty authored snapshot cannot ground a confirmed owner_intent conflict in V2', async () => {
    // The status says `confirmed`, the model still cites `why`, but the only
    // snapshot section is blank — nothing the Owner authored backs the claim.
    const { context } = await resolve(diagnosisContent({
      intentSnapshot: {
        contentHash: 'sha256:stage-a-hash',
        capturedAt: NOW,
        lang: 'en',
        sections: [{ key: 'why', text: '   ' }],
      },
    }));
    const diagnosis = context?.sourceDiagnosis;
    expect(diagnosis?.intentSnapshot).toBeUndefined();
    expect(diagnosis?.intentTension).toBeUndefined();

    const assembly = assembleIntentContractV2({
      base: {
        ownerIntent: 'Do not drift from the anchor.',
        targetBehavior: 'Check the anchor first.',
        forbiddenBehavior: 'Acting without the check.',
        evidenceSource: 'evidence-1',
        validationExpectation: 'An evaluator observes the check.',
      },
      diagnosisAvailable: true,
      ...(context?.provenance.strategicIntent !== undefined
        ? { strategicIntentRef: context.provenance.strategicIntent }
        : {}),
      ...(diagnosis?.intentTension !== undefined
        ? { intentTension: { relatedIntentFields: diagnosis.intentTension.relatedIntentFields, explanation: diagnosis.intentTension.explanation } }
        : {}),
      authoredSectionKeys: diagnosis?.intentSnapshot?.sections.map((section) => section.key) ?? [],
      modelContract: {
        strategicAssessment: {
          conflicts: [{ against: 'owner_intent', ref: 'why', status: 'confirmed', evidenceRefs: ['diag#ev1'] }],
        },
      },
    });
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;
    expect(assembly.contract.strategicAssessment.conflictStatus).not.toBe('confirmed');
    expect(assembly.contract.strategicAssessment.conflicts?.[0]?.status).toBe('potential');
  });

  it('P1-1: narrows a historical artifact whose tension cites a non-authored section', async () => {
    const { context } = await resolve(diagnosisContent({
      intentTension: {
        source: 'action_drift',
        evidenceStrength: 'strong',
        relatedIntentFields: ['why', 'non_negotiables'],
        evidence: ['diag#ev1'],
        explanation: 'historical tension',
        intentDocHash: 'sha256:stage-a-hash',
      },
      // Only `why` survived the authored filter in the stored snapshot.
      intentSnapshot: {
        contentHash: 'sha256:stage-a-hash',
        capturedAt: NOW,
        sections: [{ key: 'why', text: 'protect owner intent' }],
      },
    }));
    expect(context?.sourceDiagnosis?.intentTension?.relatedIntentFields).toEqual(['why']);
    expect(context?.sourceDiagnosis?.omittedFields).toContain('intentTension.relatedIntentFields');
  });
});
