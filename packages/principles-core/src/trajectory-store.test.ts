import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import {
  listCorrectionSamples,
  reviewCorrectionSample,
} from './trajectory-store.js';

describe('trajectory-store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(process.cwd(), 'tmp-test-trajectory-store-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore errors on tmp teardown.
    }
  });

  function setupTestDb(dbPath: string) {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE correction_samples (
        sample_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        bad_assistant_turn_id INTEGER NOT NULL,
        user_correction_turn_id INTEGER NOT NULL,
        recovery_tool_span_json TEXT NOT NULL,
        diff_excerpt TEXT NOT NULL,
        principle_ids_json TEXT NOT NULL,
        quality_score REAL NOT NULL,
        review_status TEXT NOT NULL,
        export_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sample_reviews (
        review_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sample_id TEXT NOT NULL,
        review_status TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (sample_id) REFERENCES correction_samples(sample_id)
      );
    `);

    const now = '2026-06-01T00:00:00.000Z';
    db.prepare(`
      INSERT INTO correction_samples (sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
        recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
        review_status, export_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sample-001',
      'session-001',
      1,
      2,
      '{"tool":"edit"}',
      'diff content',
      '["P0-001"]',
      0.9,
      'pending',
      'redacted',
      now,
      now,
    );

    db.prepare(`
      INSERT INTO correction_samples (sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
        recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
        review_status, export_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sample-002',
      'session-001',
      3,
      4,
      '{"tool":"delete"}',
      'diff content 2',
      '["P1-001"]',
      0.8,
      'approved',
      'raw',
      now,
      now,
    );

    db.prepare(`
      INSERT INTO correction_samples (sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
        recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
        review_status, export_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sample-003',
      'session-002',
      5,
      6,
      '{"tool":"create"}',
      'diff content 3',
      '[]',
      0.7,
      'rejected',
      'redacted',
      now,
      now,
    );

    db.close();
  }

  describe('listCorrectionSamples', () => {
    it('returns empty array when DB does not exist', () => {
      const result = listCorrectionSamples(tmpDir);
      expect(result).toEqual([]);
    });

    it('returns pending samples by default', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      setupTestDb(dbPath);

      const result = listCorrectionSamples(tmpDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.sampleId).toBe('sample-001');
      expect(result[0]?.reviewStatus).toBe('pending');
    });

    it('returns approved samples when filtered', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      setupTestDb(dbPath);

      const result = listCorrectionSamples(tmpDir, 'approved');
      expect(result).toHaveLength(1);
      expect(result[0]?.sampleId).toBe('sample-002');
    });

    it('returns rejected samples when filtered', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      setupTestDb(dbPath);

      const result = listCorrectionSamples(tmpDir, 'rejected');
      expect(result).toHaveLength(1);
      expect(result[0]?.sampleId).toBe('sample-003');
    });

    it('returns samples with all expected fields', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      setupTestDb(dbPath);

      const result = listCorrectionSamples(tmpDir);
      const [sample] = result;

      expect(sample?.sampleId).toBe('sample-001');
      expect(sample?.sessionId).toBe('session-001');
      expect(sample?.badAssistantTurnId).toBe(1);
      expect(sample?.userCorrectionTurnId).toBe(2);
      expect(sample?.recoveryToolSpanJson).toBe('{"tool":"edit"}');
      expect(sample?.diffExcerpt).toBe('diff content');
      expect(sample?.principleIdsJson).toBe('["P0-001"]');
      expect(sample?.qualityScore).toBe(0.9);
      expect(sample?.reviewStatus).toBe('pending');
      expect(sample?.exportMode).toBe('redacted');
      expect(typeof sample?.createdAt).toBe('string');
      expect(typeof sample?.updatedAt).toBe('string');
    });

    it('returns empty array on database error', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      const db = new Database(dbPath);
      db.close();

      const result = listCorrectionSamples(tmpDir);
      expect(result).toEqual([]);
    });

    it('orders by created_at DESC', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      setupTestDb(dbPath);

      const db = new Database(dbPath);
      db.prepare(`
        INSERT INTO correction_samples (sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
          recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
          review_status, export_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'sample-004',
        'session-001',
        7,
        8,
        '{"tool":"move"}',
        'diff content 4',
        '["P0-002"]',
        0.95,
        'pending',
        'redacted',
        '2026-06-02T00:00:00.000Z',
        '2026-06-02T00:00:00.000Z',
      );
      db.close();

      const result = listCorrectionSamples(tmpDir);
      expect(result).toHaveLength(2);
      expect(result[0]?.sampleId).toBe('sample-004');
      expect(result[1]?.sampleId).toBe('sample-001');
    });

    it('handles NULL optional fields gracefully', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE correction_samples (
          sample_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          bad_assistant_turn_id INTEGER NOT NULL,
          user_correction_turn_id INTEGER NOT NULL,
          recovery_tool_span_json TEXT,
          diff_excerpt TEXT,
          principle_ids_json TEXT,
          quality_score REAL NOT NULL,
          review_status TEXT NOT NULL,
          export_mode TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      const now = '2026-06-01T00:00:00.000Z';
      db.prepare(`
        INSERT INTO correction_samples (sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
          recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
          review_status, export_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'sample-null',
        'session-001',
        1,
        2,
        null,
        null,
        null,
        0.5,
        'pending',
        'redacted',
        now,
        now,
      );
      db.close();

      const result = listCorrectionSamples(tmpDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.recoveryToolSpanJson).toBe('');
      expect(result[0]?.diffExcerpt).toBe('');
      expect(result[0]?.principleIdsJson).toBe('[]');
    });
  });

  describe('reviewCorrectionSample', () => {
    it('approves a pending sample', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      setupTestDb(dbPath);

      const result = reviewCorrectionSample('sample-001', 'approved', 'Looks good', tmpDir);

      expect(result.sampleId).toBe('sample-001');
      expect(result.reviewStatus).toBe('approved');

      const db = new Database(dbPath);
      const row = db.prepare('SELECT review_status FROM correction_samples WHERE sample_id = ?').get('sample-001') as { review_status: string } | undefined;
      expect(row?.review_status).toBe('approved');

      const reviewRow = db.prepare('SELECT * FROM sample_reviews WHERE sample_id = ?').get('sample-001') as { review_status: string; note: string | null } | undefined;
      expect(reviewRow?.review_status).toBe('approved');
      expect(reviewRow?.note).toBe('Looks good');
      db.close();
    });

    it('rejects a pending sample', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      setupTestDb(dbPath);

      const result = reviewCorrectionSample('sample-001', 'rejected', 'Not applicable', tmpDir);

      expect(result.sampleId).toBe('sample-001');
      expect(result.reviewStatus).toBe('rejected');

      const db = new Database(dbPath);
      const row = db.prepare('SELECT review_status FROM correction_samples WHERE sample_id = ?').get('sample-001') as { review_status: string } | undefined;
      expect(row?.review_status).toBe('rejected');
      db.close();
    });

    it('throws error when sample not found', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      setupTestDb(dbPath);

      expect(() => reviewCorrectionSample('sample-unknown', 'approved', 'Note', tmpDir)).toThrow('Sample not found: sample-unknown');
    });

    it('throws error when DB does not exist', () => {
      expect(() => reviewCorrectionSample('sample-001', 'approved', 'Note', tmpDir)).toThrow(/Database not found/);
    });

    it('updates updated_at timestamp', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      setupTestDb(dbPath);

      const db = new Database(dbPath);
      const before = db.prepare('SELECT updated_at FROM correction_samples WHERE sample_id = ?').get('sample-001') as { updated_at: string } | undefined;
      db.close();

      const result = reviewCorrectionSample('sample-001', 'approved', '', tmpDir);

      const db2 = new Database(dbPath);
      const after = db2.prepare('SELECT updated_at FROM correction_samples WHERE sample_id = ?').get('sample-001') as { updated_at: string } | undefined;
      db2.close();

      expect(result.updatedAt).toBe(after?.updated_at);
      expect(after?.updated_at).not.toBe(before?.updated_at);
    });

    it('handles undefined note', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      setupTestDb(dbPath);

      const result = reviewCorrectionSample('sample-001', 'approved', undefined, tmpDir);

      expect(result.reviewStatus).toBe('approved');

      const db = new Database(dbPath);
      const reviewRow = db.prepare('SELECT note FROM sample_reviews WHERE sample_id = ?').get('sample-001') as { note: string | null } | undefined;
      expect(reviewRow?.note).toBe(null);
      db.close();
    });

    it('handles empty note', () => {
      const dbPath = join(tmpDir, '.state', '.trajectory.db');
      mkdirSync(join(tmpDir, '.state'), { recursive: true });
      setupTestDb(dbPath);

      const result = reviewCorrectionSample('sample-001', 'approved', '', tmpDir);

      expect(result.reviewStatus).toBe('approved');

      const db = new Database(dbPath);
      const reviewRow = db.prepare('SELECT note FROM sample_reviews WHERE sample_id = ?').get('sample-001') as { note: string | null } | undefined;
      expect(reviewRow?.note).toBe('');
      db.close();
    });
  });
});