import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectRuleCodeEventEntries } from '../../src/server/models/ActivationsConsoleModel.js';

/**
 * PRI-577 regression tests — RuleCode shadow telemetry directory mismatch.
 *
 * The console model used to scan only `{workspace}/.pd/logs/`, but production
 * EventLog writes to `{workspace}/.state/logs/`. These tests pin the real-world
 * directory layout (EP-09: test reality gap — the previous suite only covered
 * the missing-directory path).
 */

const ACTIVATION_ID = 'act_code_console-rule';

function makeEventLine(eventOverrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: '2026-08-21T00:47:00.469Z',
    type: 'rulehost_evaluated',
    category: 'evaluated',
    data: {
      toolName: 'write_file',
      filePath: '<redacted>',
      matched: true,
      decision: 'block',
      ruleId: 'rule-1',
      activationId: ACTIVATION_ID,
      activationMode: 'shadow',
      ...dataOverrides,
    },
    ...eventOverrides,
  });
}

describe('PRI-577 console shadow telemetry dual-directory reading', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri577-console-ws-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeEventsFile(relLogsDir: string, date: string, lines: string[]): void {
    const dir = path.join(workspaceDir, ...relLogsDir.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `events_${date}.jsonl`), lines.join('\n') + '\n', 'utf8');
  }

  it('collects entries from legacy .state/logs when .pd/logs is absent', () => {
    writeEventsFile('.state/logs', '2026-08-21', [
      makeEventLine(),
      makeEventLine({}, { toolName: 'edit', filePath: 'y', matched: false, decision: 'allow' }),
    ]);

    const collected = collectRuleCodeEventEntries(workspaceDir);
    expect(collected.entries.length).toBe(2);
    expect(collected.sourceDirsFound).toBe(1);
  });

  it('merges entries when both candidate directories exist', () => {
    writeEventsFile('.state/logs', '2026-08-21', [makeEventLine()]);
    writeEventsFile('.pd/logs', '2026-08-22', [
      makeEventLine({ ts: '2026-08-22T10:00:00.000Z' }),
    ]);

    const collected = collectRuleCodeEventEntries(workspaceDir);
    expect(collected.entries.length).toBe(2);
    expect(collected.sourceDirsFound).toBe(2);
  });

  it('reports zero source dirs when neither directory exists', () => {
    const collected = collectRuleCodeEventEntries(workspaceDir);
    expect(collected.entries.length).toBe(0);
    expect(collected.sourceDirsFound).toBe(0);
  });

  it('excludes malformed telemetry lines instead of failing the scan', () => {
    writeEventsFile('.state/logs', '2026-08-21', [
      '{broken json',
      makeEventLine(),
    ]);

    const collected = collectRuleCodeEventEntries(workspaceDir);
    expect(collected.entries.length).toBe(1);
  });
});
