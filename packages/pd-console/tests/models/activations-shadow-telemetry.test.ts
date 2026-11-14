import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteConnection } from '@principles/core/runtime';
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
  const MAX_TIME = Date.parse('2026-08-22T00:00:00.000Z');

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
      { minimumTime: MIN_TIME, maximumTime: MAX_TIME },
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
    ], ACTIVATION_ID, { minimumTime: MIN_TIME, maximumTime: MAX_TIME });
    expect(result.rawRows).toBe(3);
    expect(result.distinctSignatures).toBe(3);
  });

  it('reports UNKNOWN (not 0, not a partial conversion) when a row lacks signature fields', () => {
    const result = countRuleHostFaultSignatures([
      faultRow(),
      faultRow({ artifactId: undefined }),
    ], ACTIVATION_ID, { minimumTime: MIN_TIME, maximumTime: MAX_TIME });
    expect(result.rawRows).toBe(2);
    expect(result.undedupableRows).toBe(1);
    expect(result.distinctSignatures).toBeNull();
    expect(result.status).toBe('undedupable');
  });

  it('never falls back to the raw row count as the signature count', () => {
    const result = countRuleHostFaultSignatures(
      [faultRow(), faultRow(), faultRow({ reason: 'other_defect' })],
      ACTIVATION_ID,
      { minimumTime: MIN_TIME, maximumTime: MAX_TIME },
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
    ], ACTIVATION_ID, { minimumTime: windowStart, maximumTime: MAX_TIME });
    expect(result.rawRows).toBe(1);
    expect(result.distinctSignatures).toBe(1);
    expect(result.status).toBe('ok');
  });
});

/**
 * PRI-1211 review fix: `Date.parse` yields NaN for invalid input and NaN fails
 * every comparison, so a bare `< minimumTime` check ADMITTED malformed rows
 * into the statistics. Both counters now share one inclusive-window rule:
 * invalid, empty, null and future timestamps are excluded.
 */
describe('PRI-1211 timestamp window validation', () => {
  const WINDOW_START = Date.parse('2026-08-21T00:00:00.000Z');
  const WINDOW_END = Date.parse('2026-08-21T12:00:00.000Z');

  function faultRow(ts: unknown, dataOverrides: Record<string, unknown> = {}): unknown {
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

  it('counts a valid ISO timestamp inside the window', () => {
    const result = countRuleHostFaultSignatures(
      [faultRow('2026-08-21T06:00:00.000Z')],
      ACTIVATION_ID,
      { minimumTime: WINDOW_START, maximumTime: WINDOW_END },
    );
    expect(result.rawRows).toBe(1);
    expect(result.distinctSignatures).toBe(1);
  });

  it('excludes a non-date string instead of admitting it', () => {
    const result = countRuleHostFaultSignatures(
      [faultRow('not-a-date')],
      ACTIVATION_ID,
      { minimumTime: WINDOW_START, maximumTime: WINDOW_END },
    );
    expect(result.rawRows).toBe(0);
    expect(result.distinctSignatures).toBe(0);
    expect(result.status).toBe('ok');
  });

  it('excludes an empty timestamp', () => {
    const result = countRuleHostFaultSignatures(
      [faultRow('')],
      ACTIVATION_ID,
      { minimumTime: WINDOW_START, maximumTime: WINDOW_END },
    );
    expect(result.rawRows).toBe(0);
    expect(result.distinctSignatures).toBe(0);
  });

  it('excludes a null timestamp', () => {
    const result = countRuleHostFaultSignatures(
      [faultRow(null)],
      ACTIVATION_ID,
      { minimumTime: WINDOW_START, maximumTime: WINDOW_END },
    );
    expect(result.rawRows).toBe(0);
    expect(result.distinctSignatures).toBe(0);
  });

  it('excludes a future timestamp from the window', () => {
    const result = countRuleHostFaultSignatures(
      [faultRow('2026-08-21T12:00:00.001Z')],
      ACTIVATION_ID,
      { minimumTime: WINDOW_START, maximumTime: WINDOW_END },
    );
    expect(result.rawRows).toBe(0);
    expect(result.distinctSignatures).toBe(0);
  });

  it('treats a record exactly at the window start as inside the window', () => {
    const result = countRuleHostFaultSignatures(
      [faultRow('2026-08-21T00:00:00.000Z')],
      ACTIVATION_ID,
      { minimumTime: WINDOW_START, maximumTime: WINDOW_END },
    );
    expect(result.rawRows).toBe(1);
  });

  it('treats a record exactly at the window end as inside the window', () => {
    const result = countRuleHostFaultSignatures(
      [faultRow('2026-08-21T12:00:00.000Z')],
      ACTIVATION_ID,
      { minimumTime: WINDOW_START, maximumTime: WINDOW_END },
    );
    expect(result.rawRows).toBe(1);
  });

  it('keeps invalid timestamps out of rawRows even when mixed with valid rows', () => {
    const result = countRuleHostFaultSignatures([
      faultRow('2026-08-21T06:00:00.000Z'),
      faultRow('garbage'),
      faultRow(''),
      faultRow(null),
      { ts: undefined, type: 'rulehost_unhealthy', data: { activationId: ACTIVATION_ID, artifactId: 'artifact-1', reason: 'rule_compile_failed' } },
      faultRow('2026-08-21T12:00:00.001Z'),
    ], ACTIVATION_ID, { minimumTime: WINDOW_START, maximumTime: WINDOW_END });
    expect(result.rawRows).toBe(1);
  });

  it('keeps invalid timestamps out of distinctSignatures (no phantom signature)', () => {
    const result = countRuleHostFaultSignatures([
      faultRow('2026-08-21T06:00:00.000Z', { artifactId: 'artifact-1' }),
      faultRow('garbage', { artifactId: 'artifact-2' }),
      faultRow('2026-08-21T07:00:00.000Z', { artifactId: 'artifact-2' }),
    ], ACTIVATION_ID, { minimumTime: WINDOW_START, maximumTime: WINDOW_END });
    // Only the two VALID rows contribute: artifact-1 and artifact-2.
    expect(result.rawRows).toBe(2);
    expect(result.distinctSignatures).toBe(2);
    expect(result.undedupableRows).toBe(0);
    expect(result.status).toBe('ok');
  });
});

describe('PRI-1211 summarizeWindow timestamp validation', () => {
  const LIVE_ACTIVATION = 'act-telemetry-window';
  let workspaceDir: string;
  let model: ActivationsConsoleModel;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri1211-window-ws-'));
    model = new ActivationsConsoleModel(workspaceDir);
  });

  afterEach(() => {
    model.dispose();
    // Windows may hold the SQLite file handle briefly after close().
    fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function seedActivation(): void {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    const now = '2026-08-21T06:00:00.000Z';
    db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-window', 'diagnosis', 'pending', ?, ?)").run(now, now);
    db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES ('artifact-window', 'rule', 'task-window', 'rule-window', '["parent-1"]', 'validated', ?, ?, ?)`)
      .run(JSON.stringify({ implementationCode: 'function evaluate(input) { return { decision: "allow", matched: false, reason: "neutral" }; }' }), now, now);
    db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
      VALUES ('${LIVE_ACTIVATION}', 'idem-window', 'artifact-window', 'code_tool_hook', 'code_tool_hook_shadow_activate', 'impl://rule-window', ?, NULL)`).run(now);
    db.prepare(`INSERT INTO activation_control_states (activation_id, enforcement, version, updated_at) VALUES ('${LIVE_ACTIVATION}', 'eligible', 1, ?)`).run(now);
    // A real immutable `safety_isolate` decision, so the circuit-trip counter
    // has a genuine input and its window filter actually runs.
    db.prepare(`INSERT INTO activation_decisions
      (decision_id, subject_kind, activation_id, artifact_id, artifact_digest, decision, principal_kind,
       owner_id, policy_version, break_glass_reason, authentication_method, credential_id,
       operator_kind, operator_id, reason_code, note, evidence_snapshot_id, decided_at)
      VALUES ('decision-window-isolation', 'activation', ?, 'artifact-window', 'sha256:artifact-window', 'safety_isolate', 'system_safety',
       NULL, 'safety-policy-v1', NULL, 'system', NULL, NULL, NULL, 'host_liveness_risk', 'window fixture', NULL, ?)`)
      .run(LIVE_ACTIVATION, new Date(Date.now() - 60_000).toISOString());
    conn.close();
  }

  function evaluatedRow(ts: unknown): string {
    return JSON.stringify({
      ts,
      type: 'rulehost_evaluated',
      category: 'evaluated',
      data: {
        toolName: 'write_file',
        filePath: '<redacted>',
        matched: true,
        decision: 'block',
        ruleId: 'rule-window',
        activationId: LIVE_ACTIVATION,
        activationMode: 'live',
      },
    });
  }

  function unhealthyRow(ts: unknown): string {
    return JSON.stringify({
      ts,
      type: 'rulehost_unhealthy',
      category: 'failure',
      data: {
        activationId: LIVE_ACTIVATION,
        artifactId: 'artifact-window',
        ruleId: 'rule-window',
        reason: 'rule_compile_failed',
        nextAction: 'fix the rule',
      },
    });
  }

  it('keeps invalid, empty, null and future timestamps out of every window figure', async () => {
    seedActivation();
    const now = Date.now();
    const logsDir = path.join(workspaceDir, '.state', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'events_2026-08-21.jsonl'), [
      evaluatedRow(new Date(now - 60_000).toISOString()),
      unhealthyRow(new Date(now - 60_000).toISOString()),
      evaluatedRow('not-a-date'),
      evaluatedRow(''),
      evaluatedRow(null),
      evaluatedRow(new Date(now + 60 * 60 * 1000).toISOString()),
      unhealthyRow('garbage'),
      unhealthyRow(new Date(now + 60 * 60 * 1000).toISOString()),
    ].join('\n') + '\n', 'utf8');

    const review = await model.getOwnerReview(LIVE_ACTIVATION);

    for (const window of [review.liveMetrics.last24Hours, review.liveMetrics.last7Days]) {
      expect(window.eligible).toBe(1);
      expect(window.matched).toBe(1);
      expect(window.blocked).toBe(1);
      expect(window.toolDistribution).toEqual({ write_file: 1 });
      // Only the VALID unhealthy row contributes, and it is a real fault row —
      // not a phantom produced by an invalid timestamp.
      expect(window.unhealthy).toBe(1);
      expect(window.unhealthySignatures).toBe(1);
      expect(window.unhealthySignatureStatus).toBe('ok');
      // The safety isolation was recorded inside the window; invalid/future
      // telemetry timestamps do not touch this figure.
      expect(window.circuitTrips).toBe(1);
    }
    // `getOwnerReview` runs the real readiness/recovery probes (CLI
    // subprocesses), which exceed the default 5s budget on a loaded machine.
  }, 20_000);
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

  it('validateActivations drops an enforcement state outside the closed set', () => {
    const validated = validateActivations({ activations: [], status: 'ok', enforcement: { state: 'ok' } });
    expect(validated).not.toBeNull();
    expect(validated?.enforcement).toBeUndefined();
  });

  it('validateActivations drops a non-object enforcement payload', () => {
    const validated = validateActivations({ activations: [], status: 'ok', enforcement: 'unknown' });
    expect(validated).not.toBeNull();
    expect(validated?.enforcement).toBeUndefined();
  });

  it('validateActivations drops an unknown state that carries no explanation', () => {
    // UNKNOWN must stay distinguishable: without an `unreadableReason` the
    // payload is not rendered at all (never coerced into healthy).
    const validated = validateActivations({ activations: [], status: 'ok', enforcement: { state: 'unknown' } });
    expect(validated).not.toBeNull();
    expect(validated?.enforcement).toBeUndefined();
  });
});
