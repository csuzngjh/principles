// Adapter from recorded AA evidence to the existing coverage-input contract.
// This module never computes coverage itself: it normalizes sources, removes
// duplicate rows, and delegates T/V/O/D math to summarize-adaptive-coverage.mjs.
// Association facts (including strong_run) are observations, not coverage.
import { hashOfCanonical } from '../challenge-freeze.mjs';
import { adaptiveConfigIdentity } from './adaptive-config-identity.mjs';

export const SUMMARY_SCHEMA = 'pd-aa-coverage-summary/v1';
export const COVERAGE_INPUT_SCHEMA = 'aa-coverage-input.v1';

export const FIELD_MAPPING = [
  {
    statisticField: 'units.calls',
    source: 'pd activation link report.totals / invocations[].intervention.hookInvocationId',
    eligibility: 'schemaVersion = pd-aa-behavior-linkage/v1; unique hookInvocationId only',
    missingOutput: 'state=unknown; never inferred from runs or tool calls',
  },
  {
    statisticField: 'units.runs',
    source: 'run-record.json.runId',
    eligibility: 'schemaVersion = pd-aa-controlled-admission-run/v1; unique runId; identical bytes de-duplicated',
    missingOutput: 'state=unknown',
  },
  {
    statisticField: 'units.decisionOpportunities',
    source: 'none in the current evidence set',
    eligibility: 'requires a task-opportunity census with declared enumeration',
    missingOutput: 'state=unknown; calls and runs must not be used as the denominator',
  },
  {
    statisticField: 'units.experimentAttempts',
    source: 'run-record.json (one record = one attempt)',
    eligibility: 'unique runId; original positive-arm verdict retained',
    missingOutput: 'state=unknown',
  },
  {
    statisticField: 'T',
    source: 'coverage-input opportunities[].classification.T + enumeration declaration',
    eligibility: 'only for opportunities linked to a declared opportunity census',
    missingOutput: 'unknown; no overall ratio; linked subset ratio stays not_applicable',
  },
  {
    statisticField: 'V',
    source: 'coverage-input opportunities[].classification.V + delivery order evidence',
    eligibility: 'linked opportunity and evidence that delivery preceded the critical action',
    missingOutput: 'unknown; strong_run alone is insufficient',
  },
  {
    statisticField: 'O',
    source: 'coverage-input opportunities[].classification.O + independent recognition evidence',
    eligibility: 'linked opportunity and independent principle-adherence evidence',
    missingOutput: 'unknown; fake-provider tool choice is not adherence',
  },
  {
    statisticField: 'D',
    source: 'existing verify-adaptive-delivery.mjs over independently pinned request/action captures',
    eligibility: 'final_model_request boundary, exact target body, trusted pin, ordered action',
    missingOutput: 'unknown; native delivery or a passing offline replay cannot confirm D',
  },
  {
    statisticField: 'sameText',
    source: 'coverage-input opportunities[].sameText',
    eligibility: 'frozen input digest compared at the request boundary',
    missingOutput: 'unknown',
  },
  {
    statisticField: 'budget.cumulative',
    source: 'experiment-budget.json (pd-aa-budget-ledger/v1)',
    eligibility: 'all recorded runIds, cumulative caps and usage',
    missingOutput: 'state=unknown; never reported as zero',
  },
  {
    statisticField: 'budget.perRun',
    source: 'run-record.json.attempt.used (fallback: arrays filtered by runId)',
    eligibility: 'records whose runId equals the run under report',
    missingOutput: 'state=unknown',
  },
  {
    statisticField: 'runs[].originalVerdict',
    source: 'run-record.json.positiveGate / controlGate',
    eligibility: 'the recorded verdict at gate time',
    missingOutput: 'state=unknown',
  },
  {
    statisticField: 'runs[].offlineReevaluation',
    source: 'offline-reevaluation.json',
    eligibility: 'separate file, labelled derived; sourceRun must match a recorded run',
    missingOutput: 'state=missing; never promoted to an experiment success',
  },
  {
    statisticField: 'productionExclusions',
    source: 'pollution audit with incidentWindow (v4)',
    eligibility: 'incident time boundary + snapshot content; rowid is not an exclusion key',
    missingOutput: 'state=not_audited; never treated as clean',
  },
  {
    statisticField: 'benefit / harm',
    source: 'evaluation evidence (not present in this evidence set)',
    eligibility: 'independent outcome/evaluation evidence',
    missingOutput: 'not_evaluated; never written as zero',
  },
];

const SUMMARY_KEYS = ['hostTurns', 'httpRequests', 'toolCalls', 'paidCalls'];
const RUN_SCHEMA = 'pd-aa-controlled-admission-run/v1';
const LINKAGE_SCHEMA = 'pd-aa-behavior-linkage/v1';
const BUDGET_SCHEMA = 'pd-aa-budget-ledger/v1';
const REEVALUATION_SCHEMA = 'pd-aa-offline-reevaluation/v1';
const POLLUTION_SCHEMA = 'pd-aa-prod-audit/v4';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);

function requireValid(condition, reason) {
  if (!condition) throw new TypeError(reason);
}

function tri(value) {
  return value === true ? 'confirmed' : value === false ? 'not_confirmed' : 'unknown';
}

function uniqueByHash(entries, role) {
  const seen = new Map();
  const unique = [];
  let duplicates = 0;
  for (const entry of entries) {
    const key = entry.hash;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.set(key, entry);
    unique.push(entry);
  }
  return { unique, duplicates, role };
}

/**
 * Dedupe run records by identity, not by input position. Identical bytes are a
 * duplicate observation; the same runId with different bytes is contradictory
 * evidence and fails loudly instead of silently picking one.
 */
function uniqueRuns(entries) {
  const byRunId = new Map();
  const byHash = new Map();
  let duplicates = 0;
  for (const entry of entries) {
    if (byHash.has(entry.hash)) {
      duplicates++;
      continue;
    }
    byHash.set(entry.hash, entry);
    const runId = entry.runId;
    if (byRunId.has(runId)) throw new TypeError('conflicting_run_records');
    byRunId.set(runId, entry);
  }
  return { unique: [...byRunId.values()], duplicates, byRunId };
}

function uniqueReevaluations(entries) {
  const bySource = new Map();
  const byHash = new Map();
  let duplicates = 0;
  for (const entry of entries) {
    if (byHash.has(entry.hash)) {
      duplicates++;
      continue;
    }
    byHash.set(entry.hash, entry);
    const sourceRun = entry.sourceRun;
    if (bySource.has(sourceRun)) throw new TypeError('conflicting_offline_reevaluations');
    bySource.set(sourceRun, entry);
  }
  return { unique: [...bySource.values()], duplicates, bySource };
}

function uniquePlans(entries) {
  const byRunId = new Map();
  const byHash = new Map();
  let duplicates = 0;
  for (const entry of entries) {
    if (byHash.has(entry.hash)) {
      duplicates++;
      continue;
    }
    byHash.set(entry.hash, entry);
    if (byRunId.has(entry.runId)) throw new TypeError('conflicting_run_plans');
    byRunId.set(entry.runId, entry);
  }
  return { unique: [...byRunId.values()], duplicates, byRunId };
}

function uniqueBudgets(entries) {
  const unique = uniqueByHash(entries, 'budget');
  if (unique.unique.length > 1) throw new TypeError('conflicting_budget_sources');
  return { ...unique, value: unique.unique[0] ?? null };
}

function uniquePollutionAudits(entries) {
  const unique = uniqueByHash(entries, 'pollutionAudit');
  if (unique.unique.length > 1) throw new TypeError('conflicting_pollution_audits');
  return { ...unique, value: unique.unique[0] ?? null };
}

function gateChecks(record) {
  if (!object(record?.positiveGate) || !Array.isArray(record.positiveGate.checks)) return [];
  return record.positiveGate.checks.filter((check) => object(check) && text(check.id));
}

function gateCheckState(record, id) {
  const found = gateChecks(record).find((check) => check.id === id);
  if (!found) return 'unknown';
  const status = String(found.status ?? '').toUpperCase();
  if (status === 'PASS') return 'confirmed';
  if (status === 'FAIL') return 'not_verified';
  return 'unknown';
}

function verdictOf(record, gateName) {
  const gate = record?.[gateName];
  if (!object(gate)) return { state: 'unknown', ok: 'unknown', failures: [], detail: 'gate_not_recorded' };
  const failures = Array.isArray(gate.failures)
    ? gate.failures.filter((failure) => object(failure) && text(failure.id))
      .map((failure) => ({ id: failure.id, status: String(failure.status ?? 'unknown') }))
    : [];
  return {
    state: 'recorded',
    ok: gate.ok === true ? true : gate.ok === false ? false : 'unknown',
    failures,
    stopBeforeControl: Array.isArray(gate.stopBeforeControl) ? gate.stopBeforeControl : [],
    controlExecuted: false,
  };
}

function costOf(record) {
  const attempt = object(record?.attempt) && object(record.attempt.used) ? record.attempt.used : null;
  const historical = { hostTurns: 0, httpRequests: 0, toolCalls: 0, paidCalls: 0 };
  for (const field of ['hostTurns', 'httpRequests', 'toolCalls']) {
    if (!Array.isArray(record?.[field])) continue;
    historical[field] = record[field].filter((row) => object(row) && row.runId !== record.runId).length;
  }
  if (Array.isArray(record?.paidCalls)) {
    historical.paidCalls = record.paidCalls.filter((row) => object(row) && row.runId !== record.runId).length;
  }
  return {
    state: attempt ? 'recorded' : 'unknown',
    currentRun: attempt ? pickCounts(attempt) : null,
    cumulativeAtRecord: object(record?.used) ? pickCounts(record.used) : null,
    historicalRecordsExcluded: attempt ? historical : null,
  };
}

function pickCounts(value) {
  if (!object(value)) return null;
  const picked = {};
  for (const key of SUMMARY_KEYS) picked[key] = Number.isFinite(value[key]) ? value[key] : null;
  return picked;
}

function scopeArrays(record, field) {
  if (!Array.isArray(record?.[field])) return [];
  return record[field].filter((row) => object(row) && row.runId === record.runId);
}

function endpointFacts(record, plan) {
  const requests = scopeArrays(record, 'httpRequests');
  const first = requests.find((request) => text(request.userMessageSha256)) ?? null;
  const endpointUserMessageSha256 = first?.userMessageSha256 ?? null;
  const frozenInputSha256 = text(plan?.inputSha256) ? plan.inputSha256 : null;
  let userMessageMatchesFrozenInput = 'unknown';
  if (sha256(endpointUserMessageSha256) && sha256(frozenInputSha256)) {
    userMessageMatchesFrozenInput = endpointUserMessageSha256 === frozenInputSha256 ? 'confirmed' : 'different';
  }
  return {
    state: requests.length > 0 ? 'recorded' : 'unknown',
    requestCount: requests.length,
    requestIds: requests.map((request) => request.id).filter(text),
    endpointUserMessageSha256,
    frozenInputSha256,
    userMessageMatchesFrozenInput,
    digestBasis: 'endpoint userMessageSha256 vs plan.inputSha256; a difference records the known limitation, it is not a D verdict',
  };
}

function linkageReportOf(value) {
  if (object(value) && value.schemaVersion === LINKAGE_SCHEMA) return value;
  if (object(value?.report) && value.report.schemaVersion === LINKAGE_SCHEMA) return value.report;
  if (object(value?.link?.report) && value.link.report.schemaVersion === LINKAGE_SCHEMA) return value.link.report;
  return null;
}

function hostIdentities(record) {
  const ids = new Set();
  for (const check of gateChecks(record)) {
    const evidence = object(check.evidence) ? check.evidence : {};
    const consumedBy = object(evidence.consumedBy) ? evidence.consumedBy : null;
    if (consumedBy) {
      if (text(consumedBy.runId)) ids.add(consumedBy.runId);
      if (text(consumedBy.sessionId)) ids.add(consumedBy.sessionId);
    }
    if (text(evidence.sessionId)) ids.add(evidence.sessionId);
    if (text(evidence.runId)) ids.add(evidence.runId);
  }
  return ids;
}

function matchingInvocation(invocations, record) {
  const ids = hostIdentities(record);
  const byIdentity = invocations.find((invocation) => (text(invocation.runId) && ids.has(invocation.runId))
    || (text(invocation.sessionId) && ids.has(invocation.sessionId)));
  if (byIdentity) return { invocation: byIdentity, basis: 'host_identity' };
  // Some records store no host run id. Fall back to a tight timestamp match
  // against the run-scoped tool calls and expose the match basis, so a reader
  // can audit the link instead of trusting an implicit join.
  const recordedAt = scopeArrays(record, 'toolCalls')
    .map((row) => row.recordedAt).filter(text)
    .map((value) => Date.parse(value)).filter(Number.isFinite);
  if (recordedAt.length === 0) return null;
  for (const invocation of invocations) {
    const actionTimes = invocation.actionTimes ?? [];
    for (const time of actionTimes) {
      const delta = Math.min(...recordedAt.map((value) => Math.abs(time - value)));
      if (Number.isFinite(delta) && delta <= 5000) {
        return { invocation, basis: 'action_timestamp_proximity', deltaMs: delta };
      }
    }
  }
  return null;
}

function linkageInvocations(linkageEntries) {
  const seen = new Map();
  let duplicates = 0;
  const invocations = [];
  let sourceComplete = null;
  let window = null;
  let workspaceDir = null;
  let host = null;
  let reportedTotals = null;
  const configIdentities = new Set();
  for (const entry of linkageEntries) {
    const report = linkageReportOf(entry.value);
    requireValid(report !== null, 'linkage_schema_invalid');
    if (reportedTotals === null && object(report.totals)) reportedTotals = report.totals;
    if (window === null && object(report.coverage?.window)) window = report.coverage.window;
    if (workspaceDir === null && text(report.request?.workspaceDir)) workspaceDir = report.request.workspaceDir;
    if (host === null && text(report.request?.host)) host = report.request.host;
    const coverage = report.coverage;
    const complete = object(coverage)
      && coverage.complete === true
      && object(coverage.journal) && coverage.journal.complete === true
      && Number.isFinite(coverage.journal.truncatedFiles) && coverage.journal.truncatedFiles === 0
      && object(coverage.eventLog) && coverage.eventLog.truncated === false
      && object(coverage.trajectory) && coverage.trajectory.truncated === false;
    sourceComplete = sourceComplete === null ? complete : sourceComplete && complete;
    const list = Array.isArray(report.invocations) ? report.invocations : [];
    for (const invocation of list) {
      if (!object(invocation) || !object(invocation.intervention)) continue;
      const key = invocation.intervention.hookInvocationId;
      if (!text(key)) continue;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.set(key, true);
      const config = object(invocation.intervention.configIdentity) ? invocation.intervention.configIdentity : {};
      configIdentities.add(hashOfCanonical(config));
      invocations.push({
        hookInvocationId: key,
        runId: invocation.intervention.runId ?? null,
        sessionId: invocation.intervention.sessionId ?? null,
        association: invocation.association ?? 'unknown',
        evidenceLayers: object(invocation.evidenceLayers) ? invocation.evidenceLayers : {},
        actionOrdering: Array.isArray(invocation.facts?.actions)
          ? invocation.facts.actions.map((action) => action.ordering ?? 'unknown') : [],
        toolNames: Array.isArray(invocation.facts?.actions)
          ? invocation.facts.actions.map((action) => action.toolName).filter(text) : [],
        actionTimes: Array.isArray(invocation.facts?.actions)
          ? invocation.facts.actions
            .map((action) => (text(action.ts) ? Date.parse(action.ts) : Number.NaN))
            .filter(Number.isFinite) : [],
        config,
      });
    }
  }
  return {
    invocations,
    duplicates,
    sourceComplete: sourceComplete === null ? false : sourceComplete,
    window,
    workspaceDir,
    host,
    configIdentities: [...configIdentities],
    reportedTotals,
  };
}

function buildConfig(linkage, hostFromReport) {
  const identity = linkage.invocations[0]?.config ?? {};
  const host = text(hostFromReport) && ['openclaw', 'codex', 'workbuddy'].includes(hostFromReport)
    ? hostFromReport : 'unknown';
  const coverage = identity.evidenceCoverage;
  return {
    host,
    hostVersion: text(identity.hostVersion) ? identity.hostVersion : 'unknown',
    runtimeMode: text(identity.runtimeMode) ? identity.runtimeMode : 'unknown',
    pluginVersion: text(identity.pluginVersion) ? identity.pluginVersion : 'unknown',
    effectiveHookSetFingerprint: text(identity.effectiveHookSetFingerprint)
      ? identity.effectiveHookSetFingerprint : 'unknown',
    evidenceCoverage: coverage === 'complete' || coverage === 'partial' ? coverage : 'unknown',
  };
}

function buildCoverageInput(linkage) {
  const config = buildConfig(linkage, linkage.host);
  const identity = adaptiveConfigIdentity(config);
  requireValid(identity !== null, 'config_identity_invalid');
  const workspaceId = linkage.workspaceDir ? `workspace-sha256:${hashOfCanonical(linkage.workspaceDir).slice(0, 16)}`
    : 'workspace:unknown';
  const window = linkage.window ?? {};
  const windowId = `window:${window.start ?? 'unknown'}..${window.end ?? 'unknown'}`;
  const opportunities = linkage.invocations.map((invocation) => ({
    // A hook invocation is a call. Minting an opportunity id from it would
    // silently turn callback volume into an opportunity denominator.
    opportunityId: null,
    classification: { T: 'unknown', V: 'unknown', O: 'unknown' },
    classificationReferences: {
      T: 'missing:no_decision_opportunity_census',
      V: 'missing:no_timely_delivery_order_evidence',
      O: 'missing:no_independent_principle_adherence_evidence',
    },
    sameText: 'unknown',
    checks: [],
  }));
  return {
    schemaVersion: COVERAGE_INPUT_SCHEMA,
    windowId,
    workspaceId,
    enumeration: 'unknown',
    config,
    opportunities,
  };
}

function coverageInterpretation(summary, units) {
  const counts = summary.counts ?? {};
  const censusKnown = units?.decisionOpportunities?.state !== 'unknown';
  const layer = (name, reason) => {
    const confirmed = counts[name]?.confirmed ?? 0;
    const unknown = counts[name]?.unknown ?? 0;
    // Without a declared opportunity census, every layer stays unknown even
    // when the finite linked subset is empty. "No linked row" is not "zero".
    if (!censusKnown) return { state: 'unknown', confirmed, unknown, reason };
    if (confirmed > 0) return { state: unknown > 0 ? 'lower_bound' : 'confirmed', confirmed, unknown, reason };
    return { state: unknown > 0 ? 'unknown' : 'not_applicable', confirmed, unknown, reason };
  };
  return {
    T: layer('T', 'no declared decision-opportunity census; calls and runs are not the denominator'),
    V: layer('V', 'no linked opportunity with timely delivery-order evidence'),
    O: layer('O', 'no linked opportunity with independent principle-adherence evidence'),
    D: layer('D', 'no independently pinned request+action evidence; strong_run does not confirm delivery'),
    ratios: {
      population: summary.ratios ?? null,
      linkedSubset: summary.linkedSubsetRatios ?? null,
    },
    zeroDenominator: {
      state: censusKnown ? 'not_applicable' : 'unknown',
      linkedSubsetDOverT: summary.linkedSubsetRatios?.['D/T']?.status ?? 'unknown',
      reason: 'the linked subset has no denominator; this is not a confirmed zero population',
    },
    sameText: {
      state: 'unknown',
      reason: 'endpoint user body digest and frozen input digest are recorded separately; a difference is a limitation, not a D verdict',
    },
    benefit: { state: 'not_evaluated', value: null, reason: 'no control arm and no evaluation evidence' },
    harm: { state: 'not_evaluated', value: null, reason: 'no evaluation evidence' },
  };
}

function summarizeBudget(entry) {
  if (!entry) return { state: 'unknown', reason: 'no budget ledger supplied' };
  const value = entry.value;
  requireValid(object(value) && value.schemaVersion === BUDGET_SCHEMA, 'budget_schema_invalid');
  requireValid(object(value.budget) && object(value.used), 'budget_fields_missing');
  const caps = pickCounts(value.budget);
  const used = pickCounts(value.used);
  const remaining = {};
  let overBudget = false;
  for (const key of SUMMARY_KEYS) {
    if (caps[key] === null || used[key] === null) {
      remaining[key] = null;
      continue;
    }
    remaining[key] = caps[key] - used[key];
    if (remaining[key] < 0) overBudget = true;
  }
  return {
    state: 'recorded',
    sourceSha256: entry.hash,
    caps,
    used,
    remaining,
    overBudget,
    armBudgets: object(value.armBudgets) ? value.armBudgets : null,
  };
}

function productionExclusions(entry) {
  if (!entry) {
    return { state: 'not_audited', note: 'no pollution audit supplied; absence of an audit is not evidence of a clean store' };
  }
  const value = entry.value;
  requireValid(object(value) && value.schemaVersion === POLLUTION_SCHEMA, 'pollution_audit_schema_invalid');
  requireValid(object(value.incidentWindow) && text(value.incidentWindow.from)
    && text(value.incidentWindow.to), 'pollution_audit_window_missing');
  const excluded = object(value.excluded) ? value.excluded : {};
  const retained = object(value.retained) ? value.retained : {};
  const declarations = object(retained.intervention_capability_declarations)
    ? retained.intervention_capability_declarations : null;
  return {
    state: 'audited',
    sourceSha256: entry.hash,
    incidentWindow: { from: value.incidentWindow.from, to: value.incidentWindow.to },
    exclusionKey: 'incident_time_boundary+snapshot_content',
    rowidIsExclusionKey: false,
    excludedCounts: {
      principleApplications: excluded.principle_applications?.count ?? null,
      interventionEvidenceRecords: excluded.intervention_evidence_records?.count ?? null,
      capabilityDeclarations: excluded.intervention_capability_declarations?.count ?? null,
    },
    retainedDeclarations: declarations ? {
      count: declarations.count ?? null,
      declaredAtValues: Array.isArray(declarations.declaredAtValues) ? declarations.declaredAtValues : [],
      rowsInIncidentBoundary: declarations.rowsInIncidentBoundary ?? null,
    } : null,
    classificationModel: Array.isArray(value.classificationModel?.declarations)
      ? value.classificationModel.declarations : [],
  };
}

/**
 * Normalize recorded evidence into (a) the existing coverage-input contract and
 * (b) an auditable summary shell. Coverage math stays in the existing module.
 */
export function adaptAaEvidence({ linkage = [], budget = [], runRecords = [], reevaluations = [],
  plans = [], pollutionAudits = [], generatedAt = null } = {}) {
  requireValid(Array.isArray(linkage) && linkage.length > 0, 'linkage_missing');
  const runs = uniqueRuns(runRecords);
  requireValid(runs.unique.length > 0, 'run_records_missing');
  const linkages = uniqueByHash(linkage, 'linkage');
  const reeval = uniqueReevaluations(reevaluations);
  const planSet = uniquePlans(plans);
  const budgetSet = uniqueBudgets(budget);
  const pollution = uniquePollutionAudits(pollutionAudits);

  const linkageFacts = linkageInvocations(linkages.unique);
  const coverageInput = buildCoverageInput(linkageFacts);
  const byRun = new Map(runs.unique.map((run) => [run.runId, run]));

  const runReports = runs.unique.map((entry) => {
    const record = entry.value;
    requireValid(object(record) && record.schemaVersion === RUN_SCHEMA, 'run_record_schema_invalid');
    const verdict = verdictOf(record, 'positiveGate');
    const control = record.controlGate;
    verdict.controlExecuted = object(control) && control.ok === true;
    const deliveryPath = record.positiveGate?.deliveryPath ?? record.deliveryPath ?? 'unknown';
    const nativeDeliveryObserved = record.positiveGate?.nativeDeliveryObserved;
    const admissionConsumed = gateCheckState(record, 'admission-consumed');
    const admissionIdentity = gateCheckState(record, 'admission-identity');
    const targetBody = gateCheckState(record, 'target-body');
    const match = matchingInvocation(linkageFacts.invocations, record);
    const linkageInvocation = match?.invocation ?? null;
    const reevaluation = reeval.bySource.get(record.runId) ?? null;
    const controlledInstrumentationProven = deliveryPath === 'controlled'
      && admissionConsumed === 'confirmed'
      && targetBody === 'confirmed'
      && verdict.ok === true;
    return {
      runId: record.runId,
      fixtureId: record.fixtureId ?? null,
      evidenceSha256: entry.hash,
      originalVerdict: verdict,
      controlVerdict: verdictOf(record, 'controlGate'),
      deliveryPath,
      nativeDeliveryObserved: tri(nativeDeliveryObserved),
      controlledFacts: {
        admissionConsumed,
        admissionIdentity,
        targetBodyReachedEndpoint: targetBody,
        controlledInstrumentationProven,
        nativeDeliveryIsNotControlledSuccess: deliveryPath !== 'controlled',
      },
      linkage: linkageInvocation ? {
        state: 'matched_by_run',
        matchBasis: match.basis,
        matchDeltaMs: match.deltaMs ?? null,
        hookInvocationId: linkageInvocation.hookInvocationId,
        association: linkageInvocation.association,
        requestAssociation: linkageInvocation.evidenceLayers.requestAssociation ?? 'unknown',
        principleAdherence: linkageInvocation.evidenceLayers.principleAdherence ?? 'unknown',
        actionOrdering: linkageInvocation.actionOrdering,
        toolNames: linkageInvocation.toolNames,
      } : { state: 'no_matching_invocation' },
      offlineReevaluation: reevaluation ? {
        state: 'present',
        generatedAt: reevaluation.value.generatedAt ?? null,
        recordedGateOk: reevaluation.value.recordedVerdict?.ok ?? 'unknown',
        correctedGateOk: reevaluation.value.correctedGateVerdict?.ok ?? 'unknown',
        knownDefectsFixedAfterTheRun: Array.isArray(reevaluation.value.knownGateDefectsFixedAfterTheRun)
          ? reevaluation.value.knownGateDefectsFixedAfterTheRun : [],
        affectsOriginalVerdict: false,
        note: 'derived offline replay; the recorded run verdict remains authoritative',
        evidenceSha256: reevaluation.hash,
      } : { state: 'missing' },
      endpoint: endpointFacts(record, planSet.byRunId.get(record.runId)?.value ?? null),
      cost: costOf(record),
      cleanup: object(record.cleanup) ? {
        recorded: true,
        admission: record.cleanup.admission ?? 'unknown',
        providers: Array.isArray(record.cleanup.providers) ? record.cleanup.providers : [],
      } : null,
    };
  });

  const failedAttempts = runReports.filter((run) => run.originalVerdict.ok === false).length;
  const successfulAttempts = runReports.filter((run) => run.controlledFacts.controlledInstrumentationProven
    && run.controlVerdict.ok === true).length;
  const controlArmsExecuted = runReports.filter((run) => run.controlVerdict.state === 'recorded').length;

  return {
    schemaVersion: SUMMARY_SCHEMA,
    generatedAt,
    coverageInput,
    trust: { sources: [] },
    provenance: {
      linkage: linkages.unique.map((entry) => ({
        role: 'linkage', source: entry.name, sha256: entry.hash,
        schemaVersion: (entry.value?.report ?? entry.value)?.schemaVersion ?? null,
      })),
      budget: budgetSet.value ? [{
        role: 'budget', source: budgetSet.value.name, sha256: budgetSet.value.hash, schemaVersion: BUDGET_SCHEMA,
      }] : [],
      runs: runs.unique.map((entry) => ({
        role: 'run-record', source: entry.name, sha256: entry.hash, runId: entry.runId, schemaVersion: RUN_SCHEMA,
      })),
      reevaluations: reeval.unique.map((entry) => ({
        role: 'offline-reevaluation', source: entry.name, sha256: entry.hash,
        runId: entry.sourceRun, schemaVersion: REEVALUATION_SCHEMA,
      })),
      plans: planSet.unique.map((entry) => ({
        role: 'run-plan', source: entry.name, sha256: entry.hash, runId: entry.runId,
      })),
      pollutionAudits: pollution.value ? [{
        role: 'pollution-audit', source: pollution.value.name, sha256: pollution.value.hash,
        schemaVersion: POLLUTION_SCHEMA,
      }] : [],
    },
    duplicates: {
      linkage: linkages.duplicates,
      runRecords: runs.duplicates,
      reevaluations: reeval.duplicates,
      plans: planSet.duplicates,
      budgets: budgetSet.duplicates,
      pollutionAudits: pollution.duplicates,
    },
    units: {
      calls: {
        state: linkageFacts.sourceComplete ? 'recorded' : 'source_incomplete',
        observed: linkageFacts.invocations.length,
        reportedTotals: linkageFacts.reportedTotals,
        scope: 'behavior-linkage window; a call is not a decision opportunity',
      },
      runs: { state: 'recorded', observed: runReports.length, ids: runReports.map((run) => run.runId) },
      decisionOpportunities: {
        state: 'unknown',
        observed: 0,
        reason: 'no declared task-opportunity census; linking calls to opportunities is not permitted',
      },
      experimentAttempts: {
        state: 'recorded',
        observed: runReports.length,
        failed: failedAttempts,
        succeeded: successfulAttempts,
        controlArmsExecuted,
      },
    },
    runs: runReports,
    budget: summarizeBudget(budgetSet.value),
    coverage: null,
    coverageInterpretation: null,
    coverageGuards: {
      sourceComplete: linkageFacts.sourceComplete,
      incompleteReasons: linkageFacts.sourceComplete ? [] : ['linkage coverage is not complete or was truncated'],
      associationUsedAsCoverage: false,
      strongRunConfirmsDelivery: false,
      offlineReevaluationChangesRecordedVerdict: false,
      nativeDeliveryCountsAsControlledSuccess: false,
      populationDenominator: 'unknown',
    },
    productionExclusions: productionExclusions(pollution.value),
    benefitHarm: {
      state: 'not_evaluated',
      reason: 'no control arm and no independent evaluation evidence',
    },
    conclusionScope: linkageFacts.sourceComplete
      ? 'observed_records_only_no_population_denominator'
      : 'source_incomplete_no_population_denominator',
  };
}

/** Attach the summary produced by the existing statistician without altering its math. */
export function attachCoverage(adapted, coverageSummary, options = {}) {
  requireValid(object(adapted) && adapted.schemaVersion === SUMMARY_SCHEMA, 'adapted_summary_invalid');
  requireValid(object(coverageSummary), 'coverage_summary_invalid');
  const coverage = {
    ...coverageSummary,
    behavioralImprovement: 'not_evaluated',
    conclusionScope: adapted.conclusionScope,
  };
  return {
    ...adapted,
    coverage,
    coverageInterpretation: coverageInterpretation(coverage, adapted.units),
    unknowns: [
      'No decision-opportunity census exists, so T and all population ratios are unknown.',
      'No independently pinned request+action evidence exists, so D is unknown even where association is strong_run.',
      'The endpoint user body digest and frozen input digest differ; this limitation is preserved and does not decide D.',
      'The control arm never ran, so benefit, harm and causal improvement are not evaluated.',
      'A fake provider specified the tool; this does not show the Agent independently followed the principle.',
      ...(adapted.coverageGuards.sourceComplete ? [] : ['The linkage source reports incomplete or truncated coverage.']),
    ],
    nextDecisions: options.nextDecisions ?? [
      'Decide whether to run the untouched control arm under the remaining budget (1 host turn / 1 HTTP request).',
      'Decide whether a future run should capture independently pinned request and action evidence, or accept D as permanently unknown for this experiment.',
      'Decide whether to design a task-opportunity census before any overall coverage claim.',
    ],
  };
}

export const __test__ = { uniqueByHash, uniqueRuns, scopeArrays, gateCheckState };
