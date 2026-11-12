/**
 * validateIngestionHealth contract (PRI-1171 ticket ⑦, review round 1): the
 * route sends the MODEL's result shape — { status:'ok', snapshot:{
 * generatedAt, workspace, ingestion } } — so the validator MUST read the
 * snapshot level. These pins also cover the tightened host-row contract
 * (missing monitored-row fields reject instead of surviving to the page).
 */
import { describe, expect, it } from 'vitest';
import { validateIngestionHealth, type IngestionHealthResultData } from '../../src/ui/utils/validators.js';

function validSnapshotReport(): Record<string, unknown> {
  const hostRow = {
    status: 'monitored',
    hostFlag: { state: 'DISABLED', source: 'defaults' },
    ingestionFlag: { state: 'DISABLED', source: 'defaults' },
    consent: { state: 'not_present' },
    checkpoints: { total: 1, lastSuccessAt: '2026-11-12T00:00:00.000Z', checkpointOffset: 100, lagBytes: 40, lagUndetectable: false, incompleteTailCount: 0, lastDegradation: null, sessions: [], truncated: false },
    liveOnly: { sessions: [], truncated: false },
  };
  return {
    status: 'ok',
    snapshot: {
      generatedAt: '2026-11-12T00:00:00.000Z',
      workspace: '/synthetic/workspace',
      ingestion: { codex: hostRow, workbuddy: hostRow, openclaw: { status: 'not_wired', reason: 'p3', nextAction: 'na' } },
    },
  };
}

describe('validateIngestionHealth (route payload shape)', () => {
  it('accepts the route success shape (fields under snapshot)', () => {
    const validated = validateIngestionHealth(validSnapshotReport());
    expect(validated).not.toBeNull();
    expect(validated?.status).toBe('ok');
    expect(validated?.ingestion?.openclaw).toMatchObject({ status: 'not_wired' });
    expect(validated?.ingestion?.codex).toMatchObject({ status: 'monitored' });
    const data: IngestionHealthResultData | null = validated;
    expect(data).not.toBeNull();
  });

  it('rejects the OLD top-level shape (fields without snapshot)', () => {
    const report = validSnapshotReport();
    const flattened = { ...(report.snapshot as Record<string, unknown>), status: 'ok' };
    expect(validateIngestionHealth(flattened)).toBeNull();
  });

  it('accepts the structured unknown block', () => {
    expect(validateIngestionHealth({ status: 'unknown', reason: 'health_collection_failed', nextAction: 'run manually' })).toMatchObject({ status: 'unknown' });
  });

  it('rejects a monitored host row missing page fields (degrades instead of half-rendering)', () => {
    const report = validSnapshotReport();
    const bare = (report.snapshot as Record<string, unknown>).ingestion as Record<string, unknown>;
    bare.codex = { status: 'monitored' };
    expect(validateIngestionHealth(report)).toBeNull();
  });

  it('rejects a checkpoint summary whose incompleteTailCount is missing (unavailable ≠ confirmed zero)', () => {
    const report = validSnapshotReport();
    const codex = ((report.snapshot as Record<string, unknown>).ingestion as Record<string, unknown>).codex as Record<string, unknown>;
    const checkpoints = codex.checkpoints as Record<string, unknown>;
    delete checkpoints.incompleteTailCount;
    expect(validateIngestionHealth(report)).toBeNull();
  });

  it('rejects a checkpoint summary with a degraded shape carrying no total', () => {
    const report = validSnapshotReport();
    const workbuddy = ((report.snapshot as Record<string, unknown>).ingestion as Record<string, unknown>).workbuddy as Record<string, unknown>;
    workbuddy.checkpoints = { reason: 'x', nextAction: 'y' };
    expect(validateIngestionHealth(report)).not.toBeNull(); // degraded branch stays valid
  });

  it('preserves config-loader diagnostics on an UNKNOWN flag (Console side, rc-9)', () => {
    const report = validSnapshotReport();
    const codex = ((report.snapshot as Record<string, unknown>).ingestion as Record<string, unknown>).codex as Record<string, unknown>;
    codex.hostFlag = {
      state: 'UNKNOWN', source: 'malformed',
      reason: 'YAML parse error in .pd/config.yaml', nextAction: 'Fix YAML syntax',
    };
    const validated = validateIngestionHealth(report);
    expect(validated?.ingestion?.codex).toMatchObject({
      hostFlag: {
        state: 'UNKNOWN',
        reason: 'YAML parse error in .pd/config.yaml',
        nextAction: 'Fix YAML syntax',
      },
    });
  });

  it('preserves the structured lag-undetectable reason from the CLI authority', () => {
    const report = validSnapshotReport();
    const codex = ((report.snapshot as Record<string, unknown>).ingestion as Record<string, unknown>).codex as Record<string, unknown>;
    const checkpoints = codex.checkpoints as Record<string, unknown>;
    checkpoints.lagUndetectable = true;
    checkpoints.lagUndetectableReason = 'consent_not_granted';
    expect(validateIngestionHealth(report)?.ingestion?.codex).toMatchObject({
      checkpoints: { lagUndetectableReason: 'consent_not_granted' },
    });
  });

  it('rejects a non-string lag-undetectable reason', () => {
    const report = validSnapshotReport();
    const codex = ((report.snapshot as Record<string, unknown>).ingestion as Record<string, unknown>).codex as Record<string, unknown>;
    (codex.checkpoints as Record<string, unknown>).lagUndetectableReason = { why: 'bad' };
    expect(validateIngestionHealth(report)).toBeNull();
  });

  it('rejects a non-string flag diagnostic instead of half-rendering it', () => {
    const report = validSnapshotReport();
    const codex = ((report.snapshot as Record<string, unknown>).ingestion as Record<string, unknown>).codex as Record<string, unknown>;
    codex.hostFlag = { state: 'UNKNOWN', source: 'malformed', reason: 42 };
    expect(validateIngestionHealth(report)).toBeNull();
  });
});
