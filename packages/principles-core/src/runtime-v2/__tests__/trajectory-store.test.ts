import { describe, it, expect, vi } from 'vitest';
import { listCorrectionSamples, reviewCorrectionSample } from '../../trajectory-store.js';

// Mock the better-sqlite3 module
vi.mock('better-sqlite3', () => {
  return {
    default: class {
      constructor() {
        throw new Error('SQLITE_CANTOPEN: unable to open database file');
      }
    }
  };
});

describe('trajectory-store', () => {
  describe('listCorrectionSamples', () => {
    it('returns an empty array when db does not exist (fallback)', () => {
      // With better-sqlite3 mocked to throw, this should hit the catch block and return []
      const result = listCorrectionSamples('/fake/workspace');
      expect(result).toEqual([]);
    });

    it('returns an empty array when db does not exist (fallback) with status passed', () => {
      // With better-sqlite3 mocked to throw, this should hit the catch block and return []
      const result = listCorrectionSamples('/fake/workspace', 'approved');
      expect(result).toEqual([]);
    });
  });

  describe('reviewCorrectionSample', () => {
    it('throws a database open error when db does not exist', () => {
      // With better-sqlite3 mocked to throw, this should hit the newly added catch block
      expect(() => {
        reviewCorrectionSample('sample-id-123', 'approved', 'Looks good', '/fake/workspace');
      }).toThrow(/Database not found or cannot be opened/);
    });
  });
});
