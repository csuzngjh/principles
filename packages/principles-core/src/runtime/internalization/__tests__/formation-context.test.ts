/**
 * PRI-838 / PRI-839 — formation context resolver unit tests.
 *
 * Covers the three cases the ticket names explicitly:
 *   Case 1  dreamer + diagnosis both present        → full context
 *   Case 2  dreamer present, evidence missing       → DEGRADE, never fail
 *   Case 3  legacy artifact                          → compatible
 * plus the bound contract (Phase 2) and the never-throws guarantee.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import type { PIArtifactRecord } from '../pi-artifact.js';
import {
  FORMATION_CANDIDATE_LIMIT,
  FORMATION_CONTEXT_VERSION,
  FORMATION_DIAGNOSIS_EVIDENCE_LIMIT,
  FORMATION_FIELD_MAX_CHARS,
  FORMATION_TOTAL_MAX_CHARS,
  projectDreamerProposals,
  resolveFormationContext,
  summarizeCandidateDifferences,
  type FormationTaskView,
} from '../formation-context.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const DREAMER_ART_ID = 'pi-art-dreamer-1';
const DIAG_ART_ID = 'pi-art-diag-router-1';
const DREAMER_TASK_ID = 'dreamer-task-1';
const DIAG_TASK_ID = 'diag-router-task-1';

function makeArtifact(params: {
  artifactId: string;
  sourceTaskId: string;
  content: unknown;
  lineageArtifactIds?: readonly string[];
}): PIArtifactRecord {
  return {
    artifactId: params.artifactId,
    artifactKind: 'principle',
    sourceTaskId: params.sourceTaskId,
    lineageArtifactIds: [...(params.lineageArtifactIds ?? [])],
    validationStatus: 'pending',
    contentJson: typeof params.content === 'string' ? params.content : JSON.stringify(params.content),
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
  };
}

function dreamerContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    valid: true,
    taskId: DREAMER_TASK_ID,
    candidates: [
      {
        candidateIndex: 0,
        badDecision: 'agent wrote without validating the parent path',
        betterDecision: 'resolve and validate the parent path before writing',
        rationale: 'unvalidated parents allow traversal',
        confidence: 0.4,
        riskLevel: 'high',
        strategicPerspective: 'defensive',
      },
      {
        candidateIndex: 1,
        badDecision: 'agent ignored the contract file',
        betterDecision: 'read the contract before acting',
        rationale: 'guessing contracts produces silent drift',
        confidence: 0.9,
        riskLevel: 'low',
        strategicPerspective: 'evidence-first',
      },
    ],
    sourcePainId: 'pain-1',
    contextRefs: ['pi-art-pain-1'],
    generatedAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

function routerDiagnosisContent(): Record<string, unknown> {
  return {
    valid: true,
    diagnosisId: 'diag-1',
    summary: 'contract guessed from examples',
    rootCause: 'Assumption: the agent inferred a configuration contract from example files',
    violatedPrinciples: [
      { principleId: 'T-03', title: 'Evidence first', rationale: 'contracts must be read, not guessed' },
    ],
    evidence: [
      { sourceRef: 'trajectory://session-1/turn-4', note: 'agent wrote a config without reading the contract' },
    ],
    recommendations: [
      { kind: 'principle', description: 'read the authoritative contract before mutating config' },
    ],
    confidence: 0.8,
  };
}

interface Harness {
  readonly store: MemoryPIArtifactStore;
  readonly events: { eventName: string; taskId: string; payload: Record<string, unknown> }[];
  readonly resolve: (dreamerArtifactId: string | undefined) => ReturnType<typeof resolveFormationContext>;
  readonly tasks: Map<string, FormationTaskView>;
}

async function makeHarness(params: {
  artifacts: readonly PIArtifactRecord[];
  tasks?: Readonly<Record<string, FormationTaskView>>;
  storeThrows?: boolean;
}): Promise<Harness> {
  const store = new MemoryPIArtifactStore();
  for (const artifact of params.artifacts) {
    await store.upsertArtifact(artifact);
  }
  const events: Harness['events'] = [];
  const tasks = new Map<string, FormationTaskView>(Object.entries(params.tasks ?? {}));

  if (params.storeThrows) {
    vi.spyOn(store, 'getArtifactById').mockRejectedValue(new Error('storage_unavailable'));
  }

  return {
    store,
    events,
    tasks,
    resolve: (dreamerArtifactId) =>
      resolveFormationContext({
        sourceDreamerArtifactId: dreamerArtifactId,
        artifactStore: store,
        lookupTask: async (id) => tasks.get(id) ?? null,
        emitEvent: (eventName, taskId, payload) => events.push({ eventName, taskId, payload }),
        taskId: 'scribe-task-1',
      }),
  };
}

/** Dreamer task whose direct predecessor is the diag_router stage. */
const DREAMER_TASK_WITH_ROUTER: FormationTaskView = {
  taskKind: 'dreamer',
  status: 'succeeded',
  dependencyTaskIds: [DIAG_TASK_ID],
};

// ── Case 1: normal ──────────────────────────────────────────────────────────

describe('PRI-838 Case 1 — dreamer + diagnosis both resolvable', () => {
  it('resolves the full bounded formation context', async () => {
    const harness = await makeHarness({
      artifacts: [
        makeArtifact({ artifactId: DREAMER_ART_ID, sourceTaskId: DREAMER_TASK_ID, content: dreamerContent(), lineageArtifactIds: [DIAG_ART_ID] }),
        makeArtifact({ artifactId: DIAG_ART_ID, sourceTaskId: DIAG_TASK_ID, content: routerDiagnosisContent() }),
      ],
      tasks: { [DREAMER_TASK_ID]: DREAMER_TASK_WITH_ROUTER, [DIAG_TASK_ID]: { taskKind: 'diag_router', status: 'succeeded', dependencyTaskIds: [] } },
    });

    const context = await harness.resolve(DREAMER_ART_ID);

    expect(context).toBeDefined();
    expect(context?.version).toBe(FORMATION_CONTEXT_VERSION);

    // Dreamer: ALL candidates survive — this is the DC-1/DC-3 fix.
    expect(context?.dreamerProposals).toHaveLength(2);
    expect(context?.dreamerProposals.map((c) => c.candidateIndex)).toEqual([1, 0]); // confidence DESC
    expect(context?.dreamerProposals.map((c) => c.priorityRank)).toEqual([1, 2]);
    expect(context?.dreamerContextRefs).toEqual(['pi-art-pain-1']);

    // Diagnosis: root cause + evidence + violated principles.
    expect(context?.sourceDiagnosis?.stage).toBe('diag_router');
    expect(context?.sourceDiagnosis?.rootCause).toContain('Assumption:');
    expect(context?.sourceDiagnosis?.evidence).toHaveLength(1);
    expect(context?.sourceDiagnosis?.violatedPrinciples[0]?.principleId).toBe('T-03');
    expect(context?.sourceDiagnosis?.recommendations[0]).toContain('[principle]');

    // Provenance: ids + lineage preserved.
    expect(context?.provenance.sourceDreamerArtifactId).toBe(DREAMER_ART_ID);
    expect(context?.provenance.sourceDiagnosisArtifactId).toBe(DIAG_ART_ID);
    expect(context?.provenance.sourcePainId).toBe('pain-1');
    expect(context?.provenance.lineageArtifactIds).toEqual([DIAG_ART_ID]);

    expect(context?.truncationNotes).toEqual([]);
    expect(harness.events.at(-1)?.eventName).toBe('formation_context_resolved');
  });

  it('prefers diag_router over the earlier diagnostic stages', async () => {
    const distillerArtId = 'pi-art-diag-distiller-1';
    const harness = await makeHarness({
      artifacts: [
        makeArtifact({ artifactId: DREAMER_ART_ID, sourceTaskId: DREAMER_TASK_ID, content: dreamerContent() }),
        makeArtifact({ artifactId: 'pi-art-diag-distiller-1', sourceTaskId: 'diag-distiller-task-1', content: routerDiagnosisContent() }),
        makeArtifact({ artifactId: DIAG_ART_ID, sourceTaskId: DIAG_TASK_ID, content: routerDiagnosisContent() }),
      ],
      tasks: {
        [DREAMER_TASK_ID]: { taskKind: 'dreamer', status: 'succeeded', dependencyTaskIds: ['diag-distiller-task-1', DIAG_TASK_ID] },
        'diag-distiller-task-1': { taskKind: 'diag_distiller', status: 'succeeded', dependencyTaskIds: [] },
        [DIAG_TASK_ID]: { taskKind: 'diag_router', status: 'succeeded', dependencyTaskIds: [] },
      },
    });

    const context = await harness.resolve(DREAMER_ART_ID);
    expect(context?.sourceDiagnosis?.stage).toBe('diag_router');
    expect(context?.sourceDiagnosis?.artifactId).toBe(DIAG_ART_ID);
    void distillerArtId;
  });

  it('is deterministic — identical input yields identical output', async () => {
    const build = async () => makeHarness({
      artifacts: [
        makeArtifact({ artifactId: DREAMER_ART_ID, sourceTaskId: DREAMER_TASK_ID, content: dreamerContent() }),
        makeArtifact({ artifactId: DIAG_ART_ID, sourceTaskId: DIAG_TASK_ID, content: routerDiagnosisContent() }),
      ],
      tasks: { [DREAMER_TASK_ID]: DREAMER_TASK_WITH_ROUTER, [DIAG_TASK_ID]: { taskKind: 'diag_router', status: 'succeeded', dependencyTaskIds: [] } },
    });
    const first = await (await build()).resolve(DREAMER_ART_ID);
    const second = await (await build()).resolve(DREAMER_ART_ID);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// ── Case 2: degrade, never fail ─────────────────────────────────────────────

describe('PRI-838 Case 2 — evidence missing degrades without failing', () => {
  it('dreamer resolvable but no diagnostic predecessor → context without diagnosis', async () => {
    const harness = await makeHarness({
      artifacts: [makeArtifact({ artifactId: DREAMER_ART_ID, sourceTaskId: DREAMER_TASK_ID, content: dreamerContent() })],
      tasks: { [DREAMER_TASK_ID]: { taskKind: 'dreamer', status: 'succeeded', dependencyTaskIds: [] } },
    });

    const context = await harness.resolve(DREAMER_ART_ID);

    // Degraded, NOT undefined: the proposals are still worth carrying.
    expect(context).toBeDefined();
    expect(context?.sourceDiagnosis).toBeUndefined();
    expect(context?.dreamerProposals).toHaveLength(2);
    expect(context?.truncationNotes.some((note) => note.includes('diagnosis omitted'))).toBe(true);
  });

  it('diagnostic predecessor exists but is not succeeded → diagnosis omitted, no throw', async () => {
    const harness = await makeHarness({
      artifacts: [makeArtifact({ artifactId: DREAMER_ART_ID, sourceTaskId: DREAMER_TASK_ID, content: dreamerContent() })],
      tasks: {
        [DREAMER_TASK_ID]: DREAMER_TASK_WITH_ROUTER,
        [DIAG_TASK_ID]: { taskKind: 'diag_router', status: 'running', dependencyTaskIds: [] },
      },
    });

    const context = await harness.resolve(DREAMER_ART_ID);
    expect(context).toBeDefined();
    expect(context?.sourceDiagnosis).toBeUndefined();
  });

  it('dreamer artifact missing → undefined plus an observable event (never throws)', async () => {
    const harness = await makeHarness({ artifacts: [] });
    const context = await harness.resolve('pi-art-does-not-exist');

    expect(context).toBeUndefined();
    expect(harness.events.some((event) => event.eventName === 'formation_dreamer_artifact_missing')).toBe(true);
  });

  it('no dreamer id at all → undefined plus an observable event', async () => {
    const harness = await makeHarness({ artifacts: [] });
    const context = await harness.resolve(undefined);

    expect(context).toBeUndefined();
    expect(harness.events[0]?.eventName).toBe('formation_context_skipped');
    expect(harness.events[0]?.payload.reason).toBe('dreamer_artifact_id_missing');
  });

  it('artifact store failure is contained — undefined + event, never a throw', async () => {
    const harness = await makeHarness({
      artifacts: [makeArtifact({ artifactId: DREAMER_ART_ID, sourceTaskId: DREAMER_TASK_ID, content: dreamerContent() })],
      storeThrows: true,
    });

    const context = await harness.resolve(DREAMER_ART_ID);
    expect(context).toBeUndefined();
    expect(harness.events.at(-1)?.eventName).toBe('formation_context_failed');
  });

  it('dreamer contentJson is not JSON → undefined plus an observable event', async () => {
    const harness = await makeHarness({
      artifacts: [makeArtifact({ artifactId: DREAMER_ART_ID, sourceTaskId: DREAMER_TASK_ID, content: '{not json' })],
    });
    const context = await harness.resolve(DREAMER_ART_ID);
    expect(context).toBeUndefined();
    expect(harness.events.at(-1)?.eventName).toBe('formation_context_invalid');
  });
});

// ── Case 3: legacy compatibility ────────────────────────────────────────────

describe('PRI-838 Case 3 — legacy artifacts stay compatible', () => {
  it('legacy dreamer artifact without optional signals resolves with explicit nulls', async () => {
    const harness = await makeHarness({
      artifacts: [
        makeArtifact({
          artifactId: DREAMER_ART_ID,
          sourceTaskId: DREAMER_TASK_ID,
          content: {
            // pre-PRI-508 shape: only the three required fields, no contextRefs,
            // no sourcePainId, no confidence/riskLevel/strategicPerspective.
            candidates: [{ badDecision: 'bad', betterDecision: 'better', rationale: 'why' }],
          },
        }),
      ],
      tasks: { [DREAMER_TASK_ID]: { taskKind: 'dreamer', status: 'succeeded', dependencyTaskIds: [] } },
    });

    const context = await harness.resolve(DREAMER_ART_ID);

    expect(context?.dreamerProposals).toHaveLength(1);
    const [candidate] = context?.dreamerProposals ?? [];
    expect(candidate?.badDecision).toBe('bad');
    expect(candidate?.confidence).toBeNull();
    expect(candidate?.riskLevel).toBeNull();
    expect(candidate?.strategicPerspective).toBeNull();
    expect(context?.dreamerContextRefs).toEqual([]);
    expect(context?.provenance.sourcePainId).toBeNull();
  });

  it('legacy dreamer task with no enqueued dependencies → still resolves the proposals', async () => {
    const harness = await makeHarness({
      artifacts: [makeArtifact({ artifactId: DREAMER_ART_ID, sourceTaskId: DREAMER_TASK_ID, content: dreamerContent() })],
      // task row absent entirely (pre-PRI-508 chains)
    });

    const context = await harness.resolve(DREAMER_ART_ID);
    expect(context?.dreamerProposals).toHaveLength(2);
    expect(context?.truncationNotes.some((note) => note.includes('not resolvable'))).toBe(true);
  });
});

// ── Phase 2: the bound contract ─────────────────────────────────────────────

describe('PRI-838 Phase 2 — bounded projection', () => {
  it('candidates beyond FORMATION_CANDIDATE_LIMIT are dropped and counted', () => {
    const candidates = Array.from({ length: FORMATION_CANDIDATE_LIMIT + 3 }, (_, index) => ({
      candidateIndex: index,
      badDecision: `bad-${index}`,
      betterDecision: `better-${index}`,
      rationale: `why-${index}`,
      confidence: 0.5,
      riskLevel: 'low',
      strategicPerspective: `lens-${index}`,
    }));

    const projection = projectDreamerProposals({ candidates });

    expect(projection.candidates).toHaveLength(FORMATION_CANDIDATE_LIMIT);
    expect(projection.omittedCandidateCount).toBe(3);
    expect(projection.truncationNotes.some((note) => note.includes('truncated'))).toBe(true);
  });

  it('per-field values are clamped, so one huge field cannot blow the budget', () => {
    const projection = projectDreamerProposals({
      candidates: [{
        badDecision: 'x'.repeat(FORMATION_FIELD_MAX_CHARS * 5),
        betterDecision: 'b',
        rationale: 'r',
      }],
    });

    const [candidate] = projection.candidates;
    expect(candidate?.badDecision.length).toBe(FORMATION_FIELD_MAX_CHARS);
    expect(candidate?.badDecision.endsWith('…')).toBe(true);
  });

  it('a malformed candidate is skipped without discarding the valid ones', () => {
    const projection = projectDreamerProposals({
      candidates: [
        { badDecision: 'bad-0', betterDecision: 'better-0', rationale: 'why-0' },
        { betterDecision: 'b', rationale: 'r' }, // missing badDecision
        'not-a-record',
        { badDecision: 'bad-3', betterDecision: 'better-3', rationale: 'why-3' },
      ],
    });

    expect(projection.candidates.map((candidate) => candidate.candidateIndex)).toEqual([0, 3]);
    expect(projection.truncationNotes.some((note) => note.includes('malformed'))).toBe(true);
  });

  it('bounds the diagnosis evidence array', () => {
    const evidence = Array.from({ length: FORMATION_DIAGNOSIS_EVIDENCE_LIMIT + 4 }, (_, index) => ({
      sourceRef: `ref-${index}`,
      note: `note-${index}`,
    }));

    const harness = makeHarness({
      artifacts: [
        makeArtifact({ artifactId: DREAMER_ART_ID, sourceTaskId: DREAMER_TASK_ID, content: dreamerContent() }),
        makeArtifact({ artifactId: DIAG_ART_ID, sourceTaskId: DIAG_TASK_ID, content: { ...routerDiagnosisContent(), evidence } }),
      ],
      tasks: { [DREAMER_TASK_ID]: DREAMER_TASK_WITH_ROUTER, [DIAG_TASK_ID]: { taskKind: 'diag_router', status: 'succeeded', dependencyTaskIds: [] } },
    });

    return harness.then(async (h) => {
      const context = await h.resolve(DREAMER_ART_ID);
      expect(context?.sourceDiagnosis?.evidence).toHaveLength(FORMATION_DIAGNOSIS_EVIDENCE_LIMIT);
      expect(context?.sourceDiagnosis?.omittedFields.some((field) => field.startsWith('evidence['))).toBe(true);
    });
  });

  it('the serialized block never exceeds the documented cap and says what it lost', async () => {
    // A diagnosis whose bulk cannot fit alongside a full proposal set.
    const evidence = Array.from({ length: FORMATION_DIAGNOSIS_EVIDENCE_LIMIT }, (_, index) => ({
      sourceRef: `ref-${index}`.padEnd(FORMATION_FIELD_MAX_CHARS, 'r'),
      note: `note-${index}`.padEnd(FORMATION_FIELD_MAX_CHARS, 'n'),
    }));

    const harness = await makeHarness({
      artifacts: [
        makeArtifact({ artifactId: DREAMER_ART_ID, sourceTaskId: DREAMER_TASK_ID, content: dreamerContent() }),
        makeArtifact({
          artifactId: DIAG_ART_ID,
          sourceTaskId: DIAG_TASK_ID,
          content: { ...routerDiagnosisContent(), summary: 's'.padEnd(FORMATION_FIELD_MAX_CHARS, 's'), evidence },
        }),
      ],
      tasks: { [DREAMER_TASK_ID]: DREAMER_TASK_WITH_ROUTER, [DIAG_TASK_ID]: { taskKind: 'diag_router', status: 'succeeded', dependencyTaskIds: [] } },
    });

    const context = await harness.resolve(DREAMER_ART_ID);
    expect(context).toBeDefined();
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(FORMATION_TOTAL_MAX_CHARS);
    expect(context?.truncationNotes.length).toBeGreaterThan(0);
  });

  it('holds the cap even when every field is maximal and the drops themselves add notes', async () => {
    // Regression for review finding PRI-1756-P2: `trimSection` records one note
    // per dropped item, and those notes are part of the serialized object. A
    // single lineage truncation therefore could not bring the block back under
    // the cap — five maximal candidates plus a maximal diagnosis produced 8550
    // chars against an 8000 budget, leaving the prompt boundary unbounded.
    const max = FORMATION_FIELD_MAX_CHARS;
    const maximalCandidates = Array.from({ length: FORMATION_CANDIDATE_LIMIT }, (_, index) => ({
      candidateIndex: index,
      badDecision: 'B'.padEnd(max, 'b'),
      betterDecision: 'D'.padEnd(max, 'd'),
      rationale: 'R'.padEnd(max, 'r'),
      confidence: 0.9,
      riskLevel: 'medium',
      strategicPerspective: 'S'.padEnd(max, 's'),
    }));

    const harness = await makeHarness({
      artifacts: [
        makeArtifact({
          artifactId: DREAMER_ART_ID,
          sourceTaskId: DREAMER_TASK_ID,
          content: { ...dreamerContent(), candidates: maximalCandidates },
          // Far more lineage ids than the last-resort limit.
          lineageArtifactIds: Array.from({ length: 64 }, (_, i) => `lineage-artifact-id-${String(i).padStart(3, '0')}`),
        }),
        makeArtifact({
          artifactId: DIAG_ART_ID,
          sourceTaskId: DIAG_TASK_ID,
          content: {
            ...routerDiagnosisContent(),
            summary: 'M'.padEnd(max, 'm'),
            rootCause: 'C'.padEnd(max, 'c'),
            violatedPrinciples: Array.from({ length: 8 }, (_, i) => ({
              principleId: `P-${i}`,
              title: 'T'.padEnd(max, 't'),
              rationale: 'V'.padEnd(max, 'v'),
            })),
            evidence: Array.from({ length: 8 }, (_, i) => ({
              sourceRef: `ref-${i}`.padEnd(max, 'e'),
              note: 'N'.padEnd(max, 'n'),
            })),
            recommendations: Array.from({ length: 5 }, (_, i) => ({
              kind: 'principle',
              description: `R${i}`.padEnd(max - 8, 'x'),
            })),
          },
        }),
      ],
      tasks: {
        [DREAMER_TASK_ID]: DREAMER_TASK_WITH_ROUTER,
        [DIAG_TASK_ID]: { taskKind: 'diag_router', status: 'succeeded', dependencyTaskIds: [] },
      },
    });

    const context = await harness.resolve(DREAMER_ART_ID);
    expect(context).toBeDefined();

    // The cap is a hard prompt-boundary contract, not a best-effort target.
    const serialized = JSON.stringify(context);
    expect(serialized.length).toBeLessThanOrEqual(FORMATION_TOTAL_MAX_CHARS);

    // Degradation must stay observable (rc-9) — never silent.
    expect(context?.truncationNotes.length).toBeGreaterThan(0);

    // And it must be VALID JSON, never a mid-value slice.
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});

// ── Difference summary (PRI-839) ────────────────────────────────────────────

describe('PRI-839 summarizeCandidateDifferences', () => {
  it('states the count, risk spread and distinct better-decisions', () => {
    const { candidates } = projectDreamerProposals(dreamerContent());
    const summary = summarizeCandidateDifferences(candidates);

    expect(summary).toContain('2 mutually distinct proposals');
    expect(summary).toContain('risk spread');
    expect(summary).toContain('distinct better-decisions: 2');
    expect(summary).toContain('dreamer confidence range: 0.4..0.9');
  });

  it('says so explicitly when there was only one proposal', () => {
    expect(summarizeCandidateDifferences([])).toContain('No dreamer proposals');
    const { candidates } = projectDreamerProposals({
      candidates: [{ badDecision: 'b', betterDecision: 'bb', rationale: 'r' }],
    });
    expect(summarizeCandidateDifferences(candidates)).toContain('no alternatives were proposed');
  });
});
