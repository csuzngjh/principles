/**
 * Schema Float Precision Regression Test (PRI-476 / M5)
 *
 * Prevents recurrence of P0-1: pain_events.score was declared INTEGER, which
 * truncated floating-point pain scores (e.g., 39.9 → 39) and caused severity
 * misclassification (39.9 should be 'moderate' ≥40, but 39 is 'mild').
 *
 * This test writes floating-point values into all REAL columns that carry
 * semantic meaning (score, confidence) and asserts the read-back value
 * preserves precision. If a schema change accidentally reverts REAL to
 * INTEGER, the test fails.
 *
 * Scope (per PRI-476 acceptance criteria):
 *   - pain_events.score (trajectory.db) — the P0-1 field
 *   - approvals.confidence (state.db)
 *
 * Note: pain_events.confidence is hardcoded to 1 (integer) in the writer
 * (pain-signal-observability.ts), so float-precision testing is not applicable.
 * pi_artifacts has no REAL columns carrying semantic meaning, so it is excluded.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it, afterEach } from 'vitest';
import { recordPainSignalObservability } from '../pain-signal-observability.js';
import { SqliteConnection } from '../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../store/artifact/sqlite-pi-artifact-store.js';
import { SqliteApprovalQueueStore } from '../activation/sqlite-approval-store.js';
import type { PIArtifactRecord } from '../internalization/pi-artifact.js';

const tempDirs: string[] = [];

function makeWorkspace(): { workspaceDir: string; stateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'pd-float-precision-'));
  tempDirs.push(workspaceDir);
  return { workspaceDir, stateDir: join(workspaceDir, '.state') };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Schema float precision regression (PRI-476 / M5)', () => {
  describe('pain_events.score preserves floating-point precision (P0-1 guard)', () => {
    it('writes score=75.5 and reads back 75.5 (not 75)', () => {
      const { workspaceDir, stateDir } = makeWorkspace();
      recordPainSignalObservability({
        workspaceDir,
        stateDir,
        canonicalPainId: 'canonical-float-001',
        data: {
          painId: 'float-test-001',
          taskId: 'task-float-001',
          painType: 'user_frustration',
          source: 'manual',
          reason: 'float precision test',
          score: 75.5,
          sessionId: 'cli',
          agentId: 'pd-cli',
        },
      });

      const db = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
      try {
        const row = db.prepare('SELECT score FROM pain_events WHERE canonical_pain_id = ?')
          .get('canonical-float-001') as { score: number } | undefined;
        // If score were INTEGER, 75.5 would be truncated to 75.
        expect(row).toBeDefined();
        expect(row?.score).toBe(75.5);
      } finally {
        db.close();
      }
    });

    it('writes score=39.9 and reads back 39.9 (not 39)', () => {
      // P0-1 core case: INTEGER truncation would turn 39.9 into 39.
      // This test guards the float precision of pain scores.
      const { workspaceDir, stateDir } = makeWorkspace();
      recordPainSignalObservability({
        workspaceDir,
        stateDir,
        canonicalPainId: 'canonical-float-002',
        data: {
          painId: 'float-test-002',
          taskId: 'task-float-002',
          painType: 'user_frustration',
          source: 'manual',
          reason: 'float precision test',
          score: 39.9,
          sessionId: 'cli',
          agentId: 'pd-cli',
        },
      });

      const db = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
      try {
        const row = db.prepare('SELECT score FROM pain_events WHERE canonical_pain_id = ?')
          .get('canonical-float-002') as { score: number } | undefined;
        expect(row).toBeDefined();
        expect(row?.score).toBe(39.9);
      } finally {
        db.close();
      }
    });

    it('writes score=40.0 (moderate boundary) and reads back 40.0', () => {
      const { workspaceDir, stateDir } = makeWorkspace();
      recordPainSignalObservability({
        workspaceDir,
        stateDir,
        canonicalPainId: 'canonical-float-003',
        data: {
          painId: 'float-test-003',
          taskId: 'task-float-003',
          painType: 'user_frustration',
          source: 'manual',
          reason: 'moderate boundary test',
          score: 40.0,
          sessionId: 'cli',
          agentId: 'pd-cli',
        },
      });

      const db = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
      try {
        const row = db.prepare('SELECT score, severity FROM pain_events WHERE canonical_pain_id = ?')
          .get('canonical-float-003') as { score: number; severity: string } | undefined;
        expect(row).toBeDefined();
        expect(row?.score).toBe(40.0);
        expect(row?.severity).toBe('moderate');
      } finally {
        db.close();
      }
    });

    it('writes score=0.333 (high precision) and reads back with ≤5 decimal precision', () => {
      const { workspaceDir, stateDir } = makeWorkspace();
      recordPainSignalObservability({
        workspaceDir,
        stateDir,
        canonicalPainId: 'canonical-float-004',
        data: {
          painId: 'float-test-004',
          taskId: 'task-float-004',
          painType: 'user_frustration',
          source: 'manual',
          reason: 'high precision test',
          score: 0.333,
          sessionId: 'cli',
          agentId: 'pd-cli',
        },
      });

      const db = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
      try {
        const row = db.prepare('SELECT score FROM pain_events WHERE canonical_pain_id = ?')
          .get('canonical-float-004') as { score: number } | undefined;
        expect(row).toBeDefined();
        // SQLite REAL is IEEE 754 double; 0.333 should be preserved.
        expect(row?.score).toBeCloseTo(0.333, 5);
      } finally {
        db.close();
      }
    });
  });

  describe('approvals.confidence preserves floating-point precision', () => {
    it('writes confidence=0.85 and reads back 0.85', () => {
      const { workspaceDir } = makeWorkspace();
      const conn = new SqliteConnection({ workspaceDir });

      try {
        const db = conn.getDb();

        // Seed parent task for FK validation
        db.prepare(
          "INSERT OR IGNORE INTO tasks (task_id, task_kind, status, created_at, updated_at)" +
          " VALUES (?, 'diagnosis', 'pending', ?, ?)",
        ).run('task-conf-001', new Date().toISOString(), new Date().toISOString());

        // Seed parent pi_artifact for FK validation
        const artifactStore = new SqlitePIArtifactStore(conn);
        const now = new Date().toISOString();
        const artifact: PIArtifactRecord = {
          artifactId: 'art-conf-001',
          artifactKind: 'principle',
          sourceTaskId: 'task-conf-001',
          lineageArtifactIds: [],
          validationStatus: 'pending',
          contentJson: '{}',
          createdAt: now,
          updatedAt: now,
        };
        artifactStore.createArtifact(artifact);

        // Enqueue approval with float confidence
        const approvalStore = new SqliteApprovalQueueStore(conn);
        approvalStore.enqueue({
          artifactId: 'art-conf-001',
          channel: 'prompt',
          riskLevel: 'low',
          confidence: 0.85,
          summary: 'confidence precision test',
          triggerReason: 'test',
        }, now);

        // Read back and verify precision
        const row = db.prepare('SELECT confidence FROM approvals WHERE artifact_id = ?')
          .get('art-conf-001') as { confidence: number } | undefined;
        expect(row).toBeDefined();
        expect(row?.confidence).toBe(0.85);
      } finally {
        conn.close();
      }
    });

    it('writes confidence=0.333 and reads back 0.333', () => {
      const { workspaceDir } = makeWorkspace();
      const conn = new SqliteConnection({ workspaceDir });

      try {
        const db = conn.getDb();
        db.prepare(
          "INSERT OR IGNORE INTO tasks (task_id, task_kind, status, created_at, updated_at)" +
          " VALUES (?, 'diagnosis', 'pending', ?, ?)",
        ).run('task-conf-002', new Date().toISOString(), new Date().toISOString());

        const artifactStore = new SqlitePIArtifactStore(conn);
        const now = new Date().toISOString();
        artifactStore.createArtifact({
          artifactId: 'art-conf-002',
          artifactKind: 'principle',
          sourceTaskId: 'task-conf-002',
          lineageArtifactIds: [],
          validationStatus: 'pending',
          contentJson: '{}',
          createdAt: now,
          updatedAt: now,
        });

        const approvalStore = new SqliteApprovalQueueStore(conn);
        approvalStore.enqueue({
          artifactId: 'art-conf-002',
          channel: 'prompt',
          riskLevel: 'low',
          confidence: 0.333,
          summary: 'high precision confidence test',
          triggerReason: 'test',
        }, now);

        const row = db.prepare('SELECT confidence FROM approvals WHERE artifact_id = ?')
          .get('art-conf-002') as { confidence: number } | undefined;
        expect(row).toBeDefined();
        expect(row?.confidence).toBeCloseTo(0.333, 5);
      } finally {
        conn.close();
      }
    });
  });

  describe('schema column types are REAL (not INTEGER)', () => {
    it('pain_events.score column type is REAL', () => {
      const { workspaceDir, stateDir } = makeWorkspace();
      // Trigger schema creation by recording a pain signal
      recordPainSignalObservability({
        workspaceDir,
        stateDir,
        canonicalPainId: 'canonical-schema-check-001',
        data: {
          painId: 'schema-check-001',
          taskId: 'task-schema-001',
          painType: 'user_frustration',
          source: 'manual',
          reason: 'schema type check',
          score: 50,
          sessionId: 'cli',
          agentId: 'pd-cli',
        },
      });

      const db = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
      try {
        const cols = db.prepare('PRAGMA table_info(pain_events)').all() as { name: string; type: string }[];
        const scoreCol = cols.find((c) => c.name === 'score');
        expect(scoreCol).toBeDefined();
        // SQLite type affinity: REAL type name gives REAL affinity.
        // If someone changes this to INTEGER, the test fails.
        expect(scoreCol?.type?.toUpperCase()).toBe('REAL');
      } finally {
        db.close();
      }
    });

    it('approvals.confidence column type is REAL', () => {
      const { workspaceDir } = makeWorkspace();
      const conn = new SqliteConnection({ workspaceDir });

      try {
        const db = conn.getDb();
        const cols = db.prepare('PRAGMA table_info(approvals)').all() as { name: string; type: string }[];
        const confidenceCol = cols.find((c) => c.name === 'confidence');
        expect(confidenceCol).toBeDefined();
        expect(confidenceCol?.type?.toUpperCase()).toBe('REAL');
      } finally {
        conn.close();
      }
    });
  });
});
