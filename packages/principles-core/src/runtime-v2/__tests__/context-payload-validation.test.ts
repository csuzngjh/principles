/**
 * Context Payload Type Validation Tests
 *
 * Tests the TypeBox schema validation and edge cases for:
 * - HistoryQueryEntry
 * - TrajectoryLocateResult
 * - DiagnosisTarget
 * - PainEvidenceEntry
 */

import { describe, it, expect } from 'vitest';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import {
  HistoryQueryEntrySchema,
  TrajectoryLocateQuerySchema,
  TrajectoryCandidateSchema,
  TrajectoryLocateResultSchema,
  DiagnosisTargetSchema,
  PainEvidenceEntrySchema,
  type HistoryQueryEntry,
  type TrajectoryLocateQuery,
  type TrajectoryCandidate,
  type TrajectoryLocateResult,
  type DiagnosisTarget,
  type PainEvidenceEntry,
} from '../context-payload.js';

// Compile schemas for validation
const checkHistoryQueryEntry = TypeCompiler.Compile(HistoryQueryEntrySchema);
const checkTrajectoryLocateQuery = TypeCompiler.Compile(TrajectoryLocateQuerySchema);
const checkTrajectoryCandidate = TypeCompiler.Compile(TrajectoryCandidateSchema);
const checkTrajectoryLocateResult = TypeCompiler.Compile(TrajectoryLocateResultSchema);
const checkDiagnosisTarget = TypeCompiler.Compile(DiagnosisTargetSchema);
const checkPainEvidenceEntry = TypeCompiler.Compile(PainEvidenceEntrySchema);

describe('HistoryQueryEntrySchema', () => {
  it('accepts valid user role entry', () => {
    const entry: HistoryQueryEntry = {
      ts: '2024-01-01T00:00:00Z',
      role: 'user',
      text: 'Hello world',
    };

    expect(checkHistoryQueryEntry.Check(entry)).toBe(true);
  });

  it('accepts valid assistant role entry', () => {
    const entry: HistoryQueryEntry = {
      ts: '2024-01-01T00:00:01Z',
      role: 'assistant',
      text: 'Response',
      eventType: 'response',
    };

    expect(checkHistoryQueryEntry.Check(entry)).toBe(true);
  });

  it('accepts valid tool role entry with toolName', () => {
    const entry: HistoryQueryEntry = {
      ts: '2024-01-01T00:00:02Z',
      role: 'tool',
      toolName: 'execute_command',
      toolResultSummary: 'Success',
    };

    expect(checkHistoryQueryEntry.Check(entry)).toBe(true);
  });

  it('accepts valid system role entry', () => {
    const entry: HistoryQueryEntry = {
      ts: '2024-01-01T00:00:00Z',
      role: 'system',
      text: 'System message',
    };

    expect(checkHistoryQueryEntry.Check(entry)).toBe(true);
  });

  it('rejects entry with invalid role', () => {
    const entry = {
      ts: '2024-01-01T00:00:00Z',
      role: 'invalid_role',
      text: 'Test',
    };

    expect(checkHistoryQueryEntry.Check(entry)).toBe(false);
  });

  it('rejects entry missing required ts field', () => {
    const entry = {
      role: 'user',
      text: 'Test',
    };

    expect(checkHistoryQueryEntry.Check(entry)).toBe(false);
  });

  it('rejects entry with empty ts string', () => {
    const entry = {
      ts: '',
      role: 'user',
      text: 'Test',
    };

    expect(checkHistoryQueryEntry.Check(entry)).toBe(false);
  });
});

describe('TrajectoryLocateQuerySchema', () => {
  it('accepts query with painId', () => {
    const query: TrajectoryLocateQuery = {
      painId: 'pain-001',
    };

    expect(checkTrajectoryLocateQuery.Check(query)).toBe(true);
  });

  it('accepts query with taskId', () => {
    const query: TrajectoryLocateQuery = {
      taskId: 'task-001',
    };

    expect(checkTrajectoryLocateQuery.Check(query)).toBe(true);
  });

  it('accepts query with multiple identifiers', () => {
    const query: TrajectoryLocateQuery = {
      painId: 'pain-001',
      taskId: 'task-001',
      runId: 'run-001',
      sessionId: 'session-001',
    };

    expect(checkTrajectoryLocateQuery.Check(query)).toBe(true);
  });

  it('accepts query with timeRange', () => {
    const query: TrajectoryLocateQuery = {
      timeRange: {
        start: '2024-01-01T00:00:00Z',
        end: '2024-01-02T00:00:00Z',
      },
    };

    expect(checkTrajectoryLocateQuery.Check(query)).toBe(true);
  });

  it('accepts empty query (all fields optional)', () => {
    const query: TrajectoryLocateQuery = {};

    expect(checkTrajectoryLocateQuery.Check(query)).toBe(true);
  });

  it('rejects query with empty painId', () => {
    const query = {
      painId: '',
    };

    expect(checkTrajectoryLocateQuery.Check(query)).toBe(false);
  });
});

describe('TrajectoryCandidateSchema', () => {
  it('accepts valid candidate', () => {
    const candidate: TrajectoryCandidate = {
      trajectoryRef: 'traj-001',
      confidence: 0.85,
      reasons: ['High confidence match'],
    };

    expect(checkTrajectoryCandidate.Check(candidate)).toBe(true);
  });

  it('accepts candidate with sourceTypes', () => {
    const candidate: TrajectoryCandidate = {
      trajectoryRef: 'traj-002',
      confidence: 0.9,
      reasons: ['Exact match', 'Recent activity'],
      sourceTypes: ['user_message', 'assistant_response'],
    };

    expect(checkTrajectoryCandidate.Check(candidate)).toBe(true);
  });

  it('rejects candidate with confidence below 0', () => {
    const candidate = {
      trajectoryRef: 'traj-003',
      confidence: -0.1,
      reasons: ['Test'],
    };

    expect(checkTrajectoryCandidate.Check(candidate)).toBe(false);
  });

  it('rejects candidate with confidence above 1', () => {
    const candidate = {
      trajectoryRef: 'traj-004',
      confidence: 1.5,
      reasons: ['Test'],
    };

    expect(checkTrajectoryCandidate.Check(candidate)).toBe(false);
  });

  it('accepts candidate with confidence at boundaries (0 and 1)', () => {
    const candidate0: TrajectoryCandidate = {
      trajectoryRef: 'traj-005',
      confidence: 0,
      reasons: ['Low confidence'],
    };

    const candidate1: TrajectoryCandidate = {
      trajectoryRef: 'traj-006',
      confidence: 1,
      reasons: ['Perfect match'],
    };

    expect(checkTrajectoryCandidate.Check(candidate0)).toBe(true);
    expect(checkTrajectoryCandidate.Check(candidate1)).toBe(true);
  });

  it('rejects candidate with empty reason string', () => {
    const candidate = {
      trajectoryRef: 'traj-008',
      confidence: 0.5,
      reasons: ['', 'valid reason'],
    };

    expect(checkTrajectoryCandidate.Check(candidate)).toBe(false);
  });
});

describe('TrajectoryLocateResultSchema', () => {
  it('accepts valid result with multiple candidates', () => {
    const result: TrajectoryLocateResult = {
      query: { painId: 'pain-001' },
      candidates: [
        {
          trajectoryRef: 'traj-001',
          confidence: 0.9,
          reasons: ['Primary match'],
        },
        {
          trajectoryRef: 'traj-002',
          confidence: 0.7,
          reasons: ['Secondary match'],
        },
      ],
    };

    expect(checkTrajectoryLocateResult.Check(result)).toBe(true);
  });

  it('accepts result with empty candidates array', () => {
    const result: TrajectoryLocateResult = {
      query: { painId: 'pain-002' },
      candidates: [],
    };

    expect(checkTrajectoryLocateResult.Check(result)).toBe(true);
  });

  it('rejects result missing query field', () => {
    const result = {
      candidates: [],
    };

    expect(checkTrajectoryLocateResult.Check(result)).toBe(false);
  });
});

describe('DiagnosisTargetSchema', () => {
  it('accepts minimal diagnosis target', () => {
    const target: DiagnosisTarget = {};

    expect(checkDiagnosisTarget.Check(target)).toBe(true);
  });

  it('accepts diagnosis target with all fields', () => {
    const target: DiagnosisTarget = {
      reasonSummary: 'Test reason',
      source: 'user_reported',
      severity: 'high',
      painId: 'pain-001',
      sessionIdHint: 'session-001',
      provenance: 'owner_reported_no_host_trace',
      provenanceReason: 'Manual report from owner',
      traceAvailability: 'available',
      evidence: [
        { sourceRef: 'ref-001', note: 'Evidence note' },
      ],
    };

    expect(checkDiagnosisTarget.Check(target)).toBe(true);
  });

  it('accepts diagnosis target with unavailable trace', () => {
    const target: DiagnosisTarget = {
      painId: 'pain-002',
      traceAvailability: 'unavailable_with_reason',
      traceUnavailableDetail: {
        reason: 'Session expired',
        nextAction: 'Request owner to re-report',
      },
    };

    expect(checkDiagnosisTarget.Check(target)).toBe(true);
  });

  it('accepts all provenance variants', () => {
    const provenances: DiagnosisTarget['provenance'][] = [
      'host_context_bound',
      'owner_reported_no_host_trace',
      'automatic_hook',
    ];

    provenances.forEach((provenance) => {
      const target: DiagnosisTarget = { provenance };
      expect(checkDiagnosisTarget.Check(target)).toBe(true);
    });
  });

  it('accepts all traceAvailability variants', () => {
    const availabilities: DiagnosisTarget['traceAvailability'][] = [
      'available',
      'unavailable_with_reason',
      'ambiguous',
    ];

    availabilities.forEach((traceAvailability) => {
      const target: DiagnosisTarget = { traceAvailability };
      expect(checkDiagnosisTarget.Check(target)).toBe(true);
    });
  });

  it('rejects invalid provenance value', () => {
    const target = {
      provenance: 'invalid_provenance',
    };

    expect(checkDiagnosisTarget.Check(target)).toBe(false);
  });
});

describe('PainEvidenceEntrySchema', () => {
  it('accepts valid evidence entry', () => {
    const entry: PainEvidenceEntry = {
      sourceRef: 'ref-001',
      note: 'User reported an error',
    };

    expect(checkPainEvidenceEntry.Check(entry)).toBe(true);
  });

  it('rejects evidence entry with empty sourceRef', () => {
    const entry = {
      sourceRef: '',
      note: 'Test note',
    };

    expect(checkPainEvidenceEntry.Check(entry)).toBe(false);
  });

  it('rejects evidence entry with empty note', () => {
    const entry = {
      sourceRef: 'ref-002',
      note: '',
    };

    expect(checkPainEvidenceEntry.Check(entry)).toBe(false);
  });

  it('rejects evidence entry with note exceeding maxLength', () => {
    const entry = {
      sourceRef: 'ref-003',
      note: 'a'.repeat(201), // maxLength: 200
    };

    expect(checkPainEvidenceEntry.Check(entry)).toBe(false);
  });

  it('accepts evidence entry with note at maxLength boundary', () => {
    const entry: PainEvidenceEntry = {
      sourceRef: 'ref-004',
      note: 'a'.repeat(200), // maxLength: 200
    };

    expect(checkPainEvidenceEntry.Check(entry)).toBe(true);
  });
});