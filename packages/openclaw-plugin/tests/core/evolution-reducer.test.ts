import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvolutionReducerImpl } from '../../src/core/evolution-reducer.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evolution-reducer-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('EvolutionReducerImpl', () => {
  it('appends emitted events to evolution stream jsonl', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    reducer.emitSync({
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: { painId: 'pain-1', painType: 'tool_failure', source: 'write', reason: 'write failed' },
    });

    const streamPath = path.join(workspace, 'memory', 'evolution.jsonl');
    const lines = fs.readFileSync(streamPath, 'utf8').trim().split('\n');

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some(line => JSON.parse(line).type === 'pain_detected')).toBe(true);
  });

  it('creates principle from diagnosis and auto-promotes to probation', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    // Pain detected no longer creates principle automatically
    reducer.emitSync({
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: {
        painId: 'pain-1',
        painType: 'tool_failure',
        source: 'write',
        reason: 'Tool write failed',
      },
    });

    // No principle created yet
    expect(reducer.getCandidatePrinciples()).toHaveLength(0);
    expect(reducer.getProbationPrinciples()).toHaveLength(0);

    // Create principle from diagnostician analysis
    const principleId = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write operation fails',
      action: 'check file permissions and disk space',
      source: 'write',
    });

    expect(principleId).not.toBeNull();
    expect(reducer.getCandidatePrinciples()).toHaveLength(0);
    expect(reducer.getProbationPrinciples()).toHaveLength(1);
    const stats = reducer.getStats();
    expect(stats.probationCount).toBe(1);
  });

  it('ignores protocol-token pain before creating principles', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    reducer.emitSync({
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: {
        painId: 'pain-protocol-1',
        painType: 'tool_failure',
        source: 'llm_p_frustration_023',
        reason: '[EVOLUTION_ACK] previous failure context',
      },
    });

    expect(reducer.getCandidatePrinciples()).toHaveLength(0);
    expect(reducer.getProbationPrinciples()).toHaveLength(0);
    expect(reducer.getActivePrinciples()).toHaveLength(0);
  });

  it('opens circuit breaker after 3 subagent errors on same task', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    for (let i = 0; i < 3; i++) {
      reducer.emitSync({
        ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        type: 'pain_detected',
        data: {
          painId: `pain-${i}`,
          painType: 'subagent_error',
          source: 'subagent_error',
          taskId: 'task-1',
          reason: 'subagent failed',
        },
      });
    }

    const breakerEvents = reducer.getEventLog().filter(e => e.type === 'circuit_breaker_opened');
    expect(breakerEvents).toHaveLength(1);
    expect((breakerEvents[0].data as any).taskId).toBe('task-1');
  });



  it('promotes probation to active after feedback threshold', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    // Create principle from diagnosis
    const principleId = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write operation fails',
      action: 'check file permissions',
      source: 'write',
    });

    const principle = reducer.getProbationPrinciples()[0];
    reducer.recordProbationFeedback(principle.id, true);
    reducer.recordProbationFeedback(principle.id, true);
    reducer.recordProbationFeedback(principle.id, true);

    expect(reducer.getPrincipleById(principle.id)?.status).toBe('active');
  });

  it('rebuildState skips malformed lines without crashing', () => {
    const workspace = makeTempDir();
    const streamPath = path.join(workspace, 'memory', 'evolution.jsonl');
    fs.mkdirSync(path.dirname(streamPath), { recursive: true });
    fs.writeFileSync(streamPath, '{bad json}\n' + JSON.stringify({
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: { painId: 'p1', painType: 'tool_failure', source: 'write', reason: 'oops' },
    }) + '\n');

    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    expect(reducer.getProbationPrinciples()).toHaveLength(0);
    expect(reducer.getEventLog().length).toBeGreaterThan(0);
  });

  it('rolls back principle and persists blacklist', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    // Create principle from diagnosis
    const principleId = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write operation fails',
      action: 'check file permissions',
      source: 'write',
    });

    const principle = reducer.getProbationPrinciples()[0];
    reducer.rollbackPrinciple(principle.id, 'bad quality');

    const updated = reducer.getPrincipleById(principle.id);
    expect(updated?.status).toBe('deprecated');

    const blacklistPath = path.join(workspace, '.state', 'principle_blacklist.json');
    const blacklist = JSON.parse(fs.readFileSync(blacklistPath, 'utf8'));
    expect(Array.isArray(blacklist)).toBe(true);
    expect(blacklist[0].pattern).toContain('file write operation fails');
  });
});
