import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = {
  prepare: vi.fn(),
  close: vi.fn(),
};

const Database = vi.mocked(await import('better-sqlite3')).default;

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function () { return mockDb; }),
}));

const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  default: { existsSync: mockExistsSync },
}));

import { InternalizationChainIntegrityReadModel } from '../internalization-chain-integrity-read-model.js';

const WS = '/fake/workspace';

function _mockQuery(sql: string, rows: unknown[]) {
  mockDb.prepare.mockImplementation((s: string) => {
    if (s === sql) {
      return { all: vi.fn(() => rows), get: vi.fn(() => undefined) };
    }
    return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
  });
}

function _setupAllQueries(data: {
  candidates?: unknown[];
  tasks?: unknown[];
  runs?: unknown[];
  piArtifacts?: unknown[];
}) {
  mockDb.prepare.mockImplementation((sql: string) => {
    if (sql.includes('principle_candidates')) {
      return { all: vi.fn(() => data.candidates ?? []), get: vi.fn(() => undefined) };
    }
    if (sql.includes('FROM tasks')) {
      return { all: vi.fn(() => data.tasks ?? []), get: vi.fn(() => undefined) };
    }
    if (sql.includes('FROM runs')) {
      return { all: vi.fn(() => data.runs ?? []), get: vi.fn(() => undefined) };
    }
    if (sql.includes('FROM pi_artifacts') && !sql.includes('WHERE')) {
      return { all: vi.fn(() => data.piArtifacts ?? []), get: vi.fn(() => undefined) };
    }
    if (sql.includes('artifact_id FROM artifacts')) {
      return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
    }
    return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
  });
}

describe('InternalizationChainIntegrityReadModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    Database.mockImplementation(function () { return mockDb; });
  });

  it('returns error when DB does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.overallStatus).toBe('error');
    expect(result.brokenLinks.length).toBeGreaterThan(0);
    expect(result.brokenLinks[0]?.type).toBe('database_missing');
  });

  it('returns ok when no broken links exist', () => {
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes('principle_candidates')) {
        return { all: vi.fn(() => [{ candidate_id: 'c1', task_id: 't1', source_run_id: 'r1' }]), get: vi.fn(() => undefined) };
      }
      if (sql.includes('FROM tasks')) {
        return { all: vi.fn(() => [
          { task_id: 't1', task_kind: 'dreamer', status: 'succeeded', result_ref: null, lease_owner: null, lease_expires_at: null, attempt_count: 1, max_attempts: 3, diagnostic_json: '{"candidateId":"c1"}' },
          { task_id: 't2', task_kind: 'philosopher', status: 'pending', result_ref: null, lease_owner: null, lease_expires_at: null, attempt_count: 0, max_attempts: 3, diagnostic_json: '{"parentTaskId":"t1","dependencyTaskIds":["t1"]}' },
        ]), get: vi.fn(() => undefined) };
      }
      if (sql.includes('FROM runs')) {
        return { all: vi.fn(() => [{ run_id: 'run1', task_id: 't1', execution_status: 'succeeded' }]), get: vi.fn(() => undefined) };
      }
      if (sql.includes('FROM pi_artifacts') && !sql.includes('WHERE')) {
        return { all: vi.fn(() => [{ artifact_id: 'pia1', artifact_kind: 'principle', source_task_id: 't1' }]), get: vi.fn(() => undefined) };
      }
      return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.overallStatus).toBe('ok');
    expect(result.brokenLinks.length).toBe(0);
  });

  it('reports missing dreamer task for consumed candidate', () => {
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes('principle_candidates')) {
        return { all: vi.fn(() => [{ candidate_id: 'c1', task_id: 't_nonexistent', source_run_id: 'r1' }]), get: vi.fn(() => undefined) };
      }
      if (sql.includes('FROM tasks')) {
        return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
      }
      return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.overallStatus).not.toBe('ok');
    expect(result.brokenLinks.some(l => l.type === 'missing_dreamer_task')).toBe(true);
  });

  it('reports missing PI artifact for succeeded dreamer', () => {
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes('principle_candidates')) {
        return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
      }
      if (sql.includes('FROM tasks')) {
        return { all: vi.fn(() => [
          { task_id: 't1', task_kind: 'dreamer', status: 'succeeded', result_ref: null, lease_owner: null, lease_expires_at: null, attempt_count: 1, max_attempts: 3, diagnostic_json: null },
        ]), get: vi.fn(() => undefined) };
      }
      if (sql.includes('FROM runs')) {
        return { all: vi.fn(() => [{ run_id: 'run1', task_id: 't1', execution_status: 'succeeded' }]), get: vi.fn(() => undefined) };
      }
      if (sql.includes('FROM pi_artifacts') && !sql.includes('WHERE')) {
        return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
      }
      return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.brokenLinks.some(l => l.type === 'missing_dreamer_pi_artifact')).toBe(true);
  });

  it('reports task succeeded but no succeeded run', () => {
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes('principle_candidates')) {
        return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
      }
      if (sql.includes('FROM tasks')) {
        return { all: vi.fn(() => [
          { task_id: 't1', task_kind: 'dreamer', status: 'succeeded', result_ref: null, lease_owner: null, lease_expires_at: null, attempt_count: 1, max_attempts: 3, diagnostic_json: null },
        ]), get: vi.fn(() => undefined) };
      }
      if (sql.includes('FROM runs')) {
        return { all: vi.fn(() => [{ run_id: 'run1', task_id: 't1', execution_status: 'failed' }]), get: vi.fn(() => undefined) };
      }
      return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.brokenLinks.some(l => l.type === 'task_succeeded_no_succeeded_run')).toBe(true);
  });

  it('reports lease stuck with expired lease', () => {
    const pastDate = new Date(Date.now() - 60000).toISOString();
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes('principle_candidates')) {
        return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
      }
      if (sql.includes('FROM tasks')) {
        return { all: vi.fn(() => [
          { task_id: 't1', task_kind: 'dreamer', status: 'leased', result_ref: null, lease_owner: 'owner1', lease_expires_at: pastDate, attempt_count: 1, max_attempts: 3, diagnostic_json: null },
        ]), get: vi.fn(() => undefined) };
      }
      return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.brokenLinks.some(l => l.type === 'lease_stuck')).toBe(true);
  });

  it('does NOT report missing_dreamer_task for consumed defer candidate (PRI-253)', () => {
    // Deferred candidates correctly have no dreamer task — they never enter internalization
    _setupAllQueries({
      candidates: [{ candidate_id: 'c-defer', task_id: 'diag-1', source_run_id: 'r1' }],
      tasks: [],  // no dreamer for this candidate — correct for defer
      runs: [],
      piArtifacts: [],
    });
    // The candidate must have recommendation_kind = 'defer' in the source_recommendation_json
    // The read model queries the candidates table — we need to provide the recommendation_kind column
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes('principle_candidates')) {
        return {
          all: vi.fn(() => [{
            candidate_id: 'c-defer',
            task_id: 'diag-1',
            source_run_id: 'r1',
            recommendation_kind: 'defer',
          }]),
          get: vi.fn(() => undefined),
        };
      }
      return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.brokenLinks.some(l => l.type === 'missing_dreamer_task' && l.candidateId === 'c-defer')).toBe(false);
  });

  it('DOES report missing_dreamer_task for consumed actionable candidate without dreamer (PRI-253)', () => {
    // Non-defer candidates (principle, rule, prompt, implementation) MUST have dreamer tasks
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes('principle_candidates')) {
        return {
          all: vi.fn(() => [{
            candidate_id: 'c-action',
            task_id: 'diag-2',
            source_run_id: 'r2',
            recommendation_kind: 'principle',
          }]),
          get: vi.fn(() => undefined),
        };
      }
      return { all: vi.fn(() => []), get: vi.fn(() => undefined) };
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.brokenLinks.some(l => l.type === 'missing_dreamer_task' && l.candidateId === 'c-action')).toBe(true);
  });

  it('includes generatedAt in output', () => {
    mockExistsSync.mockReturnValue(false);
    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.generatedAt).toBeTruthy();
    expect(new Date(result.generatedAt).getTime()).not.toBeNaN();
  });
});
