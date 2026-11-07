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
  const args = ['--linkage', files.linkage, '--budget', files.budget];
  if (files.run_record ?? files.runRecord) args.push('--run-record', files.run_record ?? files.runRecord);
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

  it('treats a tight action timestamp as a weak candidate, never an experiment-level link', () => {
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
    expect(json.runs[0].linkage.state).toBe('weak_candidate');
    expect(json.runs[0].linkage.matchStrength).toBe('weak');
    expect(json.runs[0].linkage.matchBasis).toBe('action_timestamp_proximity');
    expect(json.runs[0].linkage.matchDeltaMs).toBeLessThanOrEqual(5000);
    expect(json.runs[0].linkage.experimentLevelStrongLink).toBe(false);
    expect(json.runs[0].linkage.association).toBe('strong_run');
  });

  it('derives a zero-run brief from the input without replaying historical conclusions', () => {
    const { files, dir } = writeCase('zero-run', {
      linkage: linkageFixture(),
      budget: budgetFixture(),
    });
    const brief = path.join(dir, 'OWNER-BRIEF.md');
    const output = path.join(dir, 'coverage-summary.json');
    const result = runCli([...baseArgs(files), '--output', output, '--brief', brief]);
    expect(result.status).toBe(0);
    const json = parse(result);
    expect(json.units.runs.state).toBe('unknown');
    expect(json.units.runs.observed).toBe(0);
    expect(json.units.experimentAttempts.state).toBe('unknown');
    expect(json.units.experimentAttempts.observed).toBe(0);
    const markdown = fs.readFileSync(brief, 'utf8');
    for (const historical of ['1258', '1105', '两次运行', '13/13', 'aa-run-20261106T']) {
      expect(markdown).not.toContain(historical);
    }
    expect(markdown).toContain('运行数：0');
    expect(markdown).toContain('未提供运行记录');
  });

  it('cites only supplied run ids and derives different verdicts from different runs', () => {
    const failed = runFixture({ runId: 'aa-run-fixture-failed' });
    const passed = runFixture({
      runId: 'aa-run-fixture-passed',
      positiveGate: {
        ok: true,
        deliveryPath: 'controlled',
        checks: [
          { id: 'admission-consumed', status: 'PASS', evidence: { consumedBy: { runId: 'host-run-fixture-1', sessionId: 'session-fixture-1' } } },
          { id: 'admission-identity', status: 'PASS' },
          { id: 'target-body', status: 'PASS' },
          { id: 'tool-invocation', status: 'PASS' },
        ],
        failures: [],
      },
      controlGate: { ok: true, failures: [] },
    });
    const { files, dir } = writeCase('different-runs', {
      linkage: linkageFixture(),
      budget: budgetFixture(),
      run_record_a: failed,
      run_record_b: passed,
    });
    const brief = path.join(dir, 'OWNER-BRIEF.md');
    const result = runCli([
      '--linkage', files.linkage, '--budget', files.budget,
      '--run-record', files.run_record_a, '--run-record', files.run_record_b,
      '--brief', brief,
    ]);
    expect(result.status).toBe(0);
    const markdown = fs.readFileSync(brief, 'utf8');
    expect(markdown).toContain('aa-run-fixture-failed');
    expect(markdown).toContain('aa-run-fixture-passed');
    expect(markdown).toContain('原判定失败 1 条');
    expect(markdown).toContain('原判定通过 1 条');
    for (const historical of ['1258', '1105', '两次运行', '13/13']) {
      expect(markdown).not.toContain(historical);
    }
  });

  it('keeps an original failure distinct from wiring facts and an offline replay', () => {
    const { files, dir } = writeCase('layers', {
      linkage: linkageFixture(),
      budget: budgetFixture(),
      run_record: runFixture(),
      offline_reevaluation: reevaluationFixture(),
    });
    const brief = path.join(dir, 'OWNER-BRIEF.md');
    const result = runCli([...baseArgs(files), '--brief', brief]);
    expect(result.status).toBe(0);
    const markdown = fs.readFileSync(brief, 'utf8');
    expect(markdown).toContain('原判定失败');
    expect(markdown).toContain('受控准入被消费：aa-run-fixture-1');
    expect(markdown).toContain('目标正文到达端点：aa-run-fixture-1');
    expect(markdown).toContain('离线复核');
    expect(markdown).toContain('不改原判定');
    expect(markdown).toContain('不表示受控接线事实不存在');
    for (const historical of ['1258', '1105', '两次运行', '13/13']) {
      expect(markdown).not.toContain(historical);
    }
  });

  it('does not confirm the same run from a shared session alone', () => {
    const run = runFixture({
      runId: 'aa-run-session-only',
      positiveGate: {
        ok: false,
        checks: [{
          id: 'admission-consumed', status: 'PASS',
          evidence: { consumedBy: { sessionId: 'session-only-x' } },
        }],
        failures: [],
      },
      toolCalls: [{ id: 'tool-session-only', runId: 'aa-run-session-only', recordedAt: '2026-11-06T18:00:00.000Z' }],
      httpRequests: [], hostTurns: [],
    });
    const linkage = linkageFixture({
      invocations: [{
        intervention: {
          hookInvocationId: 'hook-session-only', runId: 'host-run-other', sessionId: 'session-only-x',
          configIdentity: { hostVersion: 'unknown', pluginVersion: 'fixture-plugin', effectiveHookSetFingerprint: 'fixture-fingerprint', evidenceCoverage: 'partial' },
        },
        association: 'strong_run',
        evidenceLayers: { requestAssociation: 'unknown', principleAdherence: 'unknown' },
        facts: { actions: [{ toolName: 'read', ordering: 'unknown' }] },
      }],
    });
    const { files } = writeCase('session-only', { linkage, budget: budgetFixture(), run_record: run });
    const json = parse(runCli(baseArgs(files)));
    expect(json.runs[0].linkage.state).toBe('weak_candidate');
    expect(json.runs[0].linkage.matchBasis).toBe('session_identity_only');
    expect(json.runs[0].linkage.experimentLevelStrongLink).toBe(false);
  });

  it('never lets a run id match a session id by pooling different identity fields', () => {
    const run = runFixture({
      runId: 'aa-run-cross-field',
      positiveGate: {
        ok: false,
        checks: [{
          id: 'admission-consumed', status: 'PASS',
          evidence: { consumedBy: { sessionId: 'collision-id' } },
        }],
        failures: [],
      },
      toolCalls: [{ id: 'tool-cross-field', runId: 'aa-run-cross-field', recordedAt: '2026-11-06T18:00:00.000Z' }],
      httpRequests: [], hostTurns: [],
    });
    const linkage = linkageFixture({
      invocations: [{
        intervention: {
          hookInvocationId: 'hook-cross-field', runId: 'collision-id', sessionId: 'session-other',
          configIdentity: { hostVersion: 'unknown', pluginVersion: 'fixture-plugin', effectiveHookSetFingerprint: 'fixture-fingerprint', evidenceCoverage: 'partial' },
        },
        association: 'strong_run',
        evidenceLayers: { requestAssociation: 'unknown', principleAdherence: 'unknown' },
        facts: { actions: [{ toolName: 'read', ordering: 'unknown' }] },
      }],
    });
    const { files } = writeCase('cross-field', { linkage, budget: budgetFixture(), run_record: run });
    const json = parse(runCli(baseArgs(files)));
    expect(json.runs[0].linkage.state).toBe('no_matching_invocation');
  });

  it('reports ambiguity instead of picking the first of several identity candidates', () => {
    const invocations = ['a', 'b'].map((suffix) => ({
      intervention: {
        hookInvocationId: `hook-dup-${suffix}`, runId: 'host-run-dup', sessionId: `session-dup-${suffix}`,
        configIdentity: { hostVersion: 'unknown', pluginVersion: 'fixture-plugin', effectiveHookSetFingerprint: 'fixture-fingerprint', evidenceCoverage: 'partial' },
      },
      association: 'strong_run',
      evidenceLayers: { requestAssociation: 'unknown', principleAdherence: 'unknown' },
      facts: { actions: [{ toolName: 'read', ordering: 'unknown' }] },
    }));
    const run = runFixture({
      runId: 'aa-run-dup',
      positiveGate: {
        ok: false,
        checks: [{
          id: 'admission-consumed', status: 'PASS',
          evidence: { consumedBy: { runId: 'host-run-dup' } },
        }],
        failures: [],
      },
      toolCalls: [{ id: 'tool-dup', runId: 'aa-run-dup', recordedAt: '2026-11-06T18:00:00.000Z' }],
      httpRequests: [], hostTurns: [],
    });
    const { files } = writeCase('ambiguous', {
      linkage: linkageFixture({ invocations }),
      budget: budgetFixture(),
      run_record: run,
    });
    const json = parse(runCli(baseArgs(files)));
    expect(json.runs[0].linkage.state).toBe('ambiguous');
    expect(json.runs[0].linkage.candidateHookInvocationIds).toEqual(['hook-dup-a', 'hook-dup-b']);
    expect(json.runs[0].linkage.experimentLevelStrongLink).toBe(false);
  });

  it('refuses a contradictory run/session identity as a strong match', () => {
    const run = runFixture({
      runId: 'aa-run-contradictory',
      positiveGate: {
        ok: false,
        checks: [{
          id: 'admission-consumed', status: 'PASS',
          evidence: { consumedBy: { runId: 'host-run-contradictory', sessionId: 'session-recorded' } },
        }],
        failures: [],
      },
      toolCalls: [{ id: 'tool-contradictory', runId: 'aa-run-contradictory', recordedAt: '2026-11-06T18:00:00.000Z' }],
      httpRequests: [], hostTurns: [],
    });
    const linkage = linkageFixture({
      invocations: [{
        intervention: {
          hookInvocationId: 'hook-contradictory', runId: 'host-run-contradictory', sessionId: 'session-other',
          configIdentity: { hostVersion: 'unknown', pluginVersion: 'fixture-plugin', effectiveHookSetFingerprint: 'fixture-fingerprint', evidenceCoverage: 'partial' },
        },
        association: 'strong_run',
        evidenceLayers: { requestAssociation: 'unknown', principleAdherence: 'unknown' },
        facts: { actions: [{ toolName: 'read', ordering: 'unknown' }] },
      }],
    });
    const { files } = writeCase('contradictory', { linkage, budget: budgetFixture(), run_record: run });
    const json = parse(runCli(baseArgs(files)));
    expect(json.runs[0].linkage.state).toBe('contradictory_identity');
    expect(json.runs[0].linkage.experimentLevelStrongLink).toBe(false);
  });

  it('refuses a hook-invocation match whose recorded run and session identities contradict', () => {
    const run = runFixture({
      runId: 'aa-run-hook-conflict',
      positiveGate: {
        ok: false,
        checks: [{
          id: 'admission-consumed', status: 'PASS',
          evidence: { consumedBy: { hookInvocationId: 'hook-id-conflict', runId: 'host-run-recorded', sessionId: 'session-recorded' } },
        }],
        failures: [],
      },
      toolCalls: [{ id: 'tool-hook-conflict', runId: 'aa-run-hook-conflict', recordedAt: '2026-11-06T18:00:00.000Z' }],
      httpRequests: [], hostTurns: [],
    });
    const linkage = linkageFixture({
      invocations: [{
        intervention: {
          hookInvocationId: 'hook-id-conflict', runId: 'host-run-linkage', sessionId: 'session-linkage',
          configIdentity: { hostVersion: 'unknown', pluginVersion: 'fixture-plugin', effectiveHookSetFingerprint: 'fixture-fingerprint', evidenceCoverage: 'partial' },
        },
        association: 'strong_run',
        evidenceLayers: { requestAssociation: 'unknown', principleAdherence: 'unknown' },
        facts: { actions: [{ toolName: 'read', ordering: 'unknown' }] },
      }],
    });
    const { files } = writeCase('hook-identity-conflict', { linkage, budget: budgetFixture(), run_record: run });
    const json = parse(runCli(baseArgs(files)));
    expect(json.runs[0].linkage.state).toBe('contradictory_identity');
    expect(json.runs[0].linkage.experimentLevelStrongLink).toBe(false);
  });

  it('refuses multiple conflicting run declarations even when one value matches', () => {
    const run = runFixture({
      runId: 'aa-run-multi-identity',
      positiveGate: {
        ok: false,
        checks: [
          {
            id: 'admission-consumed', status: 'PASS',
            evidence: { consumedBy: { hookInvocationId: 'hook-multi-identity', runId: 'host-run-match', sessionId: 'session-match' } },
          },
          {
            id: 'delivery-observed', status: 'PASS',
            evidence: { consumedBy: { hookInvocationId: 'hook-multi-identity', runId: 'host-run-other', sessionId: 'session-match' } },
          },
        ],
        failures: [],
      },
      toolCalls: [{ id: 'tool-multi-identity', runId: 'aa-run-multi-identity', recordedAt: '2026-11-06T18:10:00.000Z' }],
      httpRequests: [], hostTurns: [],
    });
    const linkage = linkageFixture({
      invocations: [{
        intervention: {
          hookInvocationId: 'hook-multi-identity', runId: 'host-run-match', sessionId: 'session-match',
          configIdentity: { hostVersion: 'unknown', pluginVersion: 'fixture-plugin', effectiveHookSetFingerprint: 'fixture-fingerprint', evidenceCoverage: 'partial' },
        },
        association: 'strong_run',
        evidenceLayers: { requestAssociation: 'unknown', principleAdherence: 'unknown' },
        facts: { actions: [{ toolName: 'read', ordering: 'unknown' }] },
      }],
    });
    const { files } = writeCase('hook-multiple-run-identities', { linkage, budget: budgetFixture(), run_record: run });
    const json = parse(runCli(baseArgs(files)));
    expect(json.runs[0].linkage.state).toBe('contradictory_identity');
    expect(json.runs[0].linkage.experimentLevelStrongLink).toBe(false);
  });

  it('fails loudly when the same invocation id carries different factual content', () => {
    const first = linkageFixture();
    const second = linkageFixture({
      invocations: [{
        ...first.invocations[0],
        association: 'unknown',
      }],
    });
    const { files } = writeCase('conflicting-content', {
      linkage: first,
      linkage_b: second,
      budget: budgetFixture(),
      run_record: runFixture(),
    });
    const result = runCli([
      '--linkage', files.linkage, '--linkage', files.linkage_b,
      '--budget', files.budget, '--run-record', files.run_record,
    ]);
    expect(result.status).toBe(1);
    expect(parse(result).reason).toContain('conflicting_linkage_invocations');
  });

  it('treats reordered keys and report generation time as the same invocation', () => {
    const first = linkageFixture();
    const reordered = {
      invocations: [{
        facts: first.invocations[0].facts,
        evidenceLayers: first.invocations[0].evidenceLayers,
        association: first.invocations[0].association,
        intervention: {
          configIdentity: first.invocations[0].intervention.configIdentity,
          sessionId: first.invocations[0].intervention.sessionId,
          runId: first.invocations[0].intervention.runId,
          hookInvocationId: first.invocations[0].intervention.hookInvocationId,
        },
        unknowns: ['diagnostic text generated later'],
        weakCandidates: [{ reason: 'later diagnostic' }],
        associationReasons: ['derived later'],
      }],
      totals: first.totals,
      coverage: first.coverage,
      request: first.request,
      requirementId: first.requirementId,
      schemaVersion: first.schemaVersion,
      generatedAt: '2027-01-01T00:00:00.000Z',
    };
    const { files } = writeCase('reordered', {
      linkage: first,
      linkage_b: reordered,
      budget: budgetFixture(),
      run_record: runFixture(),
    });
    const result = runCli([
      '--linkage', files.linkage, '--linkage', files.linkage_b,
      '--budget', files.budget, '--run-record', files.run_record,
    ]);
    expect(result.status).toBe(0);
    const json = parse(result);
    expect(json.units.calls.observed).toBe(1);
    expect(json.duplicates.invocations).toBe(1);
  });

  it('does not merge the same invocation id across different workspace/host/config scopes', () => {
    const first = linkageFixture();
    const second = linkageFixture({
      request: { workspaceDir: '/fixture/other-workspace' },
      invocations: [{
        ...first.invocations[0],
        intervention: {
          ...first.invocations[0].intervention,
          configIdentity: { ...first.invocations[0].intervention.configIdentity, pluginVersion: 'other-plugin' },
        },
      }],
    });
    const { files } = writeCase('scope-collision', {
      linkage: first,
      linkage_b: second,
      budget: budgetFixture(),
      run_record: runFixture(),
    });
    const result = runCli([
      '--linkage', files.linkage, '--linkage', files.linkage_b,
      '--budget', files.budget, '--run-record', files.run_record,
    ]);
    expect(result.status).toBe(1);
    expect(parse(result).reason).toContain('conflicting_linkage_scopes');
  });

  it('keeps facts and conflict conclusions stable when input order changes', () => {
    const first = linkageFixture();
    const second = linkageFixture({
      request: { workspaceDir: '/fixture/second-workspace' },
      coverage: { window: { start: '2026-11-06T15:00:00.000Z', end: '2026-11-06T16:00:00.000Z' } },
      invocations: [{
        ...first.invocations[0],
        intervention: {
          ...first.invocations[0].intervention,
          hookInvocationId: 'hook-fixture-2',
          runId: 'host-run-fixture-2',
          sessionId: 'session-fixture-2',
        },
      }],
    });
    const { files } = writeCase('order', {
      linkage: first,
      linkage_b: second,
      budget: budgetFixture(),
      run_record: runFixture(),
    });
    const forward = parse(runCli([
      '--linkage', files.linkage, '--linkage', files.linkage_b,
      '--budget', files.budget, '--run-record', files.run_record,
    ]));
    const reverse = parse(runCli([
      '--linkage', files.linkage_b, '--linkage', files.linkage,
      '--budget', files.budget, '--run-record', files.run_record,
    ]));
    expect(forward.units).toEqual(reverse.units);
    expect(forward.coverageInput.windowId).toBe(reverse.coverageInput.windowId);
    expect(forward.coverageInput.workspaceId).toBe(reverse.coverageInput.workspaceId);
    expect(forward.coverageInput.configIdentity ?? forward.coverage.configIdentity)
      .toBe(reverse.coverage.configIdentity);
  });

  it('defines V/O/D by SPEC v0.6 section 6.1 rather than delivery or adherence', () => {
    const { files, dir } = writeCase('definitions', {
      linkage: linkageFixture(),
      budget: budgetFixture(),
      run_record: runFixture(),
    });
    const brief = path.join(dir, 'OWNER-BRIEF.md');
    const result = runCli([...baseArgs(files), '--brief', brief]);
    expect(result.status).toBe(0);
    const json = parse(result);
    const mapping = Object.fromEntries(json.fieldMapping.map((entry) => [entry.statisticField, entry]));
    expect(mapping.V.eligibility).toContain('visible before the action');
    expect(mapping.V.eligibility).not.toMatch(/delivery preceded the critical action/);
    expect(mapping.O.eligibility).toContain('recognized');
    expect(mapping.O.eligibility).not.toMatch(/independent principle-adherence/);
    expect(mapping.D.eligibility).toContain('actual model request');
    expect(mapping.D.eligibility).toContain('preceded the key action');
    expect(json.definitions.V).toContain('visible before the action');
    expect(json.definitions.O).toContain('recognized');
    expect(json.definitions.D).toContain('actual request');
    expect(json.coverageInterpretation.V.reason).not.toMatch(/timely delivery-order/);
    expect(json.coverageInterpretation.O.reason).not.toMatch(/principle-adherence/);
    expect(json.coverageInterpretation.D.reason).toContain('actual request');
    const markdown = fs.readFileSync(brief, 'utf8');
    expect(markdown).toContain('V（事前可见的合格信号）');
    expect(markdown).toContain('O（PD 在行动前实际识别）');
    expect(markdown).toContain('D（独立确认目标正文进入实际请求且早于关键行动）');
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
