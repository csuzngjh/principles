import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it, afterEach } from 'vitest';
import { recordPainSignalObservability } from '../pain-signal-observability.js';

const tempDirs: string[] = [];

function makeWorkspace(): { workspaceDir: string; stateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'pd-observability-'));
  tempDirs.push(workspaceDir);
  return { workspaceDir, stateDir: join(workspaceDir, '.state') };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('recordPainSignalObservability', () => {
  it('records manual Runtime v2 pain signals without writing legacy evolution_tasks', () => {
    const { workspaceDir, stateDir } = makeWorkspace();
    const result = recordPainSignalObservability({
      workspaceDir,
      stateDir,
      data: {
        painId: 'manual_test_001',
        taskId: 'diagnosis_manual_test_001',
        painType: 'user_frustration',
        source: 'manual',
        reason: 'manual pain diagnosis',
        score: 95,
        sessionId: 'cli',
        agentId: 'pd-cli',
      },
    });

    expect(result.warnings).toEqual([]);
    expect(result.eventLogPath).toContain('events_');
    expect(result.evolutionStreamPath).toBe(join(workspaceDir, 'memory', 'evolution.jsonl'));
    expect(result.trajectoryPainEventId).toBeGreaterThan(0);
    const {eventLogPath} = result;
    const {evolutionStreamPath} = result;
    expect(eventLogPath).toBeDefined();
    expect(evolutionStreamPath).toBeDefined();

    const eventLogLine = readFileSync(String(eventLogPath), 'utf8').trim();
    expect(JSON.parse(eventLogLine)).toMatchObject({
      type: 'pain_signal',
      category: 'detected',
      sessionId: 'cli',
      data: {
        eventId: 'manual_test_001',
        score: 95,
        source: 'manual',
        origin: 'user_manual',
      },
    });

    const evolutionLine = readFileSync(String(evolutionStreamPath), 'utf8').trim();
    expect(JSON.parse(evolutionLine)).toMatchObject({
      type: 'pain_detected',
      data: {
        painId: 'manual_test_001',
        taskId: 'diagnosis_manual_test_001',
      },
    });

    const db = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
    try {
      const painRow = db.prepare('SELECT session_id, source, score, reason FROM pain_events').get() as {
        session_id: string;
        source: string;
        score: number;
        reason: string;
      };
      expect(painRow).toEqual({
        session_id: 'cli',
        source: 'manual',
        score: 95,
        reason: 'manual pain diagnosis',
      });

      const hasEvolutionTasks = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evolution_tasks'
      `).get();
      expect(hasEvolutionTasks).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
