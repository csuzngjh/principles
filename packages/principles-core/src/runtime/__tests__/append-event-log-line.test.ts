import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendEventLogLine } from '../pain-signal-observability.js';

describe('PRI-750 appendEventLogLine (shared events_*.jsonl writer)', () => {
  it('writes one EventLog-format line to events_<date>.jsonl under stateDir/logs', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evline-'));
    try {
      appendEventLogLine(stateDir, {
        ts: '2026-09-13T00:00:00.000Z',
        type: 'tool_call',
        category: 'failure',
        sessionId: 'sess-1',
        data: { toolName: 'edit', runId: 'run-abc', toolCallId: 'call-1' },
      });
      const file = path.join(stateDir, 'logs', 'events_2026-09-13.jsonl');
      expect(fs.existsSync(file)).toBe(true);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toMatchObject({
        ts: '2026-09-13T00:00:00.000Z',
        date: '2026-09-13',
        type: 'tool_call',
        category: 'failure',
        sessionId: 'sess-1',
        data: { toolName: 'edit', runId: 'run-abc', toolCallId: 'call-1' },
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('appends a second line to the same daily file', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evline-'));
    try {
      appendEventLogLine(stateDir, { ts: '2026-09-13T00:00:01.000Z', type: 'tool_call', category: 'success', sessionId: 'sess-1', data: { toolName: 'read' } });
      appendEventLogLine(stateDir, { ts: '2026-09-13T00:00:02.000Z', type: 'tool_call', category: 'success', sessionId: 'sess-1', data: { toolName: 'search' } });
      const file = path.join(stateDir, 'logs', 'events_2026-09-13.jsonl');
      expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
