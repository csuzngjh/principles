import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// REAL v1 writer, resolved to openclaw-plugin source via vitest alias
// (see vitest.config.ts). This is the component that production uses to emit
// rulehost telemetry.
import { EventLog } from 'principles-disciple/event-log';
import { collectRuleCodeEventEntries } from '../../src/server/models/ActivationsConsoleModel.js';

/**
 * PRI-577 round-trip contract test — the regression vaccine.
 *
 * The original bug: the v1 EventLog wrote rulehost_evaluated events under
 * `{workspace}/.state/logs/` while console/CLI readers scanned only
 * `{workspace}/.pd/logs/`. Each side had isolated tests; nothing ever joined
 * them. This test joins them for real:
 *
 *   real EventLog.write → flush to disk → PRI-577 collector read → assert visible
 *
 * If either side drifts (directory convention, filename pattern, line schema),
 * this test fails — regardless of which package owns the change.
 */

const ACTIVATION_ID = 'act_code_roundtrip';

describe('PRI-577 write→read round-trip contract (real EventLog)', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri577-roundtrip-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function makeWriter(): EventLog {
    // Production wiring (openclaw-plugin src/index.ts) passes `.state` as stateDir.
    return new EventLog(path.join(workspaceDir, '.state'), undefined);
  }

  it('events written by the real EventLog are visible to the console collector', () => {
    const eventLog = makeWriter();
    try {
      eventLog.recordRuleHostEvaluated({
        toolName: 'apply_patch',
        filePath: '<tool:apply_patch>',
        matched: true,
        decision: 'block',
        ruleId: 'rule-1',
        activationId: ACTIVATION_ID,
        activationMode: 'shadow',
      });
      eventLog.recordRuleHostEvaluated({
        toolName: 'exec',
        filePath: '<redacted>',
        matched: false,
        decision: 'allow',
        ruleId: 'rule-1',
        activationId: ACTIVATION_ID,
        activationMode: 'shadow',
      });
      eventLog.flush();
    } finally {
      eventLog.dispose();
    }

    // Writer must have landed in legacy .state/logs (v1 contract)
    expect(fs.existsSync(path.join(workspaceDir, '.state', 'logs'))).toBe(true);

    // Reader must see both events through the dual-directory candidate list
    const collected = collectRuleCodeEventEntries(workspaceDir);
    expect(collected.sourceDirsFound).toBeGreaterThanOrEqual(1);

    const evaluated = collected.entries.filter(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null &&
        (e as Record<string, unknown>).type === 'rulehost_evaluated',
    );
    expect(evaluated.length).toBe(2);
    for (const entry of evaluated) {
      const data = entry.data as Record<string, unknown> | undefined;
      expect(data?.activationId).toBe(ACTIVATION_ID);
      expect(data?.activationMode).toBe('shadow');
    }
  });

  it('filename pattern stays compatible with the reader regex', () => {
    const eventLog = makeWriter();
    try {
      eventLog.recordRuleHostEvaluated({
        toolName: 'write_file',
        filePath: 'x',
        matched: false,
        decision: 'allow',
        ruleId: 'r',
        activationId: ACTIVATION_ID,
        activationMode: 'shadow',
      });
      eventLog.flush();
    } finally {
      eventLog.dispose();
    }

    const logsDir = path.join(workspaceDir, '.state', 'logs');
    const files = fs.readdirSync(logsDir);
    // Reader scans /^events_.*\.jsonl$/ — the writer's naming must keep matching.
    const matching = files.filter((f) => /^events_.*\.jsonl$/.test(f));
    expect(matching.length).toBeGreaterThanOrEqual(1);
    expect(matching[0]).toMatch(/^events_\d{4}-\d{2}-\d{2}\.jsonl$/);
  });
});
