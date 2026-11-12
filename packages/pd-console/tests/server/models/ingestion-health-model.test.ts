/**
 * IngestionHealthModel contract (PRI-1171 ticket ⑦).
 *
 * The model executes `pd health --workspace <dir> --json` (CLI = the ONE
 * authority) and passes the `.ingestion` section through verbatim. A fixture
 * CLI entry (cliEntryOverride) emits controlled stdout/exit behavior so each
 * class is tested through the REAL subprocess boundary:
 *   - exit 0 with a report → ok (verbatim fields);
 *   - exit 1 WITH a parseable report → ok (the main report can exit 1 for
 *     OTHER degraded sections after printing the JSON — never misread);
 *   - killed/timeout → unknown (partial stdout is never a report);
 *   - empty / non-JSON / shape-invalid stdout → unknown with rc-9 fields;
 *   - entry resolution failure → unknown with the resolver's reason.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, afterEach } from 'vitest';
import { IngestionHealthModel } from '../../../src/server/models/IngestionHealthModel.js';

let tempDirs: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pd-console-ingest-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function validReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const hostRow = {
    status: 'monitored',
    hostFlag: { state: 'DISABLED', source: 'defaults' },
    ingestionFlag: { state: 'DISABLED', source: 'defaults' },
    consent: { state: 'not_present' },
    checkpoints: { total: 0, lastSuccessAt: null, checkpointOffset: null, lagBytes: null, lagUndetectable: false, incompleteTailCount: 0, lastDegradation: null, sessions: [], truncated: false },
    liveOnly: { sessions: [], truncated: false },
  };
  return {
    generatedAt: '2026-11-12T00:00:00.000Z',
    workspace: '/synthetic/workspace',
    ingestion: { codex: hostRow, workbuddy: hostRow, openclaw: { status: 'not_wired', reason: 'p3', nextAction: 'na' } },
    ...overrides,
  };
}

function writeFixtureCli(scriptBody: string): string {
  const dir = tempDir('cli');
  const entry = path.join(dir, 'fake-pd-cli.cjs');
  fs.writeFileSync(entry, scriptBody, 'utf8');
  return entry;
}

describe('IngestionHealthModel (CLI authority passthrough)', () => {
  it('returns the section verbatim on exit 0', async () => {
    const report = validReport();
    const entry = writeFixtureCli(`process.stdout.write(JSON.stringify(${JSON.stringify(report)})); process.exit(0);`);
    const result = await new IngestionHealthModel('/synthetic/workspace', entry).collect();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.snapshot.generatedAt).toBe('2026-11-12T00:00:00.000Z');
    expect(result.snapshot.ingestion.openclaw).toMatchObject({ status: 'not_wired', reason: 'p3' });
    expect(result.snapshot.ingestion.codex).toMatchObject({ status: 'monitored' });
  });

  it('accepts a parseable report on exit 1 (other sections may degrade the main report)', async () => {
    const report = validReport();
    const entry = writeFixtureCli(`process.stdout.write(JSON.stringify(${JSON.stringify(report)})); process.exit(1);`);
    const result = await new IngestionHealthModel('/synthetic/workspace', entry).collect();
    expect(result.status).toBe('ok');
  });

  it('degrades on killed/timeout subprocesses even when stdout carried bytes', async () => {
    const report = validReport();
    const entry = writeFixtureCli([
      `process.stdout.write(JSON.stringify(${JSON.stringify(report)}));`,
      'setTimeout(() => { process.exit(0); }, 5000);',
    ].join('\n'));
    const result = await new IngestionHealthModel('/synthetic/workspace', entry, { execTimeoutMs: 120 }).collect();
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') return;
    expect(result.reason).toBe('health_collection_failed');
    expect(result.nextAction).toContain('pd health');
    expect(result.productClaim).toBe('degraded');
  });

  it('degrades on empty stdout and on non-JSON output (rc-9, never fake-healthy)', async () => {
    const empty = await new IngestionHealthModel('/synthetic/workspace', writeFixtureCli('process.exit(0);')).collect();
    expect(empty.status).toBe('unknown');
    const garbage = await new IngestionHealthModel('/synthetic/workspace', writeFixtureCli('process.stdout.write("not json"); process.exit(0);')).collect();
    expect(garbage.status).toBe('unknown');
    if (garbage.status === 'unknown') expect(garbage.reason).toBe('health_report_unparseable');
  });

  it('degrades when the report shape is invalid (missing host row / bad flag enum)', async () => {
    const missingHost = validReport();
    delete (missingHost.ingestion as Record<string, unknown>).workbuddy;
    const a = await new IngestionHealthModel('/synthetic/workspace', writeFixtureCli(`process.stdout.write(JSON.stringify(${JSON.stringify(missingHost)})); process.exit(0);`)).collect();
    expect(a.status).toBe('unknown');
    const badRow = validReport();
    (badRow.ingestion as Record<string, unknown>).codex = { status: 'monitoring' };
    const b = await new IngestionHealthModel('/synthetic/workspace', writeFixtureCli(`process.stdout.write(JSON.stringify(${JSON.stringify(badRow)})); process.exit(0);`)).collect();
    expect(b.status).toBe('unknown');
  });

  it('rejects a monitored row whose flag is an empty object (structured unknown, not client unreachable)', async () => {
    const report = validReport();
    const ingestion = report.ingestion as Record<string, unknown>;
    ingestion.codex = { ...(ingestion.codex as Record<string, unknown>), hostFlag: {} };
    const result = await new IngestionHealthModel('/synthetic/workspace', writeFixtureCli(`process.stdout.write(JSON.stringify(${JSON.stringify(report)})); process.exit(0);`)).collect();
    expect(result.status).toBe('unknown');
    if (result.status === 'unknown') expect(result.reason).toBe('health_report_unparseable');
  });

  it('rejects a monitored row whose checkpoint summary is a bare object', async () => {
    const report = validReport();
    const ingestion = report.ingestion as Record<string, unknown>;
    ingestion.workbuddy = { ...(ingestion.workbuddy as Record<string, unknown>), checkpoints: {} };
    const result = await new IngestionHealthModel('/synthetic/workspace', writeFixtureCli(`process.stdout.write(JSON.stringify(${JSON.stringify(report)})); process.exit(0);`)).collect();
    expect(result.status).toBe('unknown');
  });

  it('does not duplicate the manual-run nextAction on an unparseable report', async () => {
    const garbage = await new IngestionHealthModel('/synthetic/workspace', writeFixtureCli('process.stdout.write("not json"); process.exit(0);')).collect();
    if (garbage.status !== 'unknown') throw new Error('expected unknown');
    expect(garbage.nextAction.split('Run `pd health').length - 1).toBe(1);
  });
});
