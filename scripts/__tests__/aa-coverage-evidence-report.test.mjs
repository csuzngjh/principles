// Real report-entry tests for PRI-1115. Every fixture is synthetic and is
// marked with a FIXTURE id; no synthetic row is mixed into the committed report.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'dev', 'principle-learning-lab', 'summarize-aa-evidence.mjs');
const TMP = path.join(ROOT, '.tmp', `pri-1115-tests-${process.pid}`);

const FIXTURE_LINKAGE = 'FIXTURE-PRI-1115-LINKAGE';
const FIXTURE_RUN = 'FIXTURE-PRI-1115-RUN';

function linkageFixture(overrides = {}) {
  const base = {
    schemaVersion: 'pd-aa-behavior-linkage/v1',
    requirementId: FIXTURE_LINKAGE,
    request: { workspaceDir: '/fixture/workspace', host: 'openclaw' },
    coverage: {
      complete: true,
      window: { start: '2026-11-06T12:00:00.000Z', end: '2026-11-06T14:00:00.000Z' },
      journal: { complete: true, truncatedFiles: 0 },
      eventLog: { truncated: false },
      trajectory: { truncated: false },
    },
    totals: { interventions: 1, invocations: 1 },
    invocations: [{
      intervention: {
        hookInvocationId: 'hook-fixture-1',
        runId: 'host-run-fixture-1',
        sessionId: 'session-fixture-1',
        configIdentity: {
          hostVersion: 'unknown',
          pluginVersion: 'fixture-plugin',
          effectiveHookSetFingerprint: 'fixture-fingerprint',
          evidenceCoverage: 'partial',
        },
      },
      association: 'strong_run',
      evidenceLayers: { requestAssociation: 'unknown', principleAdherence: 'unknown' },
      facts: { actions: [{ toolName: 'read', ordering: 'unknown' }] },
    }],
  };
  return deepMerge(base, overrides);
}

function budgetFixture(overrides = {}) {
  return {
    schemaVersion: 'pd-aa-budget-ledger/v1',
    requirementId: 'FIXTURE-PRI-1115-BUDGET',
    budget: { hostTurns: 4, httpRequests: 5, toolCalls: 2, paidCalls: 0 },
    used: { hostTurns: 3, httpRequests: 4, toolCalls: 2, paidCalls: 0 },
    armBudgets: { positive: { hostTurns: 2, httpRequests: 3, toolCalls: 1, paidCalls: 0 } },
    ...overrides,
  };
}

function runFixture(overrides = {}) {
  const base = {
    schemaVersion: 'pd-aa-controlled-admission-run/v1',
    fixtureId: FIXTURE_RUN,
    runId: 'aa-run-fixture-1',
    attempt: { used: { hostTurns: 1, httpRequests: 2, toolCalls: 1, paidCalls: 0 } },
    used: { hostTurns: 3, httpRequests: 4, toolCalls: 2, paidCalls: 0 },
    positiveGate: {
      ok: false,
      deliveryPath: 'controlled',
      nativeDeliveryObserved: false,
      checks: [
        { id: 'admission-consumed', status: 'PASS', evidence: { consumedBy: { runId: 'host-run-fixture-1', sessionId: 'session-fixture-1' } } },
        { id: 'admission-identity', status: 'FAIL' },
        { id: 'target-body', status: 'PASS' },
        { id: 'tool-invocation', status: 'FAIL' },
      ],
      failures: [{ id: 'tool-invocation', status: 'FAIL' }, { id: 'admission-identity', status: 'FAIL' }],
    },
    controlGate: null,
    httpRequests: [
      { id: 'http-fixture-0', runId: 'aa-run-fixture-0', userMessageSha256: 'a'.repeat(64) },
      { id: 'http-fixture-1', runId: 'aa-run-fixture-1', userMessageSha256: 'b'.repeat(64) },
    ],
    toolCalls: [
      { id: 'tool-fixture-0', runId: 'aa-run-fixture-0' },
      { id: 'tool-fixture-1', runId: 'aa-run-fixture-1' },
    ],
    hostTurns: [
      { id: 'turn-fixture-0', runId: 'aa-run-fixture-0' },
      { id: 'turn-fixture-1', runId: 'aa-run-fixture-1' },
    ],
  };
  return deepMerge(base, overrides);
}

function planFixture(overrides = {}) {
  return { runId: 'aa-run-fixture-1', inputSha256: 'c'.repeat(64), ...overrides };
}

function reevaluationFixture(overrides = {}) {
  return {
    schemaVersion: 'pd-aa-offline-reevaluation/v1',
    fixtureId: 'FIXTURE-PRI-1115-REEVAL',
    sourceRun: 'aa-run-fixture-1',
    generatedAt: '2026-11-06T14:30:00.000Z',
    recordedVerdict: { ok: false },
    correctedGateVerdict: { ok: true },
    knownGateDefectsFixedAfterTheRun: [{ id: 'tool-invocation' }, { id: 'admission-identity' }],
    ...overrides,
  };
}

function pollutionFixture(overrides = {}) {
  return {
    schemaVersion: 'pd-aa-prod-audit/v4',
    fixtureId: 'FIXTURE-PRI-1115-POLLUTION',
    incidentWindow: { from: '2026-11-06T10:05:00.000Z', to: '2026-11-06T11:00:00.000Z' },
    excluded: {
      principle_applications: { count: 1 },
      intervention_evidence_records: { count: 1 },
      intervention_capability_declarations: { count: 6 },
    },
    retained: {
      intervention_capability_declarations: {
        count: 6,
        declaredAtValues: ['2026-11-06T12:06:27.182Z'],
        rowsInIncidentBoundary: 0,
        rowids: [1, 2, 3, 4, 5, 6],
      },
    },
    classificationModel: {
      declarations: [
        { rowid: 1, declaredAt: '2026-11-06T10:05:35.929Z', classification: 'incident_snapshot' },
        { rowid: 1, declaredAt: '2026-11-06T12:06:27.182Z', classification: 'legitimate_live' },
      ],
    },
    ...overrides,
  };
}

function deepMerge(base, overrides) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) return overrides;
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
      && base[key] !== null && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? deepMerge(base[key], value) : value;
  }
  return merged;
}

let caseCounter = 0;
function writeCase(name, files) {
  const dir = path.join(TMP, `${caseCounter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const written = {};
  for (const [role, value] of Object.entries(files)) {
    const file = path.join(dir, `${role}.json`);
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    written[role] = file;
  }
  return { dir, files: written };
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT });
}

function baseArgs(files) {
  const args = [
    '--linkage', files.linkage,
    '--budget', files.budget,
    '--run-record', files.run_record ?? files.runRecord,
  ];
  if (files.offline_reevaluation) args.push('--offline-reevaluation', files.offline_reevaluation);
  if (files.plan) args.push('--plan', files.plan);
  if (files.pollution_audit) args.push('--pollution-audit', files.pollution_audit);
  return args;
}

function parse(result) {
  return JSON.parse(result.stdout);
}

beforeAll(() => fs.mkdirSync(TMP, { recursive: true }));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('PRI-1115 AA coverage report entry', () => {
  it('reuses the existing statistician and reports T/V/O/D as unknown without a census', () => {
    const { files } = writeCase('happy', {
      linkage: linkageFixture(),
      budget: budgetFixture(),
      run_record: runFixture(),
      offline_reevaluation: reevaluationFixture(),
      plan: planFixture(),
      pollution_audit: pollutionFixture(),
    });
    const result = runCli(baseArgs(files));
    expect(result.status).toBe(0);
    const json = parse(result);
    expect(json.ok).toBe(true);
    expect(json.schemaVersion).toBe('pd-aa-coverage-summary/v1');
    expect(json.units.runs.observed).toBe(1);
    expect(json.units.calls.observed).toBe(1);
    expect(json.units.decisionOpportunities.state).toBe('unknown');
    expect(json.units.experimentAttempts.observed).toBe(1);
    expect(json.coverageInterpretation.T.state).toBe('unknown');
    expect(json.coverageInterpretation.D.state).toBe('unknown');
    expect(json.coverageInterpretation.benefit.state).toBe('not_evaluated');
    expect(json.fieldMapping.length).toBeGreaterThan(10);
    expect(json.coverageGuards.associationUsedAsCoverage).toBe(false);
    expect(json.coverage.counts.D.confirmed).toBe(0);
    expect(json.provenance.linkage[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not count historical tool calls in the current run', () => {
    const { files } = writeCase('historical', {
      linkage: linkageFixture(),
      budget: budgetFixture({ used: { hostTurns: 3, httpRequests: 4, toolCalls: 2, paidCalls: 0 } }),
      run_record: runFixture(),
    });
    const json = parse(runCli(baseArgs(files)));
    expect(json.runs[0].cost.currentRun.toolCalls).toBe(1);
    expect(json.runs[0].cost.historicalRecordsExcluded.toolCalls).toBe(1);
    expect(json.runs[0].cost.historicalRecordsExcluded.httpRequests).toBe(1);
    expect(json.budget.used.toolCalls).toBe(2);
    expect(json.units.runs.observed).toBe(1);
  });

  it('de-duplicates identical evidence inputs instead of double counting', () => {
    const { files } = writeCase('duplicate', {
      linkage: linkageFixture(),
      budget: budgetFixture(),
      run_record: runFixture(),
    });
    const args = [
      '--linkage', files.linkage, '--linkage', files.linkage,
      '--budget', files.budget,
      '--run-record', files.run_record, '--run-record', files.run_record,
    ];
    const json = parse(runCli(args));
    expect(json.units.calls.observed).toBe(1);
    expect(json.units.runs.observed).toBe(1);
    expect(json.duplicates.linkage).toBe(1);
    expect(json.duplicates.runRecords).toBe(1);
  });

  it('never treats native delivery with rejected controlled admission as controlled success', () => {
    const { files } = writeCase('native', {
      linkage: linkageFixture(),
      budget: budgetFixture(),
      run_record: runFixture({
        positiveGate: {
          ok: true,
          deliveryPath: 'native_not_controlled',
          nativeDeliveryObserved: true,
          checks: [
            { id: 'admission-consumed', status: 'FAIL' },
            { id: 'target-body', status: 'PASS' },
          ],
          failures: [],
        },
      }),
    });
    const json = parse(runCli(baseArgs(files)));
    expect(json.runs[0].deliveryPath).toBe('native_not_controlled');
    expect(json.runs[0].controlledFacts.admissionConsumed).toBe('not_verified');
    expect(json.runs[0].controlledFacts.controlledInstrumentationProven).toBe(false);
    expect(json.runs[0].controlledFacts.nativeDeliveryIsNotControlledSuccess).toBe(true);
    expect(json.units.experimentAttempts.succeeded).toBe(0);
  });

  it('keeps the recorded failure alongside a corrected offline replay', () => {
    const { files } = writeCase('coexist', {
      linkage: linkageFixture(),
      budget: budgetFixture(),
      run_record: runFixture(),
      offline_reevaluation: reevaluationFixture(),
    });
    const json = parse(runCli(baseArgs(files)));
    expect(json.runs[0].originalVerdict.ok).toBe(false);
    expect(json.runs[0].offlineReevaluation.state).toBe('present');
    expect(json.runs[0].offlineReevaluation.correctedGateOk).toBe(true);
    expect(json.runs[0].offlineReevaluation.affectsOriginalVerdict).toBe(false);
    expect(json.runs[0].offlineReevaluation.knownDefectsFixedAfterTheRun.map((item) => item.id))
      .toEqual(['tool-invocation', 'admission-identity']);
    expect(json.units.experimentAttempts.succeeded).toBe(0);
  });

  it('does not upgrade D from strong_run without timely ordering evidence', () => {
    const { files } = writeCase('strong-run', {
      linkage: linkageFixture(),
      budget: budgetFixture(),
      run_record: runFixture(),
    });
    const json = parse(runCli(baseArgs(files)));
    expect(json.runs[0].linkage.association).toBe('strong_run');
    expect(json.runs[0].linkage.requestAssociation).toBe('unknown');
    expect(json.runs[0].linkage.actionOrdering).toEqual(['unknown']);
    expect(json.coverage.counts.D.confirmed).toBe(0);
    expect(json.coverageInterpretation.D.state).toBe('unknown');
    expect(json.coverageGuards.strongRunConfirmsDelivery).toBe(false);
  });

  it('keeps T unknown, distinguishes a zero linked denominator and flags a truncated source', () => {
    const truncated = linkageFixture({
      coverage: { complete: false, journal: { complete: false, truncatedFiles: 2 } },
    });
    const { files } = writeCase('truncated', {
      linkage: truncated,
      budget: budgetFixture(),
      run_record: runFixture(),
    });
    const json = parse(runCli(baseArgs(files)));
    expect(json.units.calls.state).toBe('source_incomplete');
    expect(json.coverageGuards.sourceComplete).toBe(false);
    expect(json.conclusionScope).toBe('source_incomplete_no_population_denominator');
    expect(json.coverageInterpretation.T.state).toBe('unknown');
    expect(json.coverageInterpretation.zeroDenominator.linkedSubsetDOverT).toBe('not_applicable');
    expect(json.coverage.ratios['D/T'].status).toBe('unknown');
  });

  it('reports zero calls without inventing a zero population', () => {
    const empty = linkageFixture({ totals: { interventions: 0, invocations: 0 }, invocations: [] });
    const { files } = writeCase('empty', {
      linkage: empty,
      budget: budgetFixture(),
      run_record: runFixture(),
    });
    const json = parse(runCli(baseArgs(files)));
    expect(json.units.calls.observed).toBe(0);
    expect(json.coverageInterpretation.T.state).toBe('unknown');
    expect(json.coverageInterpretation.zeroDenominator.linkedSubsetDOverT).toBe('not_applicable');
    expect(json.coverage.counts.T.confirmed).toBe(0);
  });

  it('scopes production pollution exclusions by incident time boundary, not rowid', () => {
    const { files } = writeCase('pollution', {
      linkage: linkageFixture(),
      budget: budgetFixture(),
      run_record: runFixture(),
      pollution_audit: pollutionFixture(),
    });
    const json = parse(runCli(baseArgs(files)));
    expect(json.productionExclusions.state).toBe('audited');
    expect(json.productionExclusions.exclusionKey).toBe('incident_time_boundary+snapshot_content');
    expect(json.productionExclusions.rowidIsExclusionKey).toBe(false);
    expect(json.productionExclusions.retainedDeclarations.declaredAtValues)
      .toEqual(['2026-11-06T12:06:27.182Z']);
    expect(json.productionExclusions.retainedDeclarations.rowsInIncidentBoundary).toBe(0);
    expect(json.productionExclusions.classificationModel.map((row) => row.classification))
      .toEqual(['incident_snapshot', 'legitimate_live']);
  });

  it('writes a Chinese one-page brief that cites run ids and preserved unknowns', () => {
    const { files, dir } = writeCase('brief', {
      linkage: linkageFixture(),
      budget: budgetFixture(),
      run_record: runFixture(),
      offline_reevaluation: reevaluationFixture(),
    });
    const brief = path.join(dir, 'OWNER-BRIEF.md');
    const output = path.join(dir, 'coverage-summary.json');
    const result = runCli([...baseArgs(files), '--output', output, '--brief', brief]);
    expect(result.status).toBe(0);
    expect(fs.existsSync(output)).toBe(true);
    const markdown = fs.readFileSync(brief, 'utf8');
    expect(markdown).toContain('aa-run-fixture-1');
    expect(markdown).toContain('not_evaluated');
    expect(markdown).toContain('unknown');
    expect(markdown).toContain('sha256');
    expect(markdown).toContain('对照未执行');
  });

  it('links a run without a host id by a tight action timestamp and exposes the basis', () => {
    const run = runFixture({
      runId: 'aa-run-fixture-ts',
      positiveGate: {
        ok: false,
        checks: [{ id: 'identity', status: 'FAIL', evidence: { consumedAt: null, consumedBy: null } }],
        failures: [{ id: 'identity', status: 'FAIL' }],
      },
      toolCalls: [{ id: 'tool-fixture-ts', runId: 'aa-run-fixture-ts', recordedAt: '2026-11-06T11:06:51.436Z' }],
      httpRequests: [], hostTurns: [],
    });
    const linkage = linkageFixture({
      invocations: [{
        intervention: {
          hookInvocationId: 'hook-fixture-ts', runId: 'host-run-fixture-ts', sessionId: 'session-fixture-ts',
          configIdentity: { hostVersion: 'unknown', pluginVersion: 'fixture-plugin', effectiveHookSetFingerprint: 'fixture-fingerprint', evidenceCoverage: 'partial' },
        },
        association: 'strong_run',
        evidenceLayers: { requestAssociation: 'unknown', principleAdherence: 'unknown' },
        facts: { actions: [{ toolName: 'read', ordering: 'unknown', ts: '2026-11-06T11:06:51.414Z' }] },
      }],
    });
    const { files } = writeCase('timestamp-match', {
      linkage,
      budget: budgetFixture(),
      run_record: run,
    });
    const json = parse(runCli(baseArgs(files)));
    expect(json.runs[0].linkage.state).toBe('matched_by_run');
    expect(json.runs[0].linkage.matchBasis).toBe('action_timestamp_proximity');
    expect(json.runs[0].linkage.matchDeltaMs).toBeLessThanOrEqual(5000);
    expect(json.runs[0].linkage.association).toBe('strong_run');
  });

  it('fails loudly on missing or malformed evidence', () => {
    const missing = runCli(['--linkage', 'does-not-exist.json', '--budget', 'x', '--run-record', 'y']);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout).ok).toBe(false);

    const { files } = writeCase('bad-schema', {
      linkage: { schemaVersion: 'wrong/v1' },
      budget: budgetFixture(),
      run_record: runFixture(),
    });
    const bad = runCli(baseArgs(files));
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout).reason).toContain('linkage_schema_invalid');
  });
});
