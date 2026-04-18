import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handlePdReflect } from '../../src/commands/pd-reflect.js';

describe('pd-reflect command', () => {
  let tempDir: string;
  let workspaceDir: string;
  let queuePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-reflect-'));
    workspaceDir = path.join(tempDir, 'workspace-a');
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    queuePath = path.join(workspaceDir, '.state', 'evolution_queue.json');
    fs.writeFileSync(queuePath, '[]', 'utf8');
  });

  it('requires an explicit resolved workspace directory', async () => {
    const result = await handlePdReflect.handler({} as any);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('workspaceDir is not set');
  });

  it('enqueues into the provided active workspace', async () => {
    const result = await handlePdReflect.handler({ workspaceDir } as any);
    expect(result.isError).toBeUndefined();

    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as Array<Record<string, unknown>>;
    expect(queue).toHaveLength(1);
    expect(queue[0].taskKind).toBe('sleep_reflection');
    expect(result.text).toContain('Nocturnal reflection task enqueued');
  });

  it('does not hardcode another workspace when context already provides one', async () => {
    const otherWorkspace = path.join(tempDir, 'workspace-b');
    fs.mkdirSync(path.join(otherWorkspace, '.state'), { recursive: true });
    const otherQueuePath = path.join(otherWorkspace, '.state', 'evolution_queue.json');
    fs.writeFileSync(otherQueuePath, '[]', 'utf8');

    await handlePdReflect.handler({ workspaceDir } as any);

    const activeQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as Array<Record<string, unknown>>;
    const otherQueue = JSON.parse(fs.readFileSync(otherQueuePath, 'utf8')) as Array<Record<string, unknown>>;
    expect(activeQueue).toHaveLength(1);
    expect(otherQueue).toHaveLength(0);
  });
});
