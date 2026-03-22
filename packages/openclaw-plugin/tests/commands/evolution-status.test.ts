import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleEvolutionStatusCommand } from '../../src/commands/evolution-status.js';
import { handlePrincipleRollbackCommand } from '../../src/commands/principle-rollback.js';
import { EvolutionReducerImpl } from '../../src/core/evolution-reducer.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evolution-command-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.state', 'logs'), { recursive: true });
  return dir;
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('evolution commands', () => {
  it('returns evolution status from canonical runtime summary sources', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    reducer.emitSync({
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: { painId: 'pain-1', painType: 'tool_failure', source: 'write', reason: 'write failed' },
    });

    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 85,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
      { id: 'q1', status: 'pending' },
    ]);
    writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
      active: true,
      task: 'fix something',
      timestamp: '2026-03-20T10:00:00Z',
    });
    writeJson(path.join(workspace, '.state', 'sessions', 's1.json'), {
      sessionId: 's1',
      currentGfi: 45,
      dailyGfiPeak: 78,
      lastActivityAt: 1,
    });
    fs.writeFileSync(
      path.join(workspace, '.state', 'logs', 'events.jsonl'),
      `${JSON.stringify({
        ts: '2026-03-20T10:00:01Z',
        type: 'pain_signal',
        category: 'detected',
        sessionId: 's1',
        data: { source: 'tool_failure', score: 50, reason: 'write failed' },
      })}\n`,
      'utf8'
    );

    const result = handleEvolutionStatusCommand({
      config: { workspaceDir: workspace, language: 'en' },
      sessionId: 's1',
    } as any);

    expect(result.text).toContain('Evolution Status');
    expect(result.text).toContain('legacy/frozen');
    expect(result.text).toContain('Session GFI: current 45, peak 78');
    expect(result.text).toContain('Queue: pending 1, in_progress 0, completed 0');
    expect(result.text).toContain('Directive (derived from queue, compatibility only)');
    expect(result.text).toContain('Phase 3: ready');
    expect(result.text).toContain('queueTruthReady');
    expect(result.text).toContain('probation principles: 1');
    expect(result.text).not.toContain('.state/principles');
  });

  it('returns localized evolution status summary in zh', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    reducer.emitSync({
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: { painId: 'pain-zh', painType: 'tool_failure', source: 'write', reason: 'write failed' },
    });

    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 59,
      last_updated: '2026-03-20T10:00:00Z',
    });

    const result = handleEvolutionStatusCommand({
      config: { workspaceDir: workspace, language: 'zh-CN' },
    } as any);

    expect(result.text).toContain('进化状态');
    expect(result.text).toContain('观察期原则: 1');
    expect(result.text).toContain('Legacy Trust');
  });

  it('rolls back principle through command', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    reducer.emitSync({
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: { painId: 'pain-1', painType: 'tool_failure', source: 'write', reason: 'write failed' },
    });

    const pid = reducer.getProbationPrinciples()[0].id;
    const result = handlePrincipleRollbackCommand({
      args: `${pid} test rollback`,
      config: { workspaceDir: workspace, language: 'en' },
    } as any);

    expect(result.text).toContain(`Rolled back principle ${pid}`);

    const updated = new EvolutionReducerImpl({ workspaceDir: workspace }).getPrincipleById(pid);
    expect(updated?.status).toBe('deprecated');
  });
});
