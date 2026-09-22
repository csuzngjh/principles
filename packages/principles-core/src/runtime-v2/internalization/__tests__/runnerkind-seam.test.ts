/**
 * RunnerKind seam tests (INF-1..INF-8) — PRI-370.
 *
 * Consolidated in PRI-891 (Test Diet 2.2-B1): the implementation-derived
 * literal echoes (table-content/length pins, per-kind positive guard its,
 * flag-existence echoes of DEFAULT_FEATURE_FLAGS, metadata round-trip already
 * owned by pitask-metadata tests) were removed. What remains is the
 * cross-set invariant signal:
 *   - the stage/peer kind partition of the RunnerKind union,
 *   - the diagnostician job-graph edge accept/reject semantics,
 *   - hydration accept/ignore behavior at the metadata boundary,
 *   - the decideArtifactRejectionFeedback escalation regression.
 */
import { describe, it, expect } from 'vitest';
import {
  isPeerRunnerKind,
  isDiagnosticianStageKind,
  isRunnerKind,
  DIAGNOSTICIAN_STAGE_KINDS,
  PEER_RUNNER_KINDS,
  isValidPITaskRecord,
  createMinimalPITaskRecord,
} from '../peer-runner-contracts.js';
import { validateDiagEdge } from '../internalization-job-graph.js';
import { hydratePITaskRecord } from '../pitask-metadata.js';
import { decideArtifactRejectionFeedback } from '../internalization-state-machine.js';
import type { TaskRecord } from '../../task-status.js';

// ── INF-1: DiagnosticianStageKind / PeerRunnerKind partition ────────────────

describe('INF-1: DiagnosticianStageKind + PeerRunnerKind partition', () => {
  it('stage kinds and peer kinds partition the RunnerKind union; guards reject unknown kinds', () => {
    for (const dk of DIAGNOSTICIAN_STAGE_KINDS) {
      expect(isRunnerKind(dk)).toBe(true);
      expect(isDiagnosticianStageKind(dk)).toBe(true);
      expect(isPeerRunnerKind(dk)).toBe(false);
    }
    for (const pk of PEER_RUNNER_KINDS) {
      expect(isRunnerKind(pk)).toBe(true);
      expect(isPeerRunnerKind(pk)).toBe(true);
      expect(isDiagnosticianStageKind(pk)).toBe(false);
    }
    expect(isRunnerKind('invalid')).toBe(false);
  });
});

// ── INF-2: diagnostician job-graph edge semantics ──────────────────────────

describe('INF-2: DIAGNOSTICIAN_EDGES + validateDiagEdge', () => {
  it('chain edges are valid; skip edge and reverse edge are rejected', () => {
    expect(validateDiagEdge('diag_rootcause', 'diag_distiller')).toBe(true);
    expect(validateDiagEdge('diag_distiller', 'diag_router')).toBe(true);
    expect(validateDiagEdge('diag_rootcause', 'diag_router')).toBe(false);
    expect(validateDiagEdge('diag_router', 'diag_rootcause')).toBe(false);
  });
});

// ── INF-3: hydratePITaskRecord accepts RunnerKind / rejects unknown ────────

describe('INF-3: hydratePITaskRecord accepts RunnerKind', () => {
  function makeTask(taskKind: string): TaskRecord & Record<string, unknown> {
    return {
      taskId: 'test-task-1',
      taskKind,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        pi_metadata: {
          dependencyTaskIds: [],
          channel: 'prompt',
          timeoutMs: 60000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
          rejectionCount: 0,
        },
      }),
    };
  }

  it('hydrates peer and diagnostician stage tasks and validates the produced records', () => {
    for (const kind of ['diag_rootcause', 'diag_distiller', 'dreamer']) {
      const result = hydratePITaskRecord(makeTask(kind));
      expect(result).not.toBeNull();
      if (result) {
        expect(result.taskKind).toBe(kind);
      }
    }
    const record = createMinimalPITaskRecord('test-1', 'diag_rootcause', 'prompt');
    expect(isValidPITaskRecord(record)).toBe(true);
    const routerRecord = createMinimalPITaskRecord('test-2', 'diag_router', 'prompt');
    expect(routerRecord.taskKind).toBe('diag_router');
    expect(routerRecord.status).toBe('pending');
  });

  it('hydratePITaskRecord returns null for invalid taskKind', () => {
    expect(hydratePITaskRecord(makeTask('invalid_kind'))).toBeNull();
  });
});

// ── Regression: decideArtifactRejectionFeedback for diagnostician tasks ─────

describe('Regression: decideArtifactRejectionFeedback for diagnostician tasks', () => {
  it('escalates with rejectionReason when taskKind is DiagnosticianStageKind', () => {
    const artifact = {
      artifactId: 'art-1',
      artifactKind: 'principle' as const,
      sourceTaskId: 'task-1',
      lineageRefs: [],
      validationStatus: 'rejected' as const,
    };
    const diagTask = createMinimalPITaskRecord('task-1', 'diag_rootcause', 'prompt');
    const result = decideArtifactRejectionFeedback(artifact, diagTask);
    expect(result.action).toBe('escalate');
    if (result.action === 'escalate') {
      expect(result.rejectionReason).toContain('unexpected_diagnostician_taskKind:diag_rootcause');
    }
  });
});
