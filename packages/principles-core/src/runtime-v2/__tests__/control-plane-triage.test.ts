import { describe, it, expect } from 'vitest';
import { classifyCanaryFindings } from '../control-plane-triage.js';

interface CanaryCheckInput {
  name: string;
  status: 'healthy' | 'degraded' | 'error';
  summary: string;
  details?: unknown;
  error?: string;
}

interface CanaryOutputInput {
  overallStatus: 'healthy' | 'degraded' | 'error';
  checks: CanaryCheckInput[];
  recommendedNextActions: string[];
  generatedAt: string;
}

function makeCanaryOutput(checks: CanaryCheckInput[]): CanaryOutputInput {
  return {
    overallStatus: checks.some(c => c.status === 'error') ? 'error' : checks.some(c => c.status === 'degraded') ? 'degraded' : 'healthy',
    checks,
    recommendedNextActions: [],
    generatedAt: new Date().toISOString(),
  };
}

describe('classifyCanaryFindings', () => {
  it('classifies schema mismatch with PRI-style repair recommendation', () => {
    const output = makeCanaryOutput([
      { name: 'schema_conformance', status: 'degraded', summary: 'Missing columns', details: { missingColumns: ['trigger_pattern'], migrationsNeeded: ['add_trigger_pattern'] } },
    ]);

    const plan = classifyCanaryFindings(output);

    expect(plan.findings.length).toBeGreaterThan(0);
    const schemaFinding = plan.findings.find(f => f.category === 'schema_mismatch');
    expect(schemaFinding).toBeTruthy();
    if (!schemaFinding) return;
    expect(schemaFinding.severity).toBe('critical');
    expect(schemaFinding.safeFirstRepair).toContain('SqliteConnection');
    expect(schemaFinding.linearIssueTemplate).toContain('Schema Mismatch');
  });

  it('classifies broken shim with sync-plugin verify/install recommendation', () => {
    const output = makeCanaryOutput([
      { name: 'pd_shim_info', status: 'degraded', summary: 'PD CLI not found' },
    ]);

    const plan = classifyCanaryFindings(output);

    const shimFinding = plan.findings.find(f => f.category === 'broken_pd_shim');
    expect(shimFinding).toBeTruthy();
    if (!shimFinding) return;
    expect(shimFinding.severity).toBe('high');
    expect(shimFinding.safeFirstRepair).toContain('sync-plugin');
  });

  it('classifies pruning orphans with dry-run first recommendation', () => {
    const output = makeCanaryOutput([
      { name: 'pruning_orphans', status: 'degraded', summary: '3 orphan candidates found' },
    ]);

    const plan = classifyCanaryFindings(output);

    const pruningFinding = plan.findings.find(f => f.category === 'pruning_orphans_present');
    expect(pruningFinding).toBeTruthy();
    if (!pruningFinding) return;
    expect(pruningFinding.safeFirstRepair).toContain('dry-run');
    expect(pruningFinding.safeFirstRepair.indexOf('dry-run')).toBeLessThan(pruningFinding.safeFirstRepair.indexOf('--confirm'));
  });

  it('classifies internalization broken links with integrity details', () => {
    const output = makeCanaryOutput([
      { name: 'internalization_queue', status: 'degraded', summary: 'Queue blocked', details: { brokenLinks: [{ type: 'missing_dreamer_task', reason: 'No dreamer' }] } },
    ]);

    const plan = classifyCanaryFindings(output);

    const queueFinding = plan.findings.find(f => f.category === 'internalization_queue_blocked');
    expect(queueFinding).toBeTruthy();
    const chainFinding = plan.findings.find(f => f.category === 'internalization_chain_broken');
    expect(chainFinding).toBeTruthy();
    if (!chainFinding) return;
    expect(chainFinding.commandsToVerify.some(c => c.includes('integrity'))).toBe(true);
  });

  it('sorts multiple issues by severity', () => {
    const output = makeCanaryOutput([
      { name: 'pruning_orphans', status: 'degraded', summary: 'Orphans found' },
      { name: 'schema_conformance', status: 'degraded', summary: 'Schema mismatch' },
      { name: 'pd_shim_info', status: 'degraded', summary: 'Shim broken' },
    ]);

    const plan = classifyCanaryFindings(output);

    expect(plan.sortedBySeverity.length).toBeGreaterThanOrEqual(3);
    const severities = plan.sortedBySeverity.map(f => f.severity);
    for (let i = 1; i < severities.length; i++) {
      const prevOrder = { critical: 0, high: 1, medium: 2, low: 3 }[severities[i - 1] as string] ?? 99;
      const currOrder = { critical: 0, high: 1, medium: 2, low: 3 }[severities[i] as string] ?? 99;
      expect(prevOrder).toBeLessThanOrEqual(currOrder);
    }
  });

  it('returns empty findings for healthy canary', () => {
    const output = makeCanaryOutput([
      { name: 'schema_conformance', status: 'healthy', summary: 'OK' },
      { name: 'candidate_audit', status: 'healthy', summary: 'OK' },
    ]);

    const plan = classifyCanaryFindings(output);

    expect(plan.findings.length).toBe(0);
    expect(plan.summary).toContain('No issues');
  });

  it('classifies sqlite_io_error from runtime health error', () => {
    const output = makeCanaryOutput([
      { name: 'runtime_health', status: 'error', summary: 'Failed', error: 'SQLITE_IO: disk I/O error' },
    ]);

    const plan = classifyCanaryFindings(output);

    const ioFinding = plan.findings.find(f => f.category === 'sqlite_io_error');
    expect(ioFinding).toBeTruthy();
    if (!ioFinding) return;
    expect(ioFinding.severity).toBe('critical');
  });

  it('classifies unknown for unrecognized check', () => {
    const output = makeCanaryOutput([
      { name: 'custom_check', status: 'degraded', summary: 'Something wrong' },
    ]);

    const plan = classifyCanaryFindings(output);

    const unknownFinding = plan.findings.find(f => f.category === 'unknown');
    expect(unknownFinding).toBeTruthy();
  });
});
