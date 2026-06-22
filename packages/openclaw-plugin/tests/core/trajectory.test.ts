import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

describe('TrajectoryDatabase', () => {
  let workspaceDir: string | null = null;

  afterEach(() => {
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
  });

  it('bootstraps trajectory.db and blob/export directories', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    expect(fs.existsSync(path.join(workspaceDir, '.state', 'trajectory.db'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, '.state', 'blobs'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, '.state', 'exports'))).toBe(true);

    const stats = db.getDataStats();
    expect(stats.assistantTurns).toBe(0);
    expect(stats.userTurns).toBe(0);
    expect(stats.pendingSamples).toBe(0);
    db.dispose();
  });

  it('stores oversized assistant raw text in blob storage and preserves sanitized text inline', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir, blobInlineThresholdBytes: 128 });

    const raw = `${'A'.repeat(256)}\n<empathy signal="damage" severity="mild"/>`;
    db.recordAssistantTurn({
      sessionId: 's1',
      runId: 'run-1',
      provider: 'test',
      model: 'model',
      rawText: raw,
      sanitizedText: 'clean text',
      usageJson: { input: 10, output: 20 },
      empathySignalJson: { detected: true, severity: 'mild' },
    });

    const turns = db.listAssistantTurns('s1');
    expect(turns).toHaveLength(1);
    expect(turns[0].sanitizedText).toBe('clean text');
    expect(turns[0].rawText).toBe(raw);
    expect(turns[0].blobRef).toBeTruthy();
    db.dispose();
  });

  it('creates a pending correction sample after a user correction followed by successful recovery', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    const assistantTurnId = db.recordAssistantTurn({
      sessionId: 's1',
      runId: 'run-1',
      provider: 'test',
      model: 'model',
      rawText: 'I changed the wrong file.',
      sanitizedText: 'I changed the wrong file.',
      usageJson: {},
      empathySignalJson: { detected: false },
    });

    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'failure',
      errorType: 'EACCES',
      errorMessage: 'permission denied',
    });

    db.recordUserTurn({
      sessionId: 's1',
      turnIndex: 1,
      rawText: '你错了，不是这个文件，重新来。',
      correctionDetected: true,
      correctionCue: '你错了',
      referencesAssistantTurnId: assistantTurnId,
    });

    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'success',
    });

    const samples = db.listCorrectionSamples('pending');
    expect(samples).toHaveLength(1);
    expect(samples[0].sessionId).toBe('s1');
    expect(samples[0].badAssistantTurnId).toBe(assistantTurnId);
    expect(samples[0].reviewStatus).toBe('pending');
    expect(samples[0].qualityScore).toBeGreaterThan(0);
    db.dispose();
  });

  it('does not create a correction sample when prerequisites are missing', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'failure',
      errorType: 'EACCES',
    });
    db.recordUserTurn({
      sessionId: 's1',
      turnIndex: 1,
      rawText: 'redo',
      correctionDetected: false,
      referencesAssistantTurnId: null,
    });
    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'success',
    });

    expect(db.listCorrectionSamples('pending')).toHaveLength(0);
    db.dispose();
  });

  it('raises when reviewing a missing correction sample', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    expect(() => db.reviewCorrectionSample('missing', 'approved')).toThrow('Correction sample not found');
    db.dispose();
  });

  it('aggregates daily metrics without multiplying user corrections', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'failure',
      createdAt: '2026-03-19T10:00:00.000Z',
    });
    db.recordToolCall({
      sessionId: 's1',
      toolName: 'write',
      outcome: 'success',
      createdAt: '2026-03-19T11:00:00.000Z',
    });
    db.recordUserTurn({
      sessionId: 's1',
      turnIndex: 1,
      rawText: 'redo',
      correctionDetected: true,
      correctionCue: 'redo',
      createdAt: '2026-03-19T12:00:00.000Z',
    });
    db.recordUserTurn({
      sessionId: 's1',
      turnIndex: 2,
      rawText: 'again',
      correctionDetected: true,
      correctionCue: 'again',
      createdAt: '2026-03-19T13:00:00.000Z',
    });

    const result = db.exportAnalytics();
    const payload = JSON.parse(fs.readFileSync(result.filePath, 'utf8')) as {
      dailyMetrics: Array<{ day: string; tool_calls: number; failures: number; user_corrections: number }>;
    };
    expect(payload.dailyMetrics).toEqual([
      { day: '2026-03-19', tool_calls: 2, failures: 1, user_corrections: 2 },
    ]);
    db.dispose();
  });

  it('applies busy_timeout and prunes orphaned blobs on startup', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const blobDir = path.join(workspaceDir, '.state', 'blobs');
    fs.mkdirSync(blobDir, { recursive: true });
    const orphanBlob = path.join(blobDir, 'assistant-orphan.txt');
    fs.writeFileSync(orphanBlob, 'stale blob', 'utf8');
    const oldTime = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(orphanBlob, oldTime, oldTime);

    const db = new TrajectoryDatabase({
      workspaceDir,
      busyTimeoutMs: 2500,
      orphanBlobGraceDays: 0,
    });

    expect((db as any).db.pragma('busy_timeout', { simple: true })).toBe(2500);
    expect(fs.existsSync(orphanBlob)).toBe(false);
    db.dispose();
  });

  it('imports legacy sessions, events, and evolution artifacts idempotently', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const sessionDir = path.join(workspaceDir, '.state', 'sessions');
    const logsDir = path.join(workspaceDir, '.state', 'logs');
    const memoryDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(memoryDir, { recursive: true });

    fs.writeFileSync(
      path.join(sessionDir, 'session-a.json'),
      JSON.stringify({ sessionId: 'legacy-session', lastActivityAt: Date.parse('2026-03-18T10:00:00.000Z') }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(logsDir, 'events.jsonl'),
      [
        JSON.stringify({
          type: 'pain_signal',
          sessionId: 'legacy-session',
          ts: '2026-03-18T10:01:00.000Z',
          data: { source: 'legacy_pain', score: 12, reason: 'legacy reason' },
        }),
        JSON.stringify({
          type: 'trust_change',
          sessionId: 'legacy-session',
          ts: '2026-03-18T10:02:00.000Z',
          data: { previousScore: 80, newScore: 82, delta: 2, reason: 'legacy trust' },
        }),
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(memoryDir, 'evolution.jsonl'),
      `${JSON.stringify({
        type: 'principle_promoted',
        ts: '2026-03-18T10:03:00.000Z',
        data: { principleId: 'p-1', summary: 'legacy principle' },
      })}\n`,
      'utf8',
    );

    const db = new TrajectoryDatabase({ workspaceDir });
    const firstStats = db.getDataStats();
    expect(firstStats.painEvents).toBe(1);
    expect(firstStats.assistantTurns).toBe(0);

    const analytics = JSON.parse(fs.readFileSync(db.exportAnalytics().filePath, 'utf8')) as {
      stats: { painEvents: number };
      principleEffectiveness: Array<{ event_type: string; total: number }>;
    };
    expect(analytics.stats.painEvents).toBe(1);
    expect(analytics.principleEffectiveness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'principle_promoted', total: 1 }),
      ]),
    );
    db.dispose();

    const reopened = new TrajectoryDatabase({ workspaceDir });
    const secondStats = reopened.getDataStats();
    expect(secondStats.painEvents).toBe(1);
    reopened.dispose();
  });

  describe('recordPainEvent with canonical_pain_id (PRI-406)', () => {
    it('inserts pain event without canonical_pain_id successfully', () => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
      const db = new TrajectoryDatabase({ workspaceDir });

      const id = db.recordPainEvent({
        sessionId: 's1',
        source: 'test',
        score: 50,
        reason: 'test reason',
        origin: 'test',
      });

      expect(id).toBeGreaterThan(0);
      db.dispose();
    });

    it('inserts pain event with canonical_pain_id successfully', () => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
      const db = new TrajectoryDatabase({ workspaceDir });

      const id = db.recordPainEvent({
        sessionId: 's1',
        source: 'test',
        score: 50,
        reason: 'test reason',
        origin: 'test',
        canonicalPainId: 'pain-canonical-001',
      });

      expect(id).toBeGreaterThan(0);
      db.dispose();
    });

    it('handles UNIQUE constraint violation on canonical_pain_id by updating instead of throwing', () => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
      const db = new TrajectoryDatabase({ workspaceDir });

      const canonicalId = 'pain-canonical-duplicate';

      const id1 = db.recordPainEvent({
        sessionId: 's1',
        source: 'test',
        score: 50,
        reason: 'first',
        origin: 'test',
        canonicalPainId: canonicalId,
      });
      expect(id1).toBeGreaterThan(0);

      const id2 = db.recordPainEvent({
        sessionId: 's1',
        source: 'test',
        score: 60,
        reason: 'second',
        origin: 'test',
        canonicalPainId: canonicalId,
      });

      expect(id2).toBe(id1);

      db.dispose();
    });

    it('updates runtime_task_id when canonical_pain_id conflict occurs', () => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
      const db = new TrajectoryDatabase({ workspaceDir });

      const canonicalId = 'pain-canonical-update-rtid';

      db.recordPainEvent({
        sessionId: 's1',
        source: 'test',
        score: 50,
        reason: 'no runtime task',
        origin: 'test',
        canonicalPainId: canonicalId,
      });

      db.recordPainEvent({
        sessionId: 's1',
        source: 'test',
        score: 60,
        reason: 'with runtime task',
        origin: 'test',
        canonicalPainId: canonicalId,
        runtimeTaskId: 'task-123',
      });

      const queryResult = (db as any).db.prepare(
        'SELECT runtime_task_id FROM pain_events WHERE canonical_pain_id = ?'
      ).get(canonicalId);

      expect(queryResult.runtime_task_id).toBe('task-123');

      db.dispose();
    });

    it('does not overwrite existing runtime_task_id when new one is null', () => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
      const db = new TrajectoryDatabase({ workspaceDir });

      const canonicalId = 'pain-canonical-coalesce';

      db.recordPainEvent({
        sessionId: 's1',
        source: 'test',
        score: 50,
        reason: 'with runtime task',
        origin: 'test',
        canonicalPainId: canonicalId,
        runtimeTaskId: 'original-task',
      });

      db.recordPainEvent({
        sessionId: 's1',
        source: 'test',
        score: 60,
        reason: 'without runtime task',
        origin: 'test',
        canonicalPainId: canonicalId,
      });

      const queryResult = (db as any).db.prepare(
        'SELECT runtime_task_id FROM pain_events WHERE canonical_pain_id = ?'
      ).get(canonicalId);

      expect(queryResult.runtime_task_id).toBe('original-task');

      db.dispose();
    });

    it('throws for non-canonical_pain_id UNIQUE constraint violations', () => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
      const db = new TrajectoryDatabase({ workspaceDir });

      // Temporary unique index to simulate a non-canonical_pain_id conflict.
      // Each test uses a fresh temp DB, so cleanup is not needed.
      (db as any).db.exec('CREATE UNIQUE INDEX test_unique_source ON pain_events(source)');

      db.recordPainEvent({
        sessionId: 's1',
        source: 'unique-source',
        score: 50,
        reason: 'first',
        origin: 'test',
      });

      expect(() => {
        db.recordPainEvent({
          sessionId: 's1',
          source: 'unique-source',
          score: 60,
          reason: 'second',
          origin: 'test',
        });
      }).toThrow();

      db.dispose();
    });
  });

  describe('trajectory v2 enhancement fields', () => {
    it('persists and reads stopReason and thinkingBlocksCount for assistant turns', () => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
      const db = new TrajectoryDatabase({ workspaceDir });

      db.recordAssistantTurn({
        sessionId: 's1',
        runId: 'run-1',
        provider: 'test',
        model: 'model',
        rawText: 'test output',
        sanitizedText: 'test output',
        usageJson: {},
        empathySignalJson: {},
        stopReason: 'length',
        thinkingBlocksCount: 3,
      });

      const turns = db.listAssistantTurns('s1');
      expect(turns).toHaveLength(1);
      expect(turns[0].stopReason).toBe('length');
      expect(turns[0].thinkingBlocksCount).toBe(3);
      db.dispose();
    });

    it('persists null enhanced fields when not provided', () => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
      const db = new TrajectoryDatabase({ workspaceDir });

      db.recordAssistantTurn({
        sessionId: 's1',
        runId: 'run-1',
        provider: 'test',
        model: 'model',
        rawText: 'test',
        sanitizedText: 'test',
        usageJson: {},
        empathySignalJson: {},
      });

      const turns = db.listAssistantTurns('s1');
      expect(turns).toHaveLength(1);
      expect(turns[0].stopReason).toBeNull();
      expect(turns[0].thinkingBlocksCount).toBeNull();
      db.dispose();
    });

    it('persists and reads resultPreview for tool calls', () => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
      const db = new TrajectoryDatabase({ workspaceDir });

      db.recordToolCall({
        sessionId: 's1',
        toolName: 'bash',
        outcome: 'failure',
        errorType: 'ENOENT',
        exitCode: 1,
        resultPreview: 'Error: no such file or directory',
      });

      const calls = db.listToolCallsForSession('s1');
      expect(calls).toHaveLength(1);
      expect(calls[0].resultPreview).toBe('Error: no such file or directory');
      db.dispose();
    });

    it('persists null resultPreview when not provided', () => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
      const db = new TrajectoryDatabase({ workspaceDir });

      db.recordToolCall({
        sessionId: 's1',
        toolName: 'bash',
        outcome: 'success',
      });

      const calls = db.listToolCallsForSession('s1');
      expect(calls).toHaveLength(1);
      expect(calls[0].resultPreview).toBeNull();
      db.dispose();
    });

    it('migrates existing database by adding enhancement columns via ALTER TABLE', () => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));

      // Create a DB without the new columns (simulate old schema)
      const Database = require('better-sqlite3');
      const stateDir = path.join(workspaceDir, '.state');
      fs.mkdirSync(stateDir, { recursive: true });
      const blobsDir = path.join(stateDir, 'blobs');
      const exportsDir = path.join(stateDir, 'exports');
      fs.mkdirSync(blobsDir, { recursive: true });
      fs.mkdirSync(exportsDir, { recursive: true });
      const dbPath = path.join(stateDir, 'trajectory.db');
      const rawDb = new Database(dbPath);
      // Create minimal tables WITHOUT the new columns
      rawDb.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (1);
        CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE assistant_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, raw_text TEXT, sanitized_text TEXT NOT NULL, usage_json TEXT NOT NULL, empathy_signal_json TEXT NOT NULL, blob_ref TEXT, raw_excerpt TEXT, created_at TEXT NOT NULL);
        CREATE TABLE user_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, raw_text TEXT, blob_ref TEXT, raw_excerpt TEXT, correction_detected INTEGER NOT NULL DEFAULT 0, correction_cue TEXT, references_assistant_turn_id INTEGER, created_at TEXT NOT NULL);
        CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, created_at TEXT NOT NULL);
        CREATE TABLE gate_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, tool_name TEXT NOT NULL, file_path TEXT, reason TEXT NOT NULL, plan_status TEXT, created_at TEXT NOT NULL);
        CREATE TABLE trust_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, previous_score REAL NOT NULL, new_score REAL NOT NULL, delta REAL NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE principle_events (id INTEGER PRIMARY KEY AUTOINCREMENT, principle_id TEXT, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE task_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, task_id TEXT, outcome TEXT NOT NULL, summary TEXT, principle_ids_json TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE correction_samples (sample_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, bad_assistant_turn_id INTEGER NOT NULL, user_correction_turn_id INTEGER NOT NULL, recovery_tool_span_json TEXT NOT NULL, diff_excerpt TEXT NOT NULL, principle_ids_json TEXT NOT NULL, quality_score REAL NOT NULL, review_status TEXT NOT NULL, export_mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE sample_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id TEXT NOT NULL, review_status TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
        CREATE TABLE exports_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, export_kind TEXT NOT NULL, mode TEXT NOT NULL, approved_only INTEGER NOT NULL, file_path TEXT NOT NULL, row_count INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE evolution_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT UNIQUE NOT NULL, trace_id TEXT NOT NULL, source TEXT NOT NULL, reason TEXT, score INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', enqueued_at TEXT, started_at TEXT, completed_at TEXT, resolution TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE evolution_events (id INTEGER PRIMARY KEY AUTOINCREMENT, trace_id TEXT NOT NULL, task_id TEXT, stage TEXT NOT NULL, level TEXT DEFAULT 'info', message TEXT NOT NULL, summary TEXT, metadata_json TEXT, created_at TEXT NOT NULL);
        CREATE TABLE ingest_checkpoint (source_key TEXT PRIMARY KEY, imported_at TEXT NOT NULL);
      `);
      rawDb.close();

      // Now open with TrajectoryDatabase — should migrate and add columns
      const db = new TrajectoryDatabase({ workspaceDir });

      db.recordAssistantTurn({
        sessionId: 's1',
        runId: 'run-1',
        provider: 'test',
        model: 'model',
        rawText: 'migrated test',
        sanitizedText: 'migrated test',
        usageJson: {},
        empathySignalJson: {},
        stopReason: 'end_turn',
        thinkingBlocksCount: 2,
      });

      db.recordToolCall({
        sessionId: 's1',
        toolName: 'bash',
        outcome: 'failure',
        exitCode: 1,
        resultPreview: 'migrated preview',
      });

      const turns = db.listAssistantTurns('s1');
      expect(turns[0].stopReason).toBe('end_turn');
      expect(turns[0].thinkingBlocksCount).toBe(2);

      const calls = db.listToolCallsForSession('s1');
      expect(calls[0].resultPreview).toBe('migrated preview');
      db.dispose();
    });
  });
});
