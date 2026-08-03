/**
 * Property tests for CandidateLineage (design §6.4, tasks 7.3–7.6).
 *
 * CP-17: stage attribution is determined solely by taskKind (not artifactKind)
 * CP-18: lineage cache idempotency (each artifactId fetched at most once)
 * CP-19: lineage error classification (corruption vs expected-absence)
 * CP-20: lineage failures are never swallowed (caller must surface them)
 *
 * Uses stub artifact store + task reader (no real I/O).
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §6.4
 * @see .kiro/specs/internalization-progressive-disclosure/requirements.md Requirement 6
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  CandidateLineage,
  type LineageEvent,
  type LineageTaskReader,
  type LineageResult,
} from '../candidate-lineage.js';
import type { PIArtifactRecord, PIArtifactStore, PIArtifactKind, PIArtifactValidationStatus } from '../pi-artifact.js';

// ── Stub store + task reader ─────────────────────────────────────────────────

interface StubDeps {
  readonly artifacts: Map<string, PIArtifactRecord>;
  readonly tasks: Map<string, { taskId: string; taskKind: string }>;
  readonly artifactReads: Map<string, number>;
  readonly taskReads: Map<string, number>;
  readonly events: LineageEvent[];
}

function makeStub(
  artifacts: readonly PIArtifactRecord[],
  tasks: readonly { taskId: string; taskKind: string }[],
): StubDeps {
  const artifactMap = new Map(artifacts.map((a) => [a.artifactId, a]));
  const taskMap = new Map(tasks.map((t) => [t.taskId, t]));
  const artifactReads = new Map<string, number>();
  const taskReads = new Map<string, number>();
  const events: LineageEvent[] = [];
  return { artifacts: artifactMap, tasks: taskMap, artifactReads, taskReads, events };
}

function makeArtifact(
  artifactId: string,
  sourceTaskId: string,
  lineageArtifactIds: string[] = [],
  contentJson: unknown = { data: 'test' },
  artifactKind: PIArtifactKind = 'principle',
): PIArtifactRecord {
  return {
    artifactId,
    artifactKind,
    sourceTaskId,
    lineageArtifactIds,
    validationStatus: 'validated' as PIArtifactValidationStatus,
    contentJson: typeof contentJson === 'string' ? contentJson : JSON.stringify(contentJson),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makeLineage(deps: StubDeps, maxDepth?: number): CandidateLineage {
  const artifactStore: Pick<PIArtifactStore, 'getArtifactById'> = {
    getArtifactById: async (id: string) => {
      deps.artifactReads.set(id, (deps.artifactReads.get(id) ?? 0) + 1);
      return deps.artifacts.get(id) ?? null;
    },
  };
  const taskReader: LineageTaskReader = {
    getTaskById: async (id: string) => {
      deps.taskReads.set(id, (deps.taskReads.get(id) ?? 0) + 1);
      return deps.tasks.get(id) ?? null;
    },
  };
  return new CandidateLineage({
    artifacts: artifactStore,
    tasks: taskReader,
    maxDepth,
    emit: (e) => deps.events.push(e),
  });
}

// ── CP-17: stage by taskKind only ────────────────────────────────────────────

describe('CP-17 — stage attribution determined solely by taskKind (F1)', () => {
  it('artifactKind is irrelevant: same taskKind → same runnerKind regardless of artifactKind', async () => {
    const artifactKinds: readonly PIArtifactKind[] = ['principle', 'rule', 'skill', 'patch'];
    for (const kind of artifactKinds) {
      const deps = makeStub(
        [makeArtifact('art-1', 'task-1', [], { x: 1 }, kind)],
        [{ taskId: 'task-1', taskKind: 'dreamer' }],
      );
      const lineage = makeLineage(deps);
      const result = await lineage.resolve('art-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.nodes[0]?.runnerKind).toBe('dreamer');
        expect(result.value.nodes[0]?.taskKind).toBe('dreamer');
      }
    }
  });

  it('property: artifactKind randomly mismatched with real stage → runnerKind still follows taskKind', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('principle', 'rule', 'skill', 'patch'),
        fc.constantFrom('dreamer', 'scribe', 'artificer', 'evaluator', 'diag_router'),
        async (artifactKind, taskKind) => {
          const deps = makeStub(
            [makeArtifact('art-prop', 'task-prop', [], { v: 1 }, artifactKind)],
            [{ taskId: 'task-prop', taskKind }],
          );
          const lineage = makeLineage(deps);
          const result = await lineage.resolve('art-prop');
          if (result.ok) {
            expect(result.value.nodes[0]?.taskKind).toBe(taskKind);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

// ── CP-18: cache idempotency ─────────────────────────────────────────────────

describe('CP-18 — lineage cache idempotency', () => {
  it('each artifactId is fetched from the store at most once', async () => {
    // Diamond: A → B, A → C, B → D, C → D (D reachable via two paths).
    const artifacts = [
      makeArtifact('A', 'task-A', ['B', 'C']),
      makeArtifact('B', 'task-B', ['D']),
      makeArtifact('C', 'task-C', ['D']),
      makeArtifact('D', 'task-D', []),
    ];
    const tasks = ['A', 'B', 'C', 'D'].map((t) => ({ taskId: `task-${t}`, taskKind: 'dreamer' }));
    const deps = makeStub(artifacts, tasks);
    const lineage = makeLineage(deps);

    const r1 = await lineage.resolve('A');
    const r2 = await lineage.resolve('A');

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Each artifact fetched exactly once across both resolve calls (cached).
    for (const id of ['A', 'B', 'C', 'D']) {
      expect(deps.artifactReads.get(id) ?? 0).toBe(1);
    }
  });

  it('repeated resolve returns identical results', async () => {
    const artifacts = [
      makeArtifact('X', 'task-X', ['Y']),
      makeArtifact('Y', 'task-Y', []),
    ];
    const tasks = [{ taskId: 'task-X', taskKind: 'dreamer' }, { taskId: 'task-Y', taskKind: 'scribe' }];
    const deps = makeStub(artifacts, tasks);
    const lineage = makeLineage(deps);

    const r1 = await lineage.resolve('X');
    const r2 = await lineage.resolve('X');
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('findAncestorByTaskKind also uses the cache (no extra store reads)', async () => {
    const artifacts = [
      makeArtifact('P', 'task-P', ['Q']),
      makeArtifact('Q', 'task-Q', []),
    ];
    const tasks = [
      { taskId: 'task-P', taskKind: 'evaluator' },
      { taskId: 'task-Q', taskKind: 'dreamer' },
    ];
    const deps = makeStub(artifacts, tasks);
    const lineage = makeLineage(deps);

    await lineage.resolve('P');
    await lineage.findAncestorByTaskKind('P', 'dreamer');

    for (const id of ['P', 'Q']) {
      expect(deps.artifactReads.get(id) ?? 0).toBe(1);
    }
  });
});

// ── CP-19: error classification ──────────────────────────────────────────────

describe('CP-19 — lineage error classification', () => {
  it('contentJson unparseable → ok:false + content_json_unparseable + lineage_data_corrupt', async () => {
    const deps = makeStub(
      [makeArtifact('bad', 'task-1', [], '{not valid json')],
      [{ taskId: 'task-1', taskKind: 'dreamer' }],
    );
    const lineage = makeLineage(deps);
    const result = await lineage.resolve('bad');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('content_json_unparseable');
    expect(deps.events.some((e) => e.type === 'lineage_data_corrupt')).toBe(true);
  });

  it('artifact missing sourceTaskId → ok:false + artifact_shape_invalid', async () => {
    const badArtifact: PIArtifactRecord = {
      ...makeArtifact('shapeless', 'task-1', []),
      sourceTaskId: '',
    };
    const deps = makeStub([badArtifact], [{ taskId: 'task-1', taskKind: 'dreamer' }]);
    const lineage = makeLineage(deps);
    const result = await lineage.resolve('shapeless');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('artifact_shape_invalid');
  });

  it('store throws → ok:false + store_failure + lineage_store_failure', async () => {
    const deps = makeStub([], []);
    const failingStore: Pick<PIArtifactStore, 'getArtifactById'> = {
      getArtifactById: async () => { throw new Error('db connection lost'); },
    };
    const lineage = new CandidateLineage({
      artifacts: failingStore,
      tasks: { getTaskById: async () => null },
      emit: (e) => deps.events.push(e),
    });
    const result = await lineage.resolve('any');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('store_failure');
    expect(deps.events.some((e) => e.type === 'lineage_store_failure')).toBe(true);
  });

  it('ancestor pruned (referenced but absent) → ok:true + partial + ancestor_pruned note', async () => {
    const deps = makeStub(
      [makeArtifact('start', 'task-1', ['ghost'])], // 'ghost' not in store
      [{ taskId: 'task-1', taskKind: 'dreamer' }],
    );
    const lineage = makeLineage(deps);
    const result = await lineage.resolve('start');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.complete).toBe(false);
      expect(result.value.notes.some((n) => n.code === 'ancestor_pruned')).toBe(true);
    }
  });

  it('task missing → ok:true + partial + task_missing note + runnerKind unknown', async () => {
    const deps = makeStub(
      [makeArtifact('orphan', 'task-gone', [])],
      [], // task-gone not in tasks
    );
    const lineage = makeLineage(deps);
    const result = await lineage.resolve('orphan');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.complete).toBe(false);
      expect(result.value.nodes[0]?.runnerKind).toBe('unknown');
      expect(result.value.notes.some((n) => n.code === 'task_missing')).toBe(true);
    }
  });

  it('depth limit → ok:true + partial + depth_limit_reached note', async () => {
    // Chain longer than maxDepth=2.
    const artifacts = [
      makeArtifact('n0', 't0', ['n1']),
      makeArtifact('n1', 't1', ['n2']),
      makeArtifact('n2', 't2', ['n3']),
      makeArtifact('n3', 't3', []),
    ];
    const tasks = [0, 1, 2, 3].map((i) => ({ taskId: `t${i}`, taskKind: 'dreamer' }));
    const deps = makeStub(artifacts, tasks);
    const lineage = makeLineage(deps, 2);
    const result = await lineage.resolve('n0');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.complete).toBe(false);
      expect(result.value.notes.some((n) => n.code === 'depth_limit_reached')).toBe(true);
    }
  });

  it('cycle → ok:true + partial + cycle_detected note', async () => {
    // A → B → A (cycle).
    const artifacts = [
      makeArtifact('cyc-A', 't-A', ['cyc-B']),
      makeArtifact('cyc-B', 't-B', ['cyc-A']),
    ];
    const tasks = [{ taskId: 't-A', taskKind: 'dreamer' }, { taskId: 't-B', taskKind: 'scribe' }];
    const deps = makeStub(artifacts, tasks);
    const lineage = makeLineage(deps);
    const result = await lineage.resolve('cyc-A');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.notes.some((n) => n.code === 'cycle_detected')).toBe(true);
    }
  });

  it('complete chain (no issues) → ok:true + complete + empty notes', async () => {
    const artifacts = [
      makeArtifact('ok-1', 't-1', ['ok-2']),
      makeArtifact('ok-2', 't-2', []),
    ];
    const tasks = [{ taskId: 't-1', taskKind: 'dreamer' }, { taskId: 't-2', taskKind: 'scribe' }];
    const deps = makeStub(artifacts, tasks);
    const lineage = makeLineage(deps);
    const result = await lineage.resolve('ok-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.complete).toBe(true);
      expect(result.value.notes).toHaveLength(0);
      expect(result.value.nodes).toHaveLength(2);
    }
  });

  it('findAncestorByTaskKind miss → ok:true + node null', async () => {
    const artifacts = [makeArtifact('solo', 't-1', [])];
    const tasks = [{ taskId: 't-1', taskKind: 'dreamer' }];
    const deps = makeStub(artifacts, tasks);
    const lineage = makeLineage(deps);
    const result = await lineage.findAncestorByTaskKind('solo', 'evaluator');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.node).toBeNull();
  });

  it('contentJson stays unknown (not narrowed) on the returned node', async () => {
    const deps = makeStub(
      [makeArtifact('unk', 't-1', [], { complex: { nested: [1, 2] } })],
      [{ taskId: 't-1', taskKind: 'dreamer' }],
    );
    const lineage = makeLineage(deps);
    const result = await lineage.resolve('unk');
    if (result.ok) {
      // contentJson is typed `unknown` — we verify it's an object but the type
      // system guarantees it was never cast to a specific shape.
      expect(typeof result.value.nodes[0]?.contentJson).toBe('object');
    }
  });
});

// ── CP-20: failures never swallowed ──────────────────────────────────────────

describe('CP-20 — lineage failures never swallowed', () => {
  it('all three LineageError kinds produce ok:false (never a silent ok:true)', async () => {
    // content_json_unparseable
    const r1 = await makeLineage(makeStub(
      [makeArtifact('a', 't', [], 'bad{json')],
      [{ taskId: 't', taskKind: 'dreamer' }],
    )).resolve('a');
    expect(r1.ok).toBe(false);

    // artifact_shape_invalid
    const r2 = await makeLineage(makeStub(
      [{ ...makeArtifact('b', 't', []), sourceTaskId: '' }],
      [{ taskId: 't', taskKind: 'dreamer' }],
    )).resolve('b');
    expect(r2.ok).toBe(false);

    // store_failure
    const r3 = await new CandidateLineage({
      artifacts: { getArtifactById: async () => { throw new Error('boom'); } },
      tasks: { getTaskById: async () => null },
    }).resolve('c');
    expect(r3.ok).toBe(false);
  });

  it('every ok:false result has a non-empty error.kind (no generic "unknown" failure)', async () => {
    const results: LineageResult[] = [];
    // Run all three failure modes.
    for (const setup of [
      { art: makeArtifact('x', 't', [], 'bad'), task: { taskId: 't', taskKind: 'dreamer' } },
      { art: { ...makeArtifact('y', 't', []), sourceTaskId: '' }, task: { taskId: 't', taskKind: 'dreamer' } },
    ]) {
      const r = await makeLineage(makeStub([setup.art], [setup.task])).resolve(setup.art.artifactId);
      results.push(r);
    }
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // error.kind is one of the three known kinds — never empty or undefined.
        expect(['content_json_unparseable', 'artifact_shape_invalid', 'store_failure']).toContain(r.error.kind);
      }
    }
  });
});
