/**
 * RunnerKind seam tests (INF-1..INF-8) — PRI-370
 *
 * Verifies the DiagnosticianStageKind / RunnerKind type seam that
 * introduces the diagnostician pipeline as a separate execution kind
 * without overloading PeerRunnerKind.
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
import {
  DIAGNOSTICIAN_EDGES,
  validateDiagEdge,
  getDiagSuccessors,
} from '../internalization-job-graph.js';
import {
  hydratePITaskRecord,
  serializePITaskMetadata,
  parsePITaskMetadata,
} from '../pitask-metadata.js';
import { decideArtifactRejectionFeedback } from '../internalization-state-machine.js';
import { DEFAULT_FEATURE_FLAGS } from '../../feature-flags/feature-flag-contract.js';
import type { TaskRecord } from '../../task-status.js';

// ── INF-1: DiagnosticianStageKind + RunnerKind type guards ──────────────────

describe('INF-1: DiagnosticianStageKind + RunnerKind type guards', () => {
  it('isDiagnosticianStageKind("diag_rootcause") === true', () => {
    expect(isDiagnosticianStageKind('diag_rootcause')).toBe(true);
  });

  it('isDiagnosticianStageKind("diag_distiller") === true', () => {
    expect(isDiagnosticianStageKind('diag_distiller')).toBe(true);
  });

  it('isDiagnosticianStageKind("diag_router") === true', () => {
    expect(isDiagnosticianStageKind('diag_router')).toBe(true);
  });

  it('isPeerRunnerKind("diag_rootcause") === false', () => {
    expect(isPeerRunnerKind('diag_rootcause')).toBe(false);
  });

  it('isRunnerKind("diag_rootcause") === true', () => {
    expect(isRunnerKind('diag_rootcause')).toBe(true);
  });

  it('isRunnerKind("dreamer") === true', () => {
    expect(isRunnerKind('dreamer')).toBe(true);
  });

  it('isRunnerKind("invalid") === false', () => {
    expect(isRunnerKind('invalid')).toBe(false);
  });

  it('DIAGNOSTICIAN_STAGE_KINDS has exactly 3 entries', () => {
    expect(DIAGNOSTICIAN_STAGE_KINDS).toHaveLength(3);
    expect(DIAGNOSTICIAN_STAGE_KINDS).toEqual(['diag_rootcause', 'diag_distiller', 'diag_router']);
  });

  it('PeerRunnerKind and DiagnosticianStageKind are disjoint', () => {
    for (const dk of DIAGNOSTICIAN_STAGE_KINDS) {
      expect(isPeerRunnerKind(dk)).toBe(false);
    }
    for (const pk of PEER_RUNNER_KINDS) {
      expect(isDiagnosticianStageKind(pk)).toBe(false);
    }
  });
});

// ── INF-2: DIAGNOSTICIAN_EDGES + validateDiagEdge ──────────────────────────

describe('INF-2: DIAGNOSTICIAN_EDGES + validateDiagEdge', () => {
  it('validateDiagEdge("diag_rootcause", "diag_distiller") === true', () => {
    expect(validateDiagEdge('diag_rootcause', 'diag_distiller')).toBe(true);
  });

  it('validateDiagEdge("diag_distiller", "diag_router") === true', () => {
    expect(validateDiagEdge('diag_distiller', 'diag_router')).toBe(true);
  });

  it('validateDiagEdge("diag_rootcause", "diag_router") === false (skip)', () => {
    expect(validateDiagEdge('diag_rootcause', 'diag_router')).toBe(false);
  });

  it('validateDiagEdge("diag_router", "diag_rootcause") === false (reverse)', () => {
    expect(validateDiagEdge('diag_router', 'diag_rootcause')).toBe(false);
  });

  it('getDiagSuccessors("diag_rootcause") returns ["diag_distiller"]', () => {
    expect(getDiagSuccessors('diag_rootcause')).toEqual(['diag_distiller']);
  });

  it('getDiagSuccessors("diag_distiller") returns ["diag_router"]', () => {
    expect(getDiagSuccessors('diag_distiller')).toEqual(['diag_router']);
  });

  it('getDiagSuccessors("diag_router") returns []', () => {
    expect(getDiagSuccessors('diag_router')).toEqual([]);
  });

  it('DIAGNOSTICIAN_EDGES has exactly 2 edges', () => {
    expect(DIAGNOSTICIAN_EDGES).toHaveLength(2);
  });
});

// ── INF-3: hydratePITaskRecord accepts RunnerKind ──────────────────────────

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

  it('hydratePITaskRecord succeeds on diag_rootcause task', () => {
    const task = makeTask('diag_rootcause');
    const result = hydratePITaskRecord(task);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.taskKind).toBe('diag_rootcause');
    }
  });

  it('hydratePITaskRecord succeeds on diag_distiller task', () => {
    const task = makeTask('diag_distiller');
    const result = hydratePITaskRecord(task);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.taskKind).toBe('diag_distiller');
    }
  });

  it('hydratePITaskRecord succeeds on dreamer task (PeerRunnerKind)', () => {
    const task = makeTask('dreamer');
    const result = hydratePITaskRecord(task);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.taskKind).toBe('dreamer');
    }
  });

  it('hydratePITaskRecord returns null for invalid taskKind', () => {
    const task = makeTask('invalid_kind');
    const result = hydratePITaskRecord(task);
    expect(result).toBeNull();
  });

  it('isValidPITaskRecord accepts diag_rootcause', () => {
    const record = createMinimalPITaskRecord('test-1', 'diag_rootcause', 'prompt');
    expect(isValidPITaskRecord(record)).toBe(true);
  });

  it('createMinimalPITaskRecord works with DiagnosticianStageKind', () => {
    const record = createMinimalPITaskRecord('test-2', 'diag_router', 'prompt');
    expect(record.taskKind).toBe('diag_router');
    expect(record.status).toBe('pending');
  });
});

// ── INF-7: Feature flags registered ────────────────────────────────────────

describe('INF-7: Feature flags registered', () => {
  it('diagnostician_split_pipeline flag exists in DEFAULT_FEATURE_FLAGS', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'diagnostician_split_pipeline');
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.category).toBe('quiet');
      expect(flag.enabled).toBe(false);
    }
  });

  it('diagnostician_async_cli flag exists in DEFAULT_FEATURE_FLAGS', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'diagnostician_async_cli');
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.category).toBe('quiet');
      expect(flag.enabled).toBe(false);
    }
  });

  it('diagnostician_core_grounding flag exists in DEFAULT_FEATURE_FLAGS', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'diagnostician_core_grounding');
    expect(flag).toBeDefined();
    if (flag) {
      expect(flag.category).toBe('quiet');
      expect(flag.enabled).toBe(false);
    }
  });
});

// ── INF-8: Metadata envelope supports DiagnosticianStageKind ───────────────

describe('INF-8: Metadata envelope supports DiagnosticianStageKind', () => {
  it('serializePITaskMetadata works with DiagnosticianStageKind task', () => {
    const metadata = {
      dependencyTaskIds: ['dep-1'],
      channel: 'prompt' as const,
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      parentTaskId: 'parent-1',
      correlationId: 'corr-1',
      rejectionCount: 0,
    };
    const json = serializePITaskMetadata(metadata);
    expect(json).toBeTruthy();

    const parsed = parsePITaskMetadata(json);
    expect(parsed).not.toBeNull();
    if (parsed) {
      expect(parsed.dependencyTaskIds).toEqual(['dep-1']);
      expect(parsed.channel).toBe('prompt');
    }
  });

  it('parsePITaskMetadata round-trips diag_rootcause metadata', () => {
    const metadata = {
      dependencyTaskIds: [],
      channel: 'prompt' as const,
      timeoutMs: 60000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      rejectionCount: 0,
    };
    const json = serializePITaskMetadata(metadata);
    const parsed = parsePITaskMetadata(json);
    expect(parsed).not.toBeNull();
    if (parsed) {
      expect(parsed.channel).toBe('prompt');
      expect(parsed.timeoutMs).toBe(60000);
    }
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
