import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listCorrectionSamples, reviewCorrectionSample } from '../../trajectory-store.js';

const mockPrepare = vi.fn();
const mockClose = vi.fn();
let shouldThrowOnOpen = false;

vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn(function (this: Record<string, unknown>) {
      if (shouldThrowOnOpen) {
        throw new Error('SQLITE_CANTOPEN: unable to open database file');
      }
      this.prepare = mockPrepare;
      this.close = mockClose;
    }),
  };
});

describe('listCorrectionSamples', () => {
  beforeEach(() => {
    shouldThrowOnOpen = false;
    mockPrepare.mockReset();
    mockClose.mockReset();
  });

  it('returns empty array when DB cannot be opened', () => {
    shouldThrowOnOpen = true;
    const result = listCorrectionSamples('/fake/workspace');
    expect(result).toEqual([]);
  });

  it('returns empty array when DB cannot be opened with custom status', () => {
    shouldThrowOnOpen = true;
    const result = listCorrectionSamples('/fake/workspace', 'approved');
    expect(result).toEqual([]);
  });

  it('returns empty array when query throws (e.g. table missing)', () => {
    mockPrepare.mockReturnValue({ all: () => { throw new Error('SQLITE_ERROR: no such table: correction_samples'); } });
    const result = listCorrectionSamples('/fake/workspace');
    expect(result).toEqual([]);
    expect(mockClose).toHaveBeenCalled();
  });

  it('maps rows to CorrectionSampleRecord when query succeeds', () => {
    mockPrepare.mockReturnValue({
      all: () => [{
        sample_id: 's1',
        session_id: 'sess1',
        bad_assistant_turn_id: 1,
        user_correction_turn_id: 2,
        recovery_tool_span_json: '{"tool":"edit"}',
        diff_excerpt: 'old→new',
        principle_ids_json: '["p1"]',
        quality_score: 0.8,
        review_status: 'pending',
        export_mode: 'raw',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    });
    const result = listCorrectionSamples('/fake/workspace');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      sampleId: 's1',
      sessionId: 'sess1',
      badAssistantTurnId: 1,
      userCorrectionTurnId: 2,
      recoveryToolSpanJson: '{"tool":"edit"}',
      diffExcerpt: 'old→new',
      principleIdsJson: '["p1"]',
      qualityScore: 0.8,
      reviewStatus: 'pending',
      exportMode: 'raw',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(mockClose).toHaveBeenCalled();
  });

  it('passes status parameter to query', () => {
    const mockAll = vi.fn().mockReturnValue([]);
    mockPrepare.mockReturnValue({ all: mockAll });
    listCorrectionSamples('/fake/workspace', 'rejected');
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('FROM correction_samples'));
    expect(mockAll).toHaveBeenCalledWith('rejected');
  });

  it('handles null-ish row fields with defaults', () => {
    mockPrepare.mockReturnValue({
      all: () => [{
        sample_id: 's2',
        session_id: 'sess2',
        bad_assistant_turn_id: 3,
        user_correction_turn_id: 4,
        recovery_tool_span_json: null,
        diff_excerpt: null,
        principle_ids_json: null,
        quality_score: 0,
        review_status: 'pending',
        export_mode: 'redacted',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    });
    const [row] = listCorrectionSamples('/fake/workspace');
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.recoveryToolSpanJson).toBe('');
    expect(row.diffExcerpt).toBe('');
    expect(row.principleIdsJson).toBe('[]');
  });
});

describe('reviewCorrectionSample', () => {
  beforeEach(() => {
    shouldThrowOnOpen = false;
    mockPrepare.mockReset();
    mockClose.mockReset();
  });

  it('throws descriptive error when DB cannot be opened', () => {
    shouldThrowOnOpen = true;
    expect(() => {
      reviewCorrectionSample('s1', 'approved', 'note', '/fake/workspace');
    }).toThrow(/Database not found or cannot be opened/);
  });

  it('throws when sample not found (update changes=0)', () => {
    mockPrepare.mockReturnValue({ run: () => ({ changes: 0 }) });
    expect(() => {
      reviewCorrectionSample('missing-id', 'approved', undefined, '/fake/workspace');
    }).toThrow(/Sample not found: missing-id/);
    expect(mockClose).toHaveBeenCalled();
  });
});
