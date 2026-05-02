import { describe, it, expect } from 'vitest';
import { listCorrectionSamples } from '../src/trajectory-store.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { rmSync, mkdirSync } from 'fs';

describe('trajectory-store', () => {
  describe('listCorrectionSamples', () => {
    it('returns an empty array when db does not exist (fallback)', () => {
      // Create a temporary workspace directory without initializing a .trajectory.db
      const tempWorkspace = join(tmpdir(), 'trajectory-store-test-' + randomUUID());
      mkdirSync(tempWorkspace, { recursive: true });

      try {
        // Since .state/.trajectory.db doesn't exist, better-sqlite3 will throw an error.
        // The catch block gracefully catches it and returns [].
        const result = listCorrectionSamples(tempWorkspace);
        expect(result).toEqual([]);
      } finally {
        rmSync(tempWorkspace, { recursive: true, force: true });
      }
    });
  });
});
