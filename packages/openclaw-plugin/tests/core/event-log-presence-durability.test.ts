import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import { build } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventLog } from '../../src/core/event-log.js';

const PRESENCE_EVENT_TYPE = 'runtime_v2_prompt_presence_observed';

const presenceData = {
  runId: 'run-1',
  sessionId: 'session-1',
  boundary: 'post_assembly_system_prompt_via_llm_input' as const,
  binding: 'unique' as const,
  liveSnapshots: 1,
  assemblySeqCandidates: [0],
  checked: true,
  results: [],
};

function eventLines(stateDir: string): Record<string, unknown>[] {
  const logsDir = path.join(stateDir, 'logs');
  return fs.readdirSync(logsDir)
    .filter((name) => name.startsWith('events_') && name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(logsDir, name), 'utf8').split('\n'))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runChildToNaturalExit(bundlePath: string, stateDir: string, mode: string) {
  const startedAt = Date.now();
  const child = fork('tests/core/event-log-natural-exit-child.mjs', [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.stdin?.end(JSON.stringify({ bundlePath, stateDir, mode }));
  const exitCode = await new Promise<number | null>((resolve) => { child.on('exit', (code) => resolve(code)); });
  return { exitCode, elapsedMs: Date.now() - startedAt, stderr };
}

describe('EventLog presence event durability (PRI-1152 B1)', () => {
  let tempDir: string;
  let bundlePath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-log-durability-'));
    bundlePath = path.join(tempDir, 'event-log.bundle.mjs');
    // The same bundler and format as the production plugin bundle.
    await build({
      entryPoints: ['src/core/event-log.ts'],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
      external: ['better-sqlite3'],
      logLevel: 'silent',
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('a one-shot process that exits naturally leaves exactly one presence event on disk', async () => {
    const stateDir = path.join(tempDir, 'state');
    const result = await runChildToNaturalExit(bundlePath, stateDir, 'presence');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    // Well below the 30 s interval: the write cannot have come from the flush timer.
    expect(result.elapsedMs).toBeLessThan(30_000);
    const events = eventLines(stateDir);
    expect(events.filter((entry) => entry['type'] === PRESENCE_EVENT_TYPE)).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.['data']).toMatchObject({ runId: 'run-natural-exit', sessionId: 'session-natural-exit', binding: 'unique' });
  }, 60_000);

  it('control: other buffered events keep the existing policy and are not written at natural exit', async () => {
    const stateDir = path.join(tempDir, 'state');
    const result = await runChildToNaturalExit(bundlePath, stateDir, 'buffered-control');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(eventLines(stateDir)).toEqual([]);
  }, 60_000);

  it('a failed write does not throw, reports the error and keeps the event buffered for the next write', () => {
    const stateDir = path.join(tempDir, 'state-failing');
    const error = vi.fn();
    const eventLog = new EventLog(stateDir, { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never);
    try {
      const blocker = path.join(stateDir, 'logs', `events_${new Date().toISOString().slice(0, 10)}.jsonl`);
      // A directory at the events path makes the real append fail on every platform.
      fs.mkdirSync(blocker);
      expect(() => eventLog.recordPromptPresenceObserved(presenceData)).not.toThrow();
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toContain('Failed to flush events');
      expect(eventLog.getBufferedEvents().map((entry) => entry.type)).toEqual([PRESENCE_EVENT_TYPE]);

      fs.rmdirSync(blocker);
      eventLog.recordPromptPresenceObserved({ ...presenceData, runId: 'run-2' });
      expect(eventLog.getBufferedEvents()).toEqual([]);
      expect(eventLines(stateDir).map((entry) => (entry['data'] as { runId: string }).runId)).toEqual(['run-1', 'run-2']);
    } finally {
      eventLog.dispose();
    }
  });
});
