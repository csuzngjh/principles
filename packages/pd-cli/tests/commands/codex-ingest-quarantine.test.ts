/**
 * pd codex ingest quarantine command tests (Slice D, SPEC §15).
 *
 * Functional, real-filesystem: seeds a workspace trajectory.db through the
 * production store, then exercises the handler. Proven:
 * - dry run is the DEFAULT: --json reports dryRun=true and the record row is
 *   untouched;
 * - --confirm quarantines (row becomes terminal, bodies dropped);
 * - missing/invalid flags are refused with reason + nextAction, exit 1, and
 *   mutate nothing (cli-5);
 * - --json emits exactly one parseable object (cli-1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { ingestGovernanceObservations, listGovernanceObservations } from '@principles/host-runtime';

let workspaceDir: string;
let corruptRecordId = 0;
let logSpy: ReturnType<typeof vi.spyOn>;
let savedExitCode: number | undefined;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-quarantine-'));
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), '');
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  config.features.codex_conversation_ingestion.enabled = true;
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
  const now = new Date('2026-08-29T12:00:00.000Z');
  const seeded = ingestGovernanceObservations({
    workspaceDir,
    now,
    observations: [
      { hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', rootSessionId: 'root-1', hostTurnId: 't1', kind: 'user_turn', logicalObservationKey: 'codex|rollout-uuid-1|t1|user', source: 'transcript', completeness: 'complete', observedAt: now.toISOString(), recordByteStart: 100, recordOrdinal: 1, visibleText: 'first' },
      { hostKind: 'codex', rolloutIdentity: 'rollout-uuid-1', rootSessionId: 'root-1', hostTurnId: 't2', kind: 'user_turn', logicalObservationKey: 'codex|rollout-uuid-1|t2|user', source: 'transcript', completeness: 'partial', observedAt: now.toISOString(), recordByteStart: 300, recordOrdinal: 3, visibleText: 'corrupt record' },
    ],
  });
  expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
  const listed = listGovernanceObservations({ workspaceDir });
  expect(listed.ok).toBe(true);
  if (!listed.ok) throw new Error('unreachable');
  const corrupt = listed.observations.find((row) => row.logicalKey === 'codex|rollout-uuid-1|t2|user');
  expect(corrupt).toBeDefined();
  corruptRecordId = corrupt.id;

  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  process.exitCode = savedExitCode;
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

function findRecord(): { retentionClass: string; visibleText: string | null } {
  const listed = listGovernanceObservations({ workspaceDir });
  if (!listed.ok) throw new Error('list failed');
  const row = listed.observations.find((entry) => entry.id === corruptRecordId);
  if (!row) throw new Error('record vanished');
  return row;
}

async function run(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { handleCodexIngestQuarantine } = await import('../../src/commands/codex-ingest-quarantine.js');
  const callsBefore = logSpy.mock.calls.length;
  await handleCodexIngestQuarantine({ workspace: workspaceDir, ...options } as never);
  const newOutput = logSpy.mock.calls.slice(callsBefore).map((call) => String(call[0]));
  const jsonLine = newOutput.reverse().find((line) => line.startsWith('{'));
  expect(jsonLine, 'handler must emit exactly one JSON object for --json').toBeDefined();
  return JSON.parse(jsonLine as string) as Record<string, unknown>;
}

describe('pd codex ingest quarantine (functional)', () => {
  it('dry run is the default: reports digest/gap, mutates nothing, exits 0', { timeout: 20_000 }, async () => {
    const report = await run({ rollout: 'rollout-uuid-1', record: String(corruptRecordId), reason: 'stable-invalid', json: true });
    expect(report.status).toBe('ok');
    expect(report.dryRun).toBe(true);
    expect(report.confirmed).toBe(false);
    expect(report.transcriptTouched).toBe(false);
    const record = report.record as { digest: string; gap: string; id: number };
    expect(record.id).toBe(corruptRecordId);
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.gap).toContain('prev=');
    expect(findRecord().retentionClass).toBe('operational');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--confirm quarantines the record; a repeat is idempotent', { timeout: 20_000 }, async () => {
    const report = await run({ rollout: 'rollout-uuid-1', record: String(corruptRecordId), reason: 'stable-invalid', operator: 'tester', confirm: true, json: true });
    expect(report.dryRun).toBe(false);
    expect(report.alreadyQuarantined).toBe(false);
    expect(findRecord().retentionClass).toBe('quarantined');
    expect(findRecord().visibleText).toBeNull();

    const repeat = await run({ rollout: 'rollout-uuid-1', record: String(corruptRecordId), reason: 'stable-invalid', confirm: true, json: true });
    expect(repeat.alreadyQuarantined).toBe(true);
  });

  it('refuses invalid arguments with reason+nextAction and no mutation (cli-5/cli-6)', { timeout: 30_000 }, async () => {
    // Case table is built INSIDE the test so record ids reference the row
    // seeded in beforeEach (an it.each table would evaluate before seeding).
    const cases: [Record<string, unknown>, string][] = [
      [{ reason: 'x' }, 'rollout_required'],
      [{ rollout: 'rollout-uuid-1', reason: 'x' }, 'record_required'],
      [{ rollout: 'rollout-uuid-1', record: 'abc' }, 'record_required'],
      [{ rollout: 'rollout-uuid-1', record: String(corruptRecordId) }, 'reason_required'],
      [{ rollout: 'unknown-rollout', record: String(corruptRecordId), reason: 'x' }, 'rollout_not_found'],
    ];
    for (const [options, expectedReason] of cases) {
      process.exitCode = undefined;
      const report = await run({ ...options, json: true });
      expect(report.status, JSON.stringify({ options, report })).toBe('refused');
      expect(report.reason).toBe(expectedReason);
      expect(String(report.nextAction).length).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
      expect(findRecord().retentionClass, String(expectedReason)).toBe('operational');
    }
  });

  it('text output includes the dry-run next action', { timeout: 20_000 }, async () => {
    const { handleCodexIngestQuarantine } = await import('../../src/commands/codex-ingest-quarantine.js');
    await handleCodexIngestQuarantine({ workspace: workspaceDir, rollout: 'rollout-uuid-1', record: String(corruptRecordId), reason: 'stable-invalid' });
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('dry-run');
    expect(output).toContain('digest:');
    expect(output).toContain('--confirm');
    expect(process.exitCode ?? 0).toBe(0);
  });
});
