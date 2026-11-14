import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectRuleCodeEventEntries, countRuleHostFaultSignatures, ActivationsConsoleModel } from '../../src/server/models/ActivationsConsoleModel.js';
import { validateActivations } from '../../src/ui/utils/validators.js';

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

  it('keeps distinct events from same-named daily files and deduplicates exact copied lines', () => {
    const copied = makeEventLine();
    writeEventsFile('.state/logs', '2026-08-21', [
      copied,
      makeEventLine({}, { toolName: 'edit', filePath: 'y', matched: false, decision: 'allow' }),
    ]);
    writeEventsFile('.pd/logs', '2026-08-21', [copied]);

    const collected = collectRuleCodeEventEntries(workspaceDir);
    expect(collected.entries.length).toBe(2);
    expect(collected.sourceDirsFound).toBe(2);
  });

  it('reports zero source dirs when neither directory exists', () => {
    const collected = collectRuleCodeEventEntries(workspaceDir);
    expect(collected.entries.length).toBe(0);
    expect(collected.sourceDirsFound).toBe(0);
  });

  it('does not count an unreadable candidate path as a healthy source', () => {
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.state', 'logs'), 'not a directory');
    const collected = collectRuleCodeEventEntries(workspaceDir);
    expect(collected.sourceDirsFound).toBe(0);
    expect(collected.entries).toEqual([]);
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

/**
 * PRI-1211: after the producer deduplicates faults per process/signature, a
 * raw row count no longer means "number of failures". The Console must show
 * the DISTINCT signature count as the primary figure and the raw row count as
 * a separate, clearly labelled secondary figure — never one standing in for
 * the other, and never 0 when the figure is not derivable.
 */
describe('PRI-1211 countRuleHostFaultSignatures', () => {
  const MIN_TIME = 0;

  function faultRow(dataOverrides: Record<string, unknown> = {}, ts = '2026-08-21T00:47:00.469Z'): unknown {
    return {
      ts,
      type: 'rulehost_unhealthy',
      category: 'failure',
      data: {
        activationId: ACTIVATION_ID,
        artifactId: 'artifact-1',
        ruleId: 'rule-1',
        reason: 'rule_compile_failed',
        nextAction: 'fix the rule',
        ...dataOverrides,
      },
    };
  }

  it('collapses repeated rows of the same signature into one deduplicated count', () => {
    const result = countRuleHostFaultSignatures(
      [faultRow(), faultRow(), faultRow()],
      ACTIVATION_ID,
      MIN_TIME,
    );
    expect(result.rawRows).toBe(3);
    expect(result.distinctSignatures).toBe(1);
    expect(result.status).toBe('ok');
    expect(result.undedupableRows).toBe(0);
  });

  it('keeps distinct signatures apart (artifact and reason both discriminate)', () => {
    const result = countRuleHostFaultSignatures([
      faultRow(),
      faultRow({ reason: 'rule_load_failed' }),
      faultRow({ artifactId: 'artifact-2' }),
    ], ACTIVATION_ID, MIN_TIME);
    expect(result.rawRows).toBe(3);
    expect(result.distinctSignatures).toBe(3);
  });

  it('reports UNKNOWN (not 0, not a partial conversion) when a row lacks signature fields', () => {
    const result = countRuleHostFaultSignatures([
      faultRow(),
      faultRow({ artifactId: undefined }),
    ], ACTIVATION_ID, MIN_TIME);
    expect(result.rawRows).toBe(2);
    expect(result.undedupableRows).toBe(1);
    expect(result.distinctSignatures).toBeNull();
    expect(result.status).toBe('undedupable');
  });

  it('never falls back to the raw row count as the signature count', () => {
    const result = countRuleHostFaultSignatures(
      [faultRow(), faultRow(), faultRow({ reason: 'other_defect' })],
      ACTIVATION_ID,
      MIN_TIME,
    );
    expect(result.rawRows).toBe(3);
    expect(result.distinctSignatures).toBe(2);
    expect(result.distinctSignatures).not.toBe(result.rawRows);
  });

  it('scopes by activation and window', () => {
    const windowStart = Date.parse('2026-08-21T00:00:00.000Z');
    const result = countRuleHostFaultSignatures([
      faultRow(),
      faultRow({ activationId: 'other-activation' }),
      faultRow({}, '2020-01-01T00:00:00.000Z'),
    ], ACTIVATION_ID, windowStart);
    expect(result.rawRows).toBe(1);
    expect(result.distinctSignatures).toBe(1);
    expect(result.status).toBe('ok');
  });
});

describe('PRI-1210 getActivations enforcement state', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri1210-console-ws-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('always reports the workspace enforcement state, even when state.db is missing', async () => {
    const model = new ActivationsConsoleModel(workspaceDir);
    const response = await model.getActivations();
    expect(response.status).toBe('degraded');
    expect(response.enforcement.state).toBe('healthy');
    expect(response.enforcement.markerPath).toContain(path.join('.pd', 'enforcement-health'));
  });

  it('validateActivations keeps a well-formed enforcement payload', () => {
    const validated = validateActivations({
      activations: [],
      status: 'ok',
      enforcement: { state: 'unknown', markerPath: '/home/.pd/enforcement-health/degraded-x.json', unreadableReason: 'marker_malformed_json' },
    });
    expect(validated?.enforcement?.state).toBe('unknown');
    expect(validated?.enforcement?.unreadableReason).toBe('marker_malformed_json');
  });

  it('validateActivations never turns a malformed state into healthy', () => {
    // `degraded` without a reason cannot be rendered truthfully — the field is
    // dropped, and the page renders its own explicit UNKNOWN panel.
    const validated = validateActivations({ activations: [], status: 'ok', enforcement: { state: 'degraded' } });
    expect(validated).not.toBeNull();
    expect(validated?.enforcement).toBeUndefined();
  });
});
