import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import BetterSqlite3 from 'better-sqlite3';
import { OperatorHealthReadModel } from '../operator-health-read-model.js';
import type { PainChainReadModel } from '../pain-chain-read-model.js';

function healthyChain() {
  return {
    painId: 'pain_001', taskId: 'task_001', runId: 'run_001', artifactId: 'art_001',
    candidateIds: ['c1'], ledgerEntryIds: ['l1'], status: 'succeeded' as const,
    latencyMs: { painToTask: 100 }, failureCategory: null,
    checkedAt: '2026-05-03T12:00:00.000Z', missingLinks: [],
  };
}

function initMinimalDb(pdDir: string): void {
  const db = new BetterSqlite3(path.join(pdDir, 'state.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      task_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS principle_candidates (
      candidate_id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      confidence REAL,
      source_recommendation_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.close();
}

describe('OperatorHealthReadModel GFI health checks (CANARY-02)', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-gfi-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('0 active + stale low GFI → healthy (not degraded)', async () => {
    const pdDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    initMinimalDb(pdDir);

    const sessionDir = path.join(tmpDir, '.state', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const nowMs = Date.now();
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(sessionDir, `stale-${i}.json`), JSON.stringify({
        sessionId: `stale-${i}`,
        currentGfi: 2.0,
        consecutiveErrors: 1,
        lastActivityAt: nowMs - (4 * 60 * 60 * 1000),
      }));
    }

    const chain = {
      getLastSuccessfulChain: () => Promise.resolve(healthyChain()),
      close: () => Promise.resolve(),
    };

    const model = new OperatorHealthReadModel({
      workspaceDir: tmpDir,
      painChainReadModel: chain as unknown as PainChainReadModel,
    });
    try {
      const s = await model.getSnapshot();
      expect(s.gfi.staleSessionCount).toBeGreaterThanOrEqual(20);
      expect(s.gfi.activeSessionCount).toBe(0);
      expect(s.overallStatus).toBe('healthy');
    } finally {
      await model.close();
    }
  });

  it('0 active + stale high GFI → degraded', async () => {
    const pdDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    initMinimalDb(pdDir);

    const sessionDir = path.join(tmpDir, '.state', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const nowMs = Date.now();
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(sessionDir, `stale-${i}.json`), JSON.stringify({
        sessionId: `stale-${i}`,
        currentGfi: 50,
        consecutiveErrors: 3,
        lastActivityAt: nowMs - (4 * 60 * 60 * 1000),
      }));
    }

    const chain = {
      getLastSuccessfulChain: () => Promise.resolve(healthyChain()),
      close: () => Promise.resolve(),
    };

    const model = new OperatorHealthReadModel({
      workspaceDir: tmpDir,
      painChainReadModel: chain as unknown as PainChainReadModel,
    });
    try {
      const s = await model.getSnapshot();
      expect(s.gfi.staleSessionCount).toBeGreaterThanOrEqual(20);
      expect(s.gfi.activeSessionCount).toBe(0);
      expect(s.overallStatus).toBe('degraded');
      expect(s.recommendedActions.some(a => a.includes('GFI degraded'))).toBe(true);
    } finally {
      await model.close();
    }
  });

  it('recommendedActions only includes GFI cleanup when truly degraded', async () => {
    const pdDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    initMinimalDb(pdDir);

    const sessionDir = path.join(tmpDir, '.state', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const nowMs = Date.now();
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(sessionDir, `stale-${i}.json`), JSON.stringify({
        sessionId: `stale-${i}`,
        currentGfi: 3,
        consecutiveErrors: 0,
        lastActivityAt: nowMs - (4 * 60 * 60 * 1000),
      }));
    }

    const chain = {
      getLastSuccessfulChain: () => Promise.resolve(healthyChain()),
      close: () => Promise.resolve(),
    };

    const model = new OperatorHealthReadModel({
      workspaceDir: tmpDir,
      painChainReadModel: chain as unknown as PainChainReadModel,
    });
    try {
      const s = await model.getSnapshot();
      expect(s.overallStatus).toBe('healthy');
      expect(s.recommendedActions.some(a => a.includes('GFI degraded'))).toBe(false);
    } finally {
      await model.close();
    }
  });
});
