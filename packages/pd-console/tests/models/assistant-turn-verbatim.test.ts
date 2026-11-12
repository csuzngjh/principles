/**
 * P1-2: getAssistantTurn returns the referenced assistant turn VERBATIM.
 *
 * The Owner compares the recorded correction with exactly what the agent said,
 * so this test asserts byte-for-byte text preservation (newlines, indentation,
 * markdown markers, HTML-ish characters, Chinese/English mixed) rather than a
 * "looks right" rendering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { EvidenceChainConsoleModel } from '../../src/server/models/EvidenceChainConsoleModel.js';

let tempDir: string;
let workspaceDir: string;
let model: EvidenceChainConsoleModel;

function openTrajectoryDb(): Database.Database {
  const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      raw_text TEXT,
      sanitized_text TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      empathy_signal_json TEXT NOT NULL,
      blob_ref TEXT,
      raw_excerpt TEXT,
      stop_reason TEXT,
      thinking_blocks_count INTEGER,
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

function insertTurn(
  db: Database.Database,
  row: { sessionId: string; rawText: string | null; sanitizedText: string; blobRef?: string | null },
): number {
  const result = db.prepare(`
    INSERT INTO assistant_turns
      (session_id, run_id, provider, model, raw_text, sanitized_text, usage_json, empathy_signal_json, blob_ref, created_at)
    VALUES (?, 'run-1', 'provider', 'model', ?, ?, '{}', '{}', ?, '2026-11-12T08:00:00.000Z')
  `).run(row.sessionId, row.rawText, row.sanitizedText, row.blobRef ?? null);
  return Number(result.lastInsertRowid);
}

const MIXED_TEXT = [
  '## 结论 / Summary',
  '',
  '  保留了  多个空格\t和制表符',
  '`inline code` **bold** <script>alert(1)</script>',
  '第一行中文，second line English，第三行尾巴  ',
  '',
].join('\n');

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-assistant-turn-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  model = new EvidenceChainConsoleModel(workspaceDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('P1-2 getAssistantTurn verbatim contract', () => {
  it('returns inline raw_text byte-for-byte (markdown, whitespace, mixed CJK/English)', async () => {
    const db = openTrajectoryDb();
    const id = insertTurn(db, { sessionId: 'sess-1', rawText: MIXED_TEXT, sanitizedText: 'redacted copy' });
    db.close();

    const result = await model.getAssistantTurn(id, 'sess-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.text).toBe(MIXED_TEXT);
    expect(result.turn.textSource).toBe('raw');
    expect(result.turn.sessionId).toBe('sess-1');
  });

  it('restores raw_text from the overflow blob and confines blob_ref to <state>/blobs', async () => {
    const blobsDir = path.join(workspaceDir, '.state', 'blobs');
    fs.mkdirSync(blobsDir, { recursive: true });
    fs.writeFileSync(path.join(blobsDir, 'assistant-abc.txt'), MIXED_TEXT, 'utf8');

    const db = openTrajectoryDb();
    const id = insertTurn(db, {
      sessionId: 'sess-1',
      rawText: null,
      sanitizedText: 'redacted copy',
      blobRef: 'assistant-abc.txt',
    });
    db.close();

    const result = await model.getAssistantTurn(id, 'sess-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.text).toBe(MIXED_TEXT);
    expect(result.turn.textSource).toBe('raw');
  });

  it('ignores a blob_ref that escapes the blob directory and falls back to sanitized_text', async () => {
    const escapedPath = path.join(workspaceDir, 'outside.txt');
    fs.writeFileSync(escapedPath, MIXED_TEXT, 'utf8');

    const db = openTrajectoryDb();
    const id = insertTurn(db, {
      sessionId: 'sess-1',
      rawText: null,
      sanitizedText: 'sanitized only',
      blobRef: '../outside.txt',
    });
    db.close();

    const result = await model.getAssistantTurn(id, 'sess-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.text).toBe('sanitized only');
    expect(result.turn.textSource).toBe('sanitized');
  });

  it('falls back to sanitized_text when raw text was purged', async () => {
    const db = openTrajectoryDb();
    const id = insertTurn(db, { sessionId: 'sess-1', rawText: null, sanitizedText: 'sanitized only' });
    db.close();

    const result = await model.getAssistantTurn(id, 'sess-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.text).toBe('sanitized only');
    expect(result.turn.textSource).toBe('sanitized');
  });

  it('fails observably when the trajectory database has not been created yet', async () => {
    const result = await model.getAssistantTurn(1, 'sess-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Trajectory database not found');
    expect(result.nextAction.length).toBeGreaterThan(0);
  });

  it('falls back to sanitized_text when the overflow blob is empty', async () => {
    const blobsDir = path.join(workspaceDir, '.state', 'blobs');
    fs.mkdirSync(blobsDir, { recursive: true });
    fs.writeFileSync(path.join(blobsDir, 'empty.txt'), '', 'utf8');

    const db = openTrajectoryDb();
    const id = insertTurn(db, {
      sessionId: 'sess-1',
      rawText: null,
      sanitizedText: 'sanitized fallback',
      blobRef: 'empty.txt',
    });
    db.close();

    const result = await model.getAssistantTurn(id, 'sess-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.text).toBe('sanitized fallback');
    expect(result.turn.textSource).toBe('sanitized');
  });

  it('refuses a turn that belongs to another session', async () => {
    const db = openTrajectoryDb();
    const id = insertTurn(db, { sessionId: 'sess-other', rawText: MIXED_TEXT, sanitizedText: 'x' });
    db.close();

    const result = await model.getAssistantTurn(id, 'sess-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('does not belong');
    expect(result.nextAction.length).toBeGreaterThan(0);
  });

  it('fails observably for a missing turn, an empty text and an invalid id', async () => {
    const db = openTrajectoryDb();
    const emptyId = insertTurn(db, { sessionId: 'sess-1', rawText: null, sanitizedText: '' });
    db.close();

    const missing = await model.getAssistantTurn(9999, 'sess-1');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('not found');

    const empty = await model.getAssistantTurn(emptyId, 'sess-1');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toContain('no recorded output');

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const invalid = await model.getAssistantTurn(bad);
      expect(invalid.ok).toBe(false);
    }
  });
});
