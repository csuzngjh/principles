/**
 * PRI-717 regression — diagnosis-evidence lineage reachability.
 *
 * EP002-R2 incident (evidence/state-snapshot-final.json, runs 2026-09-09
 * 18:55–19:21Z): evaluator stage2 failed with `required tier2 evidence
 * unavailable (diagnostician.raw.evidence, dreamer.raw.candidates)` on every
 * attempt after 16:51Z.
 *
 * Root cause (verified against the lab state.db): durable artifact ids embed
 * the producing run (`pi-art-<taskId>-run_<taskId>_<seq>`) and the upsert
 * rewrites the id on every re-run of the same task. The scribe was revised at
 * 16:51Z; every lineage edge captured before that (e.g. the 14:18Z
 * artificer-repair artifact) went dangling, the BFS collapsed to a single
 * node, and both required tier2 paths landed in `absent` — fail-closed, but
 * against evidence that still existed under the logical artifact identity
 * (UNIQUE(source_task_id, artifact_kind)).
 *
 * These tests pin the two fixes:
 *   1. dangling producer-convention edges rebind to the task's CURRENT
 *      artifact, observably (`lineage_edge_rebound`), never silently;
 *   2. BFS depth counts LEVELS (the documented `longest pipeline chain + 1`
 *      invariant), not nodes processed — the router level fans out to two
 *      artifacts and must not starve deep ancestors.
 */

import { describe, expect, it } from 'vitest';
import {
  CandidateLineage,
  type LineageEvent,
  type LineageTaskReader,
} from '../candidate-lineage.js';
import { resolveAncestryPaths, toRawStageSources } from '../context-resolution.js';
import type { PIArtifactRecord, PIArtifactStore, PIArtifactKind, PIArtifactValidationStatus } from '../pi-artifact.js';

// ── EP002-shaped fixtures ────────────────────────────────────────────────────

const DIAG_TASK = 'diag_rootcause-diagnosis_manual_1788954317844_km6n5wae';
const DISTILLER_TASK = 'diag_distiller-diagnosis_manual_1788954317844_km6n5wae';
const ROUTER_TASK = 'diag_router-diagnosis_manual_1788954317844_km6n5wae';
const DREAMER_TASK = 'dreamer-530eb344-01a8-4509-ae91-5b8ef5dcb247-prompt';
const PHILOSOPHER_TASK = 'philosopher-530eb344-01a8-4509-ae91-5b8ef5dcb247-prompt';
const SCRIBE_TASK = 'scribe-530eb344-01a8-4509-ae91-5b8ef5dcb247-prompt';
const ARTIFICER_TASK = 'artificer-530eb344-01a8-4509-ae91-5b8ef5dcb247-prompt';
const EVALUATOR_TASK = 'evaluator-530eb344-01a8-4509-ae91-5b8ef5dcb247-prompt';
const REPAIR_TASK = 'artificer-repair-evaluator-530eb344-01a8-4509-ae91-5b8ef5dcb247-prompt-r1';

/** The durable artifact id convention: `pi-art-<taskId>-run_<taskId>_<seq>`. */
function instanceId(taskId: string, seq: number): string {
  return `pi-art-${taskId}-run_${taskId}_${seq}`;
}

function makeArtifact(
  taskId: string,
  seq: number,
  lineageArtifactIds: string[],
  contentJson: unknown,
  artifactKind: PIArtifactKind = 'principle',
): PIArtifactRecord {
  return {
    artifactId: instanceId(taskId, seq),
    artifactKind,
    sourceTaskId: taskId,
    lineageArtifactIds,
    validationStatus: 'validated' as PIArtifactValidationStatus,
    contentJson: typeof contentJson === 'string' ? contentJson : JSON.stringify(contentJson),
    createdAt: '2026-09-09T11:00:00Z',
    updatedAt: '2026-09-09T11:00:00Z',
  };
}

interface Harness {
  readonly artifacts: Map<string, PIArtifactRecord>;
  readonly tasks: Map<string, { taskId: string; taskKind: string }>;
  readonly events: LineageEvent[];
  readonly listCalls: string[];
  makeLineage(maxDepth?: number): CandidateLineage;
}

function makeHarness(
  artifacts: readonly PIArtifactRecord[],
  tasks: readonly { taskId: string; taskKind: string }[],
): Harness {
  const artifactMap = new Map(artifacts.map((a) => [a.artifactId, a]));
  const taskMap = new Map(tasks.map((t) => [t.taskId, t]));
  const events: LineageEvent[] = [];
  const listCalls: string[] = [];
  const artifactStore: Pick<PIArtifactStore, 'getArtifactById' | 'listBySourceTaskId'> = {
    getArtifactById: async (id) => artifactMap.get(id) ?? null,
    listBySourceTaskId: async (taskId) => {
      listCalls.push(taskId);
      return [...artifactMap.values()].filter((a) => a.sourceTaskId === taskId);
    },
  };
  const taskReader: LineageTaskReader = {
    getTaskById: async (id) => taskMap.get(id) ?? null,
  };
  return {
    artifacts: artifactMap,
    tasks: taskMap,
    events,
    listCalls,
    makeLineage: (maxDepth?: number) => new CandidateLineage({
      artifacts: artifactStore,
      tasks: taskReader,
      maxDepth,
      emit: (e) => events.push(e),
    }),
  };
}

/** The full durable chain exactly as EP002-R2 wrote it, with scribe at seq 1. */
function buildEpisodeChain(scribeSeq: 1 | 2, repairReferencesStaleScribe: boolean): Harness {
  const rootcause = makeArtifact(DIAG_TASK, 1, [], { rootCause: 'x', evidenceMeta: 'y' });
  const distiller = makeArtifact(DISTILLER_TASK, 1, [rootcause.artifactId], { distilled: 'z' });
  const router = makeArtifact(ROUTER_TASK, 1, [rootcause.artifactId, distiller.artifactId], {
    evidence: [{ id: 'ev-1', summary: 'fabricated unsupported field' }],
    rootCause: 'unverified consumer assumption',
  });
  const scribe1 = instanceId(SCRIBE_TASK, 1);
  const scribe2 = instanceId(SCRIBE_TASK, 2);
  const scribeLineageTarget = repairReferencesStaleScribe ? scribe1 : scribe2;
  const dreamer = makeArtifact(DREAMER_TASK, 1, [router.artifactId], {
    candidates: [{ candidateIndex: 0, badDecision: 'a', betterDecision: 'b' }],
  });
  const philosopher = makeArtifact(PHILOSOPHER_TASK, 1, [dreamer.artifactId], { lenses: [] });
  const scribeCurrent = makeArtifact(SCRIBE_TASK, scribeSeq, [philosopher.artifactId], {
    principle: 'verify the real consumer first',
  });
  const artificer = makeArtifact(ARTIFICER_TASK, 1, [scribe2], { implementationCode: '...' });
  const repair = makeArtifact(REPAIR_TASK, 1, [scribeLineageTarget], { implementationCode: 'fixed' });
  const evaluator = makeArtifact(EVALUATOR_TASK, 1, [repair.artifactId], { evaluation: {} });

  // The store keeps only the CURRENT instance per task: when the scribe was
  // revised, its seq-1 instance id stopped resolving.
  const rows = scribeSeq === 2
    ? [rootcause, distiller, router, dreamer, philosopher, scribeCurrent, artificer, repair, evaluator]
    : [rootcause, distiller, router, dreamer, philosopher, scribeCurrent, artificer, repair, evaluator];
  const tasks = [
    { taskId: DIAG_TASK, taskKind: 'diag_rootcause' },
    { taskId: DISTILLER_TASK, taskKind: 'diag_distiller' },
    { taskId: ROUTER_TASK, taskKind: 'diag_router' },
    { taskId: DREAMER_TASK, taskKind: 'dreamer' },
    { taskId: PHILOSOPHER_TASK, taskKind: 'philosopher' },
    { taskId: SCRIBE_TASK, taskKind: 'scribe' },
    { taskId: ARTIFICER_TASK, taskKind: 'artificer' },
    { taskId: REPAIR_TASK, taskKind: 'artificer' },
    { taskId: EVALUATOR_TASK, taskKind: 'evaluator' },
  ];
  return makeHarness(rows, tasks);
}

// ── 1. The incident: stale instance edge after upstream revision ─────────────

describe('PRI-717 — stale lineage instance ids rebind to the current artifact', () => {
  it('repair lineage referencing the pre-revision scribe instance resolves through the revision', async () => {
    // Scribe revised to instance 2; the repair (written earlier) still points
    // at instance 1 — exactly the 14:18Z repair / 16:51Z scribe-revision shape.
    const h = buildEpisodeChain(2, true);
    const result = await h.makeLineage().resolve(instanceId(REPAIR_TASK, 1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const kinds = result.value.nodes.map((n) => n.taskKind);
    expect(kinds).toContain('scribe');
    expect(kinds).toContain('dreamer');
    expect(kinds).toContain('diag_router');
    expect(kinds).toContain('diag_rootcause');
    expect(kinds).toContain('diag_distiller');
    // No pruned/cycle-free-floating ancestors: every node in the durable
    // chain carries resolvable identity. (A `cycle_detected` note is still
    // possible on the router diamond — re-visits are diagnosed as cycles by
    // design; it does not affect node reachability.)
    expect(result.value.notes.some((n) => n.code === 'ancestor_pruned')).toBe(false);
    expect(result.value.nodes.find((n) => n.taskKind === 'scribe')?.artifactId)
      .toBe(instanceId(SCRIBE_TASK, 2));

    const rebound = h.events.filter((e) => e.type === 'lineage_edge_rebound');
    expect(rebound).toHaveLength(1);
    if (rebound[0]?.type === 'lineage_edge_rebound') {
      expect(rebound[0].staleArtifactId).toBe(instanceId(SCRIBE_TASK, 1));
      expect(rebound[0].resolvedArtifactId).toBe(instanceId(SCRIBE_TASK, 2));
      expect(rebound[0].taskId).toBe(SCRIBE_TASK);
    }
  });

  it('tier2 evidence resolves from writer-produced lineage after the revision (incident closure)', async () => {
    const h = buildEpisodeChain(2, true);
    const result = await h.makeLineage().resolve(instanceId(REPAIR_TASK, 1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sources = toRawStageSources(result.value.nodes);
    const resolved = resolveAncestryPaths(
      ['diagnostician.raw.evidence', 'dreamer.raw.candidates'],
      sources,
    );
    // diagnostician namespace aliases diag_router (SEMANTIC_STAGE_ALIASES).
    expect(resolved.has('diagnostician.raw.evidence')).toBe(true);
    expect(resolved.has('dreamer.raw.candidates')).toBe(true);
  });

  it('no current artifact for the producer task stays fail-closed (ancestor_pruned)', async () => {
    const h = buildEpisodeChain(2, true);
    // Simulate the scribe artifact being gone entirely (task deleted / store
    // lost): only the dangling edge remains.
    for (const [id, rec] of [...h.artifacts.entries()]) {
      if (rec.sourceTaskId === SCRIBE_TASK) h.artifacts.delete(id);
    }
    const result = await h.makeLineage().resolve(instanceId(REPAIR_TASK, 1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.complete).toBe(false);
    expect(result.value.nodes.map((n) => n.taskKind)).not.toContain('scribe');
    expect(result.value.notes.some((n) => n.code === 'ancestor_pruned')).toBe(true);
    expect(h.events.some((e) => e.type === 'lineage_edge_rebound')).toBe(false);
  });

  it('non-producer-convention edge ids are never rebound', async () => {
    const start = makeArtifact('task-a', 1, ['legacy-art-shape-9'], { a: 1 });
    const h = makeHarness([start], [{ taskId: 'task-a', taskKind: 'artificer' }]);
    const result = await h.makeLineage().resolve(start.artifactId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.complete).toBe(false);
    expect(result.value.notes.some((n) => n.code === 'ancestor_pruned')).toBe(true);
    expect(h.listCalls).toHaveLength(0);
  });

  it('a run segment naming a different task is not rebound', async () => {
    // pi-art-<T1>-run_<T2>_1 — the embedded run does not belong to T1.
    const forged = `pi-art-${SCRIBE_TASK}-run_${DREAMER_TASK}_1`;
    const start = makeArtifact('task-a', 1, [forged], { a: 1 });
    const h = makeHarness([start], [{ taskId: 'task-a', taskKind: 'artificer' }]);
    const result = await h.makeLineage().resolve(start.artifactId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notes.some((n) => n.code === 'ancestor_pruned')).toBe(true);
    expect(h.listCalls).toHaveLength(0);
  });

  // ── Review fix: rebind identity is (sourceTaskId, artifactKind) ─────────────
  // An evaluator task may carry BOTH a `pi-art-…` principle row and a
  // `pi-rule-…` rule row (evaluator-runner writes a rule artifact for
  // code-bearing candidates). The stale edge names a `pi-art-` instance, so
  // only the current instance of the SAME id family is a rebound candidate.

  /** A current `pi-rule-…` row for a task (rule-family id shape). */
  function makeRuleArtifact(taskId: string, seq: number, contentJson: unknown): PIArtifactRecord {
    return {
      artifactId: `pi-rule-${taskId}-run_${taskId}_${seq}`,
      artifactKind: 'rule',
      sourceTaskId: taskId,
      lineageArtifactIds: [],
      validationStatus: 'validated' as PIArtifactValidationStatus,
      contentJson: typeof contentJson === 'string' ? contentJson : JSON.stringify(contentJson),
      createdAt: '2026-09-09T11:30:00Z',
      updatedAt: '2026-09-09T11:30:00Z',
    };
  }

  it('multi-kind task: stale principle edge rebinds to the CURRENT PRINCIPLE row, never the rule row', async () => {
    const stale = instanceId(SCRIBE_TASK, 1);
    const start = makeArtifact('task-a', 1, [stale], { a: 1 });
    const principleCurrent = makeArtifact(SCRIBE_TASK, 2, [], { principle: 'p' });
    const ruleCurrent = makeRuleArtifact(SCRIBE_TASK, 1, { rule: 'r' });
    const h = makeHarness([start, principleCurrent, ruleCurrent], [
      { taskId: 'task-a', taskKind: 'artificer' },
      { taskId: SCRIBE_TASK, taskKind: 'scribe' },
    ]);
    const result = await h.makeLineage().resolve(start.artifactId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scribeNode = result.value.nodes.find((n) => n.taskKind === 'scribe');
    expect(scribeNode?.artifactId).toBe(instanceId(SCRIBE_TASK, 2));
    const rebound = h.events.filter((e) => e.type === 'lineage_edge_rebound');
    expect(rebound).toHaveLength(1);
    if (rebound[0]?.type === 'lineage_edge_rebound') {
      expect(rebound[0].resolvedArtifactId).toBe(instanceId(SCRIBE_TASK, 2));
    }
  });

  it('multi-kind task: reversing the store order does NOT change the rebound target', async () => {
    const stale = instanceId(SCRIBE_TASK, 1);
    const principleCurrent = makeArtifact(SCRIBE_TASK, 2, [], { principle: 'p' });
    const ruleCurrent = makeRuleArtifact(SCRIBE_TASK, 1, { rule: 'r' });
    const start = makeArtifact('task-a', 1, [stale], { a: 1 });
    const tasks = [
      { taskId: 'task-a', taskKind: 'artificer' },
      { taskId: SCRIBE_TASK, taskKind: 'scribe' },
    ];
    // Store iterates in insertion order — exercise BOTH orders.
    const h1 = makeHarness([start, principleCurrent, ruleCurrent], tasks);
    const h2 = makeHarness([start, ruleCurrent, principleCurrent], tasks);

    for (const h of [h1, h2]) {
      const result = await h.makeLineage().resolve(start.artifactId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes.find((n) => n.taskKind === 'scribe')?.artifactId)
        .toBe(instanceId(SCRIBE_TASK, 2));
    }
  });

  it('stale principle edge with ONLY a current rule row stays fail-closed (no kind confusion)', async () => {
    const stale = instanceId(SCRIBE_TASK, 1);
    const start = makeArtifact('task-a', 1, [stale], { a: 1 });
    const ruleCurrent = makeRuleArtifact(SCRIBE_TASK, 1, { rule: 'r' });
    const h = makeHarness([start, ruleCurrent], [
      { taskId: 'task-a', taskKind: 'artificer' },
      { taskId: SCRIBE_TASK, taskKind: 'scribe' },
    ]);
    const result = await h.makeLineage().resolve(start.artifactId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The rule row is a DIFFERENT id family — it must not satisfy a
    // `pi-art-` edge, even though the task has a current artifact.
    expect(result.value.nodes.find((n) => n.taskKind === 'scribe')).toBeUndefined();
    expect(result.value.notes.some((n) => n.code === 'ancestor_pruned')).toBe(true);
    expect(h.events.some((e) => e.type === 'lineage_edge_rebound')).toBe(false);
  });

  it('data anomaly (two same-family current rows) → ambiguous, fail-closed with explicit detail', async () => {
    // UNIQUE(source_task_id, artifact_kind) makes this impossible through the
    // real stores; the resolver must still refuse to pick by order.
    const stale = instanceId(SCRIBE_TASK, 1);
    const start = makeArtifact('task-a', 1, [stale], { a: 1 });
    const anomalyA = makeArtifact(SCRIBE_TASK, 2, [], { anomaly: 'a' });
    const anomalyB = { ...makeArtifact(SCRIBE_TASK, 3, [], { anomaly: 'b' }) };
    anomalyB.updatedAt = '2026-09-09T12:00:00Z';
    const h = makeHarness([start, anomalyA, anomalyB], [
      { taskId: 'task-a', taskKind: 'artificer' },
      { taskId: SCRIBE_TASK, taskKind: 'scribe' },
    ]);
    const result = await h.makeLineage().resolve(start.artifactId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes.find((n) => n.taskKind === 'scribe')).toBeUndefined();
    const note = result.value.notes.find((n) => n.code === 'ancestor_pruned');
    expect(note?.detail).toContain('ambiguous current artifacts');
    expect(h.events.some((e) => e.type === 'lineage_edge_rebound')).toBe(false);
  });

  it('stale and fresh edges to the same task produce ONE node and no spurious cycle note', async () => {
    const scribe1 = instanceId(SCRIBE_TASK, 1);
    const scribe2 = instanceId(SCRIBE_TASK, 2);
    // Sibling artifacts written across the revision: one edge stale, one fresh.
    const a = makeArtifact('task-a', 1, [scribe1], { a: 1 });
    const b = makeArtifact('task-b', 1, [scribe2], { b: 1 });
    const start = makeArtifact('task-c', 1, [a.artifactId, b.artifactId], { c: 1 });
    const scribeCurrent = makeArtifact(SCRIBE_TASK, 2, [], { principle: 'p' });
    const h = makeHarness([start, a, b, scribeCurrent], [
      { taskId: 'task-c', taskKind: 'artificer' },
      { taskId: 'task-a', taskKind: 'artificer' },
      { taskId: 'task-b', taskKind: 'artificer' },
      { taskId: SCRIBE_TASK, taskKind: 'scribe' },
    ]);
    const result = await h.makeLineage().resolve(start.artifactId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes.filter((n) => n.taskKind === 'scribe')).toHaveLength(1);
    expect(result.value.complete).toBe(true);
  });

  it('repeated stale edges to the same task rebind once (request-scoped idempotency)', async () => {
    const scribe1 = instanceId(SCRIBE_TASK, 1);
    const a = makeArtifact('task-a', 1, [scribe1], { a: 1 });
    const b = makeArtifact('task-b', 1, [scribe1], { b: 1 });
    const start = makeArtifact('task-c', 1, [a.artifactId, b.artifactId], { c: 1 });
    const scribeCurrent = makeArtifact(SCRIBE_TASK, 2, [], { principle: 'p' });
    const h = makeHarness([start, a, b, scribeCurrent], [
      { taskId: 'task-c', taskKind: 'artificer' },
      { taskId: 'task-a', taskKind: 'artificer' },
      { taskId: 'task-b', taskKind: 'artificer' },
      { taskId: SCRIBE_TASK, taskKind: 'scribe' },
    ]);
    const result = await h.makeLineage().resolve(start.artifactId);

    expect(result.ok).toBe(true);
    expect(h.events.filter((e) => e.type === 'lineage_edge_rebound')).toHaveLength(1);
    expect(h.listCalls.filter((t) => t === SCRIBE_TASK)).toHaveLength(1);
  });

  it('listBySourceTaskId throwing classifies as store_failure', async () => {
    const stale = instanceId(SCRIBE_TASK, 1);
    const start = makeArtifact('task-a', 1, [stale], { a: 1 });
    const events: LineageEvent[] = [];
    const lineage = new CandidateLineage({
      artifacts: {
        getArtifactById: async () => null,
        listBySourceTaskId: async () => { throw new Error('boom'); },
      },
      tasks: { getTaskById: async () => null },
      emit: (e) => events.push(e),
    });
    const result = await lineage.resolve(start.artifactId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('store_failure');
  });
});

// ── 2. BFS depth counts LEVELS, not nodes ────────────────────────────────────

describe('PRI-717 — BFS depth is level-based (documented maxDepth invariant)', () => {
  it('the full EP002 chain (7 nodes across 6 levels) resolves within default depth', async () => {
    const h = buildEpisodeChain(1, false);
    // Start from the repair artifact: repair→scribe→philosopher→dreamer→
    // router→{rootcause, distiller} = levels 0..5, 7 nodes total. A
    // node-counting loop stops after 6 nodes and starves `distiller`.
    const result = await h.makeLineage().resolve(instanceId(REPAIR_TASK, 1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes).toHaveLength(7);
    const kinds = result.value.nodes.map((n) => n.taskKind);
    expect(kinds).toEqual(expect.arrayContaining([
      'artificer', 'scribe', 'philosopher', 'dreamer', 'diag_router', 'diag_rootcause', 'diag_distiller',
    ]));
  });

  it('a chain deeper than maxDepth levels reports depth_limit_reached, not a mid-level stop', async () => {
    // 8 levels: L0..L7 (beyond maxDepth=6 → levels 0..5 traversed).
    const artifacts: PIArtifactRecord[] = [];
    const tasks: { taskId: string; taskKind: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const taskId = `depth-task-${i}`;
      const lineage = i === 0 ? [] : [instanceId(`depth-task-${i - 1}`, 1)];
      artifacts.push(makeArtifact(taskId, 1, lineage, { i }));
      tasks.push({ taskId, taskKind: i === 0 ? 'diag_rootcause' : 'dreamer' });
    }
    const h = makeHarness(artifacts, tasks);
    const result = await h.makeLineage().resolve(instanceId('depth-task-7', 1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.complete).toBe(false);
    expect(result.value.notes.some((n) => n.code === 'depth_limit_reached')).toBe(true);
    // levels 0..5 = 6 nodes traversed.
    expect(result.value.nodes).toHaveLength(6);
  });

  it('a wide level does not consume the depth budget of deeper levels', async () => {
    // L0 → 5 siblings (L1) → L2: 7 nodes across 3 levels. A node-counting
    // loop stops after 6 nodes; level-based depth resolves all 7.
    const l1tasks = ['wide-a', 'wide-b', 'wide-c', 'wide-d', 'wide-e'];
    const artifacts: PIArtifactRecord[] = [
      makeArtifact('wide-root', 1, l1tasks.map((t) => instanceId(t, 1)), { root: true }),
      makeArtifact('wide-leaf', 1, [], { leaf: true }),
      ...l1tasks.map((t) => makeArtifact(t, 1, [instanceId('wide-leaf', 1)], { t })),
    ];
    const tasks = [
      { taskId: 'wide-root', taskKind: 'artificer' },
      { taskId: 'wide-leaf', taskKind: 'diag_rootcause' },
      ...l1tasks.map((t) => ({ taskId: t, taskKind: 'scribe' })),
    ];
    const h = makeHarness(artifacts, tasks);
    const result = await h.makeLineage().resolve(instanceId('wide-root', 1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes).toHaveLength(7);
    expect(result.value.nodes.some((n) => n.taskKind === 'diag_rootcause')).toBe(true);
  });
});
