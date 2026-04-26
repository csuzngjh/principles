import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CandidateIntakeInputSchema,
  CandidateIntakeOutputSchema,
  CandidateIntakeError,
  INTAKE_ERROR_CODES,
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
