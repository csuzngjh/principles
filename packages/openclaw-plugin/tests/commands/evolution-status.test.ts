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
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('evolution commands', () => {
  it('returns evolution status summary', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    reducer.emitSync({
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: { painId: 'pain-1', painType: 'tool_failure', source: 'write', reason: 'write failed' },
    });

    const result = handleEvolutionStatusCommand({ config: { workspaceDir: workspace, language: 'en' } } as any);
    expect(result.text).toContain('Evolution Status');
    expect(result.text).toContain('probation principles: 1');
  });



  it('returns localized evolution status summary in zh', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    reducer.emitSync({
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: { painId: 'pain-zh', painType: 'tool_failure', source: 'write', reason: 'write failed' },
    });

    const result = handleEvolutionStatusCommand({ config: { workspaceDir: workspace, language: 'zh-CN' } } as any);
    expect(result.text).toContain('Evolution 状态');
    expect(result.text).toContain('观察期原则: 1');
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
