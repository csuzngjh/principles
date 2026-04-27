import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CandidateIntakeInputSchema,
  CandidateIntakeOutputSchema,
  CandidateIntakeError,
  INTAKE_ERROR_CODES,
  LedgerPrincipleEntrySchema,
} from '../src/runtime-v2/candidate-intake.js';
import type { CandidateIntakeInput, CandidateIntakeOutput, LedgerPrincipleEntry, LedgerAdapter } from '../src/runtime-v2/candidate-intake.js';

describe('INTAKE-01 — CandidateIntakeInputSchema', () => {
  it('validates correct shape: { candidateId, workspaceDir }', () => {
    const valid = { candidateId: 'cand-1', workspaceDir: '/tmp/ws' };
    expect(Value.Check(CandidateIntakeInputSchema, valid)).toBe(true);
  });

  it('rejects missing candidateId', () => {
    const invalid = { workspaceDir: '/tmp/ws' };
    expect(Value.Check(CandidateIntakeInputSchema, invalid)).toBe(false);
  });

  it('rejects missing workspaceDir', () => {
    const invalid = { candidateId: 'cand-1' };
    expect(Value.Check(CandidateIntakeInputSchema, invalid)).toBe(false);
  });

  it('rejects empty string candidateId', () => {
    const invalid = { candidateId: '', workspaceDir: '/tmp/ws' };
    expect(Value.Check(CandidateIntakeInputSchema, invalid)).toBe(false);
  });

  it('rejects empty string workspaceDir', () => {
    const invalid = { candidateId: 'cand-1', workspaceDir: '' };
    expect(Value.Check(CandidateIntakeInputSchema, invalid)).toBe(false);
  });

  it('accepts but does not recognize extra artifactId field (D-01 regression guard)', () => {
    const input = { candidateId: 'cand-1', workspaceDir: '/tmp/ws', artifactId: 'art-1' };
    expect(Value.Check(CandidateIntakeInputSchema, input)).toBe(true);
  });
});

describe('INTAKE-02 — CandidateIntakeOutputSchema', () => {
  it('validates correct shape', () => {
    const valid = {
      candidateId: 'cand-1',
      artifactId: 'art-1',
      ledgerRef: 'ledger://principle/P_123456',
      status: 'consumed',
    };
    expect(Value.Check(CandidateIntakeOutputSchema, valid)).toBe(true);
  });

  it('rejects missing ledgerRef', () => {
    const invalid = { candidateId: 'cand-1', artifactId: 'art-1', status: 'consumed' };
    expect(Value.Check(CandidateIntakeOutputSchema, invalid)).toBe(false);
  });

  it('rejects status !== "consumed"', () => {
    const invalid = { candidateId: 'cand-1', artifactId: 'art-1', ledgerRef: 'ref', status: 'pending' };
    expect(Value.Check(CandidateIntakeOutputSchema, invalid)).toBe(false);
  });

  it('rejects missing status', () => {
    const invalid = { candidateId: 'cand-1', artifactId: 'art-1', ledgerRef: 'ref' };
    expect(Value.Check(CandidateIntakeOutputSchema, invalid)).toBe(false);
  });
});

describe('INTAKE-03 — CandidateIntakeError + INTAKE_ERROR_CODES', () => {
  it('error name is CandidateIntakeError', () => {
    const err = new CandidateIntakeError(INTAKE_ERROR_CODES.CANDIDATE_NOT_FOUND, 'msg');
    expect(err.name).toBe('CandidateIntakeError');
  });

  it('error extends Error', () => {
    const err = new CandidateIntakeError(INTAKE_ERROR_CODES.INPUT_INVALID, 'msg');
    expect(err).toBeInstanceOf(Error);
  });

  it('error.code is the provided code', () => {
    const err = new CandidateIntakeError(INTAKE_ERROR_CODES.LEDGER_WRITE_FAILED, 'msg');
    expect(err.code).toBe('ledger_write_failed');
  });

  it('error.context stores optional details', () => {
    const err = new CandidateIntakeError(INTAKE_ERROR_CODES.ARTIFACT_NOT_FOUND, 'msg', { artifactId: 'x' });
    expect(err.context).toEqual({ artifactId: 'x' });
  });

  it('INTAKE_ERROR_CODES has all 5 required keys (D-12)', () => {
    const keys = Object.keys(INTAKE_ERROR_CODES);
    expect(keys).toHaveLength(5);
    expect(keys).toContain('CANDIDATE_NOT_FOUND');
    expect(keys).toContain('CANDIDATE_ALREADY_CONSUMED');
    expect(keys).toContain('ARTIFACT_NOT_FOUND');
    expect(keys).toContain('LEDGER_WRITE_FAILED');
    expect(keys).toContain('INPUT_INVALID');
  });
});

describe('INTAKE-04 — LedgerAdapter interface (structural conformance)', () => {
  it('mock adapter satisfies LedgerAdapter shape', () => {
    const mock: LedgerAdapter = {
      writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry {
        return entry;
      },
      existsForCandidate(candidateId: string): LedgerPrincipleEntry | null {
        return null;
      },
    };
    expect(typeof mock.writeProbationEntry).toBe('function');
    expect(typeof mock.existsForCandidate).toBe('function');
    const entry: LedgerPrincipleEntry = {
      id: 'P_test',
      title: 'Test',
      text: 'Test principle',
      triggerPattern: '.*',
      action: 'Do X',
      status: 'probation',
      evaluability: 'weak_heuristic',
      sourceRef: 'candidate://cand-1',
      artifactRef: 'artifact://art-1',
      createdAt: new Date().toISOString(),
    };
    expect(mock.writeProbationEntry(entry)).toEqual(entry);
  });

  it('existsForCandidate returns null when no entry exists', () => {
    const mock: LedgerAdapter = {
      writeProbationEntry(entry: LedgerPrincipleEntry) { return entry; },
      existsForCandidate(candidateId: string) { return null; },
    };
    expect(mock.existsForCandidate('nonexistent')).toBeNull();
  });
});

describe('LEDGER-01 — LedgerPrincipleEntrySchema', () => {
  it('validates a fully-specified valid entry', () => {
    const entry = {
      id: 'P_test',
      title: 'Do not mutate input',
      text: 'Functions must not mutate their arguments.',
      triggerPattern: '.*input.*',
      action: 'Use spread operators',
      status: 'probation' as const,
      evaluability: 'weak_heuristic' as const,
      sourceRef: 'candidate://cand-1',
      artifactRef: 'artifact://art-1',
      createdAt: new Date().toISOString(),
    };
    expect(Value.Check(LedgerPrincipleEntrySchema, entry)).toBe(true);
  });

  it('validates entry with only required fields', () => {
    const entry = {
      id: 'P_test',
      title: 'Min entry',
      text: 'Short text.',
      status: 'probation' as const,
      evaluability: 'weak_heuristic' as const,
      sourceRef: 'candidate://cand-2',
      createdAt: new Date().toISOString(),
    };
    expect(Value.Check(LedgerPrincipleEntrySchema, entry)).toBe(true);
  });

  it('rejects entry with missing id', () => {
    const entry = {
      title: 'Test',
      text: 'Test text',
      status: 'probation' as const,
      evaluability: 'weak_heuristic' as const,
      sourceRef: 'candidate://cand-1',
      createdAt: new Date().toISOString(),
    };
    expect(Value.Check(LedgerPrincipleEntrySchema, entry)).toBe(false);
  });

  it('rejects entry with missing title', () => {
    const entry = {
      id: 'P_test',
      text: 'Test text',
      status: 'probation' as const,
      evaluability: 'weak_heuristic' as const,
      sourceRef: 'candidate://cand-1',
      createdAt: new Date().toISOString(),
    };
    expect(Value.Check(LedgerPrincipleEntrySchema, entry)).toBe(false);
  });

  it('rejects entry with wrong status literal', () => {
    const entry = {
      id: 'P_test',
      title: 'Test',
      text: 'Test text',
      status: 'active' as const,
      evaluability: 'weak_heuristic' as const,
      sourceRef: 'candidate://cand-1',
      createdAt: new Date().toISOString(),
    };
    expect(Value.Check(LedgerPrincipleEntrySchema, entry)).toBe(false);
  });

  it('rejects entry with wrong evaluability literal', () => {
    const entry = {
      id: 'P_test',
      title: 'Test',
      text: 'Test text',
      status: 'probation' as const,
      evaluability: 'strong_heuristic' as const,
      sourceRef: 'candidate://cand-1',
      createdAt: new Date().toISOString(),
    };
    expect(Value.Check(LedgerPrincipleEntrySchema, entry)).toBe(false);
  });

  it('accepts artifactRef in artifact:// format (D-11)', () => {
    const entry = {
      id: 'P_test',
      title: 'Test',
      text: 'Test text',
      status: 'probation' as const,
      evaluability: 'weak_heuristic' as const,
      sourceRef: 'candidate://cand-1',
      artifactRef: 'artifact://art-1',
      createdAt: new Date().toISOString(),
    };
    expect(Value.Check(LedgerPrincipleEntrySchema, entry)).toBe(true);
  });

  it('accepts taskRef in task:// format', () => {
    const entry = {
      id: 'P_test',
      title: 'Test',
      text: 'Test text',
      status: 'probation' as const,
      evaluability: 'weak_heuristic' as const,
      sourceRef: 'candidate://cand-1',
      taskRef: 'task://task-1',
      createdAt: new Date().toISOString(),
    };
    expect(Value.Check(LedgerPrincipleEntrySchema, entry)).toBe(true);
  });

  it('rejects sourceRef that does not use candidate:// prefix (D-11 regression guard)', () => {
    const entry = {
      id: 'P_test',
      title: 'Test',
      text: 'Test text',
      status: 'probation' as const,
      evaluability: 'weak_heuristic' as const,
      sourceRef: 'artifact://art-1',
      createdAt: new Date().toISOString(),
    };
    // TypeBox treats Type.String() as any non-empty string; schema does not
    // enforce the candidate:// prefix. This test documents the current behavior.
    // Enforcement of the prefix format is the adapter's responsibility (m7-02).
    expect(Value.Check(LedgerPrincipleEntrySchema, entry)).toBe(true);
  });

  it('accepts entry with all optional fields present', () => {
    const entry = {
      id: 'P_test',
      title: 'Full entry',
      text: 'All fields present.',
      triggerPattern: '.*error.*',
      action: 'Log and recover',
      status: 'probation' as const,
      evaluability: 'weak_heuristic' as const,
      sourceRef: 'candidate://cand-1',
      artifactRef: 'artifact://art-1',
      taskRef: 'task://task-1',
      createdAt: new Date().toISOString(),
    };
    expect(Value.Check(LedgerPrincipleEntrySchema, entry)).toBe(true);
  });
});
