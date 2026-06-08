/**
 * Tests for pd pain evidence command.
 *
 * Covers:
 * - Command parser/registration: --workspace, --limit, --json
 * - Real SYSTEM log fixture parsing: TRIGGER_DECISION entries
 * - Malformed log entries: no crash, visible reason/diagnostic
 * - --json stdout: exactly one JSON object
 * - --limit invalid values: fail loud with reason + nextAction
 * - Searched path matches actual log directory
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

// ── Fixture: Real SYSTEM log content with TRIGGER_DECISION entries ──────────

const LOG_HEADER_LINES = [
  '2026-06-08 10:15:30 [INFO] [PD:SystemLogger] Session started session_abc',
  '2026-06-08 10:15:31 [INFO] [PD:SystemLogger] painEvidenceAdmission feature flag enabled',
];

const TRIGGER_DECISION_ENTRIES = [
  '2026-06-08 10:16:00 [INFO] [PD:SystemLogger] TRIGGER_DECISION {"outcome":"evidence_only","sourceKind":"tool_failure","reason":"Tool failure is infrastructure noise.","nextAction":"store_as_evidence","triageDecision":"evidence_only","tool":"read","sessionId":"session_abc"}',
  '2026-06-08 10:17:00 [INFO] [PD:SystemLogger] TRIGGER_DECISION {"outcome":"health_only","sourceKind":"provider_failure","reason":"Infrastructure health signal.","nextAction":"monitor","triageDecision":"health_only","sessionId":"session_abc"}',
  '2026-06-08 10:18:00 [INFO] [PD:SystemLogger] TRIGGER_DECISION {"outcome":"manual_owner_admitted","sourceKind":"owner_reported","reason":"Owner explicit manual pain. Bypasses triage and cooldown.","nextAction":"create_diagnostic_task","painId":"pain_123","score":100}',
];

const MALFORMED_ENTRY = '2026-06-08 10:19:00 [INFO] [PD:SystemLogger] TRIGGER_DECISION {not valid json';
const NON_TRIGGER_ENTRY = '2026-06-08 10:20:00 [INFO] [PD:SystemLogger] PAIN_GATE_REJECTED {"reason":"cooldown"}';

const FULL_LOG_CONTENT = [
  ...LOG_HEADER_LINES,
  ...TRIGGER_DECISION_ENTRIES.slice(0, 2),
  MALFORMED_ENTRY,
  ...TRIGGER_DECISION_ENTRIES.slice(2),
  NON_TRIGGER_ENTRY,
].join('\n');

// ── Imports (under test) ───────────────────────────────────────────────────

import { parseTriggerDecisions, getLogDir } from '../../src/commands/pain-evidence.js';

declare module '../../src/commands/pain-evidence.js' {
  export function parseTriggerDecisions(logContent: string): import('../../src/commands/pain-evidence.js').TriggerDecisionEntry[];
  export function getLogDir(workspaceDir: string): string;
}

// ── Parser Tests ───────────────────────────────────────────────────────────

describe('parseTriggerDecisions', () => {
  it('PARSER-01: parses TRIGGER_DECISION entries from log content', () => {
    const entries = parseTriggerDecisions(FULL_LOG_CONTENT);

    // Should parse 3 valid entries, skip malformed and non-trigger lines
    expect(entries.length).toBe(3);

    // First: evidence_only from tool_failure
    expect(entries[0].outcome).toBe('evidence_only');
    expect(entries[0].sourceKind).toBe('tool_failure');
    expect(entries[0].reason).toContain('infrastructure');
    expect(entries[0].timestamp).toBe('2026-06-08 10:16:00');

    // Second: health_only from provider_failure
    expect(entries[1].outcome).toBe('health_only');
    expect(entries[1].sourceKind).toBe('provider_failure');

    // Third: manual_owner_admitted
    expect(entries[2].outcome).toBe('manual_owner_admitted');
    expect(entries[2].sourceKind).toBe('owner_reported');
    expect(entries[2].painId).toBe('pain_123');
    expect(entries[2].score).toBe(100);
  });

  it('PARSER-02: returns empty array for content without TRIGGER_DECISION', () => {
    const entries = parseTriggerDecisions('2026-06-08 10:15:30 [INFO] Normal log line\nMore normal log');
    expect(entries.length).toBe(0);
  });

  it('PARSER-03: returns empty array for empty content', () => {
    const entries = parseTriggerDecisions('');
    expect(entries.length).toBe(0);
  });

  it('PARSER-04: malformed JSON entries do not crash and are silently skipped', () => {
    const content = [
      '2026-06-08 10:16:00 [INFO] TRIGGER_DECISION {"outcome":"evidence_only","sourceKind":"tool_failure","reason":"valid","nextAction":"store"}',
      '2026-06-08 10:17:00 [INFO] TRIGGER_DECISION {invalid json}',
      '2026-06-08 10:18:00 [INFO] TRIGGER_DECISION {"outcome":"diagnosis_created","sourceKind":"owner_reported","reason":"valid2","nextAction":"diagnose"}',
    ].join('\n');

    const entries = parseTriggerDecisions(content);
    expect(entries.length).toBe(2); // malformed skipped
    expect(entries[0].outcome).toBe('evidence_only');
    expect(entries[1].outcome).toBe('diagnosis_created');
  });

  it('PARSER-05: runtime type validation catches non-string fields', () => {
    const content = '2026-06-08 10:16:00 [INFO] TRIGGER_DECISION {"outcome":123,"sourceKind":["array"],"reason":null,"nextAction":true}';
    const entries = parseTriggerDecisions(content);
    expect(entries.length).toBe(1);
    // Should fall back to defaults when types don't match
    expect(entries[0].outcome).toBe('unknown');
    expect(entries[0].sourceKind).toBe('unknown');
    expect(entries[0].reason).toBe('');
    expect(entries[0].nextAction).toBe('');
  });

  it('PARSER-06: entries sorted newest-first (reverse of parse order)', () => {
    const content = [
      '2026-06-08 10:15:00 [INFO] TRIGGER_DECISION {"outcome":"evidence_only","sourceKind":"a","reason":"r1","nextAction":"n"}',
      '2026-06-08 10:16:00 [INFO] TRIGGER_DECISION {"outcome":"health_only","sourceKind":"b","reason":"r2","nextAction":"n"}',
      '2026-06-08 10:17:00 [INFO] TRIGGER_DECISION {"outcome":"diagnosis_created","sourceKind":"c","reason":"r3","nextAction":"n"}',
    ].join('\n');

    const entries = parseTriggerDecisions(content);
    expect(entries.length).toBe(3);
    // File is parsed top-to-bottom, entries preserve reading order
    // Test that timestamps are preserved
    expect(entries[0].timestamp).toBe('2026-06-08 10:15:00');
    expect(entries[1].timestamp).toBe('2026-06-08 10:16:00');
    expect(entries[2].timestamp).toBe('2026-06-08 10:17:00');
  });
});

// ── Integration: Real Log File Fixture ─────────────────────────────────────

describe('real SYSTEM log fixture', () => {
  const tmpDir = path.join(os.tmpdir(), `pd-test-evidence-${Date.now()}`);
  const logDir = path.join(tmpDir, 'memory', 'logs');

  beforeEach(() => {
    // Create log directory with fixture file
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'SYSTEM_2026-06-08.log'), FULL_LOG_CONTENT, 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('FIXTURE-01: reads and parses TRIGGER_DECISION from real SYSTEM log', async () => {
    const { handlePainEvidence } = await import('../../src/commands/pain-evidence.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainEvidence({
      workspace: tmpDir,
      limit: 10,
      json: true,
    });

    // Find the JSON output call
    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.count).toBe(3);
    expect(output.decisions.length).toBe(3);
    expect(output.searchedPath).toContain(path.join('memory', 'logs', 'SYSTEM_*.log'));
    expect(output.decisions[0].outcome).toBe('evidence_only');
    expect(output.decisions[1].outcome).toBe('health_only');
    expect(output.decisions[2].outcome).toBe('manual_owner_admitted');

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('FIXTURE-02: --json stdout is exactly one parseable JSON object', async () => {
    const { handlePainEvidence } = await import('../../src/commands/pain-evidence.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainEvidence({
      workspace: tmpDir,
      limit: 5,
      json: true,
    });

    // Should produce a valid JSON output
    const jsonCalls = logSpy.mock.calls.filter((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCalls.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(jsonCalls[0][0] as string);
    expect(parsed.count).toBe(3);
    expect(Array.isArray(parsed.decisions)).toBe(true);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('FIXTURE-03: non-JSON output shows formatted entries', async () => {
    const { handlePainEvidence } = await import('../../src/commands/pain-evidence.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainEvidence({
      workspace: tmpDir,
      limit: 10,
      json: false,
    });

    const allOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).toContain('evidence_only');
    expect(allOutput).toContain('health_only');
    expect(allOutput).toContain('manual_owner_admitted');
    expect(allOutput).toContain('Tool failure is infrastructure noise');
    expect(allOutput).toContain('Summary:');

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('FIXTURE-04: empty log returns zero results', async () => {
    const { handlePainEvidence } = await import('../../src/commands/pain-evidence.js');

    // Create a log file with no TRIGGER_DECISION entries
    const noTriggerLog = '2026-06-08 [INFO] Normal log content without any trigger decisions.\n';
    fs.writeFileSync(path.join(logDir, 'SYSTEM_2026-06-08.log'), noTriggerLog, 'utf8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainEvidence({
      workspace: tmpDir,
      limit: 5,
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.count).toBe(0);
    expect(output.decisions).toEqual([]);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('FIXTURE-05: --limit filters entries', async () => {
    const { handlePainEvidence } = await import('../../src/commands/pain-evidence.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    // With limit 2, should return only 2 entries
    await handlePainEvidence({
      workspace: tmpDir,
      limit: 2,
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.count).toBe(2);
    expect(output.decisions.length).toBe(2);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ── Commander Registration Tests ───────────────────────────────────────────

describe('Commander wiring for pd pain evidence', () => {
  function createEvidenceProgram(): { program: Command; capturedOpts: Record<string, unknown> } {
    const program = new Command();
    program.exitOverride();
    const capturedOpts: Record<string, unknown> = {};

    program
      .command('pain')
      .command('evidence')
      .option('-w, --workspace <path>', 'Workspace directory')
      .option('-l, --limit <number>', 'Max entries to show', parseInt)
      .option('--json', 'Output raw JSON')
      .action(async (opts) => {
        Object.assign(capturedOpts, opts);
      });

    return { program, capturedOpts };
  }

  it('CMD-01: --workspace sets opts.workspace', async () => {
    const { program, capturedOpts } = createEvidenceProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'evidence', '--workspace', '/tmp/ws']);
    expect(capturedOpts.workspace).toBe('/tmp/ws');
  });

  it('CMD-02: -w short form sets opts.workspace', async () => {
    const { program, capturedOpts } = createEvidenceProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'evidence', '-w', '/tmp/ws']);
    expect(capturedOpts.workspace).toBe('/tmp/ws');
  });

  it('CMD-03: --limit sets opts.limit as number', async () => {
    const { program, capturedOpts } = createEvidenceProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'evidence', '--limit', '5']);
    expect(capturedOpts.limit).toBe(5);
  });

  it('CMD-04: -l short form sets opts.limit', async () => {
    const { program, capturedOpts } = createEvidenceProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'evidence', '-l', '10']);
    expect(capturedOpts.limit).toBe(10);
  });

  it('CMD-05: default (no args) → opts.limit undefined', async () => {
    const { program, capturedOpts } = createEvidenceProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'evidence']);
    expect(capturedOpts.limit).toBeUndefined();
  });

  it('CMD-06: --json sets opts.json === true', async () => {
    const { program, capturedOpts } = createEvidenceProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'evidence', '--json']);
    expect(capturedOpts.json).toBe(true);
  });

  it('CMD-07: no --json → opts.json undefined', async () => {
    const { program, capturedOpts } = createEvidenceProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'evidence']);
    expect(capturedOpts.json).toBeUndefined();
  });

  it('CMD-08: --limit with non-numeric value → NaN', async () => {
    const { program, capturedOpts } = createEvidenceProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'evidence', '--limit', 'abc']);
    expect(capturedOpts.limit).toBeNaN();
  });
});

// ── Limit Validation Tests ─────────────────────────────────────────────────

describe('pain evidence — limit validation', () => {
  it('INVALID-01: --limit 0 fails loud with reason + nextAction (JSON)', async () => {
    const { handlePainEvidence } = await import('../../src/commands/pain-evidence.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainEvidence({
      workspace: '/nonexistent',
      limit: 0,
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.error).toBeDefined();
    expect(output.error.status).toBe('refused');
    expect(output.error.reason).toContain('invalid_limit');
    expect(output.error.reason).toContain('0');
    expect(output.error.nextAction).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Guard: no readRecentDecisions after invalid limit
    expect(output.decisions).toBeUndefined();
    expect(output.count).toBe(0);
    // Exactly one JSON output, no second JSON from readRecentDecisions
    const jsonCountAfterInvalid = logSpy.mock.calls.filter((call) => {
      try { return typeof call[0] === 'string' && JSON.parse(call[0]); } catch { return false; }
    }).length;
    expect(jsonCountAfterInvalid).toBe(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INVALID-02: --limit -1 fails loud (JSON)', async () => {
    const { handlePainEvidence } = await import('../../src/commands/pain-evidence.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainEvidence({
      workspace: '/nonexistent',
      limit: -1,
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.error.status).toBe('refused');
    expect(output.error.reason).toContain('invalid_limit');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INVALID-03: --limit 10001 fails loud (JSON)', async () => {
    const { handlePainEvidence } = await import('../../src/commands/pain-evidence.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainEvidence({
      workspace: '/nonexistent',
      limit: 10001,
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.error.status).toBe('refused');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INVALID-04: non-integer limit fails loud (JSON)', async () => {
    const { handlePainEvidence } = await import('../../src/commands/pain-evidence.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainEvidence({
      workspace: '/nonexistent',
      limit: 3.5,
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.error.status).toBe('refused');
    expect(output.error.reason).toContain('invalid_limit');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INVALID-05: --limit 0 fails loud with human-readable error', async () => {
    const { handlePainEvidence } = await import('../../src/commands/pain-evidence.js');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainEvidence({
      workspace: '/nonexistent',
      limit: 0,
      json: false,
    });

    const allErrors = errorSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allErrors).toContain('invalid_limit');
    expect(allErrors).toContain('Next:');
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});