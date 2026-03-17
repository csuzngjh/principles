import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvolutionReducerImpl } from '../../src/core/evolution-reducer.js';
import { handleEvolutionStatusCommand } from '../../src/commands/evolution-status.js';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evolution-e2e-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('evolution loop e2e', () => {
  it('runs pain -> probation -> status query -> rollback flow', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    reducer.emitSync({
      ts: new Date().toISOString(),
      type: 'pain_detected',
      data: {
        painId: 'pain-e2e-1',
        painType: 'tool_failure',
        source: 'write',
        reason: 'write failed on risky file',
      },
    });

    const p = reducer.getProbationPrinciples()[0];
    expect(p).toBeDefined();

    const statusBefore = handleEvolutionStatusCommand({ config: { workspaceDir: workspace, language: 'en' } } as any);
    expect(statusBefore.text).toContain('probation: 1');

    reducer.rollbackPrinciple(p.id, 'manual validation failed');

    const statusAfter = handleEvolutionStatusCommand({ config: { workspaceDir: workspace, language: 'en' } } as any);
    expect(statusAfter.text).toContain('deprecated: 1');
  });
});
