// Adapter from recorded AA evidence to the existing coverage-input contract.
// This module never computes coverage itself: it normalizes sources, removes
// duplicate rows, and delegates T/V/O/D math to summarize-adaptive-coverage.mjs.
// Association facts (including strong_run) are observations, not coverage.
import { hashOfCanonical } from '../challenge-freeze.mjs';
import { adaptiveConfigIdentity } from './adaptive-config-identity.mjs';

export const SUMMARY_SCHEMA = 'pd-aa-coverage-summary/v1';
export const COVERAGE_INPUT_SCHEMA = 'aa-coverage-input.v1';

// SPEC v0.6 section 6.1, reproduced verbatim in meaning. These definitions are
// the only authority for the report's T/V/O/D labels; delivery, adherence and
// association are separate observations and cannot be substituted for them.
export const COVERAGE_DEFINITIONS = {
  T: 'theoretical decision opportunity: a real decision that could be changed, an authorized principle, and a plausible pre-action intervention window; requires a declared opportunity census',
  V: 'eligible signal visible before the action on the selected profile; visibility is not delivery',
  O: 'PD actually recognized the opportunity before the key action; recognition is not Agent adherence',
  D: "independent confirmation that the exact target body entered the same decision's actual request and preceded the key action",
};

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
    source: 'coverage-input opportunities[].classification.V + pre-action eligible-signal visibility evidence',
    eligibility: 'among T: an eligible signal is visible before the action on the selected profile; visibility is not delivery',
    missingOutput: 'unknown; delivery or strong_run alone is insufficient',
  },
  {
    statisticField: 'O',
    source: 'coverage-input opportunities[].classification.O + pre-action recognition evidence',
    eligibility: 'among V: PD actually recognized the opportunity before the key action; recognition is not Agent adherence',
    missingOutput: 'unknown; fake-provider tool choice or Agent adherence is not recognition',
  },
  {
    statisticField: 'D',
    source: 'existing verify-adaptive-delivery.mjs over independently pinned request/action captures',
    eligibility: "among O: independent confirmation that the exact target body entered the same decision's actual model request and preceded the key action",
    missingOutput: 'unknown; native delivery, offline replay or a returned receipt cannot confirm D',
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
  // Keep the identity namespaces separate. A run id may never satisfy a
  // session-id comparison (or vice versa), because that silently turns an
  // unrelated field collision into an experiment-level association.
  const ids = { runIds: new Set(), sessionIds: new Set(), hookInvocationIds: new Set() };
  for (const check of gateChecks(record)) {
    const evidence = object(check.evidence) ? check.evidence : {};
    const consumedBy = object(evidence.consumedBy) ? evidence.consumedBy : null;
    if (consumedBy) {
      if (text(consumedBy.runId)) ids.runIds.add(consumedBy.runId);
      if (text(consumedBy.sessionId)) ids.sessionIds.add(consumedBy.sessionId);
      if (text(consumedBy.hookInvocationId)) ids.hookInvocationIds.add(consumedBy.hookInvocationId);
    }
    if (text(evidence.runId)) ids.runIds.add(evidence.runId);
    if (text(evidence.sessionId)) ids.sessionIds.add(evidence.sessionId);
    if (text(evidence.hookInvocationId)) ids.hookInvocationIds.add(evidence.hookInvocationId);
  }
  return ids;
}

function sortedHookIds(invocations) {
  return invocations.map((invocation) => invocation.hookInvocationId).sort();
}

function ambiguousMatch(basis, invocations, reason) {
  return {
    state: 'ambiguous',
    basis,
    reason,
    candidates: [...invocations].sort((a, b) => a.hookInvocationId.localeCompare(b.hookInvocationId)),
  };
}

function linkageFromMatch(match) {
  if (!match || match.state === 'no_matching_invocation') {
    return {
      state: 'no_matching_invocation',
      reason: match?.reason ?? null,
      candidateHookInvocationIds: match?.candidateHookInvocationIds ?? [],
      experimentLevelStrongLink: false,
    };
  }
  if (match.state === 'ambiguous') {
    return {
      state: 'ambiguous',
      matchStrength: 'none',
      experimentLevelStrongLink: false,
      matchBasis: match.basis,
      reason: match.reason,
      candidateHookInvocationIds: match.candidates.map((candidate) => candidate.hookInvocationId).sort(),
      candidateAssociations: match.candidates.map((candidate) => ({
        hookInvocationId: candidate.hookInvocationId,
        association: candidate.association,
      })),
    };
  }
  if (match.state === 'contradictory_identity') {
    return {
      state: 'contradictory_identity',
      matchStrength: 'none',
      experimentLevelStrongLink: false,
      matchBasis: match.basis,
      reason: match.reason,
      candidateHookInvocationIds: match.candidateHookInvocationIds,
    };
  }
  const strong = match.strength === 'strong';
  return {
    state: strong ? 'matched_by_run' : 'weak_candidate',
    matchStrength: match.strength,
    experimentLevelStrongLink: strong,
    matchBasis: match.basis,
    matchDeltaMs: match.deltaMs ?? null,
    hookInvocationId: match.invocation.hookInvocationId,
    association: match.invocation.association,
    requestAssociation: match.invocation.evidenceLayers.requestAssociation ?? 'unknown',
    principleAdherence: match.invocation.evidenceLayers.principleAdherence ?? 'unknown',
    actionOrdering: match.invocation.actionOrdering,
    toolNames: match.invocation.toolNames,
  };
}

function matchingInvocation(invocations, record) {
  const ids = hostIdentities(record);

  // A trusted hookInvocationId is an explicit reference; use it first. If the
  // record carries one but it is absent from this linkage report, do not fall
  // back to weaker identity or time evidence and pretend the reference matched.
  if (ids.hookInvocationIds.size > 0) {
    const byHook = invocations.filter((invocation) => ids.hookInvocationIds.has(invocation.hookInvocationId));
    if (byHook.length === 1) {
      return { state: 'matched', strength: 'strong', basis: 'hook_invocation_id', invocation: byHook[0] };
    }
    if (byHook.length > 1) return ambiguousMatch('hook_invocation_id', byHook, 'multiple_hook_id_candidates');
    return {
      state: 'no_matching_invocation',
      reason: 'explicit_hook_invocation_id_not_found',
      candidateHookInvocationIds: sortedHookIds(invocations),
    };
  }

  // Field-specific run identity. A session-id match cannot confirm a run, and
  // a run-id match paired with a different recorded session id is a
  // contradiction rather than a strong link.
  const runMatches = [];
  const contradictions = [];
  if (ids.runIds.size > 0) {
    for (const invocation of invocations) {
      if (!text(invocation.runId) || !ids.runIds.has(invocation.runId)) continue;
      if (text(invocation.sessionId) && ids.sessionIds.size > 0
        && !ids.sessionIds.has(invocation.sessionId)) {
        contradictions.push(invocation);
        continue;
      }
      runMatches.push(invocation);
    }
  }
  if (runMatches.length > 1) return ambiguousMatch('run_identity', runMatches, 'multiple_run_id_candidates');
  if (runMatches.length === 1) {
    return { state: 'matched', strength: 'strong', basis: 'run_identity', invocation: runMatches[0] };
  }
  if (contradictions.length > 0) {
    return {
      state: 'contradictory_identity',
      basis: 'run_identity',
      reason: 'run_id_matches_but_session_id_differs',
      candidateHookInvocationIds: sortedHookIds(contradictions),
    };
  }

  // A shared session alone is only a weak candidate: many runs can share one
  // session, so it cannot establish which run contained this action.
  const sessionMatches = [];
  if (ids.sessionIds.size > 0) {
    for (const invocation of invocations) {
      if (!text(invocation.sessionId) || !ids.sessionIds.has(invocation.sessionId)) continue;
      if (text(invocation.runId) && ids.runIds.size > 0 && !ids.runIds.has(invocation.runId)) continue;
      sessionMatches.push(invocation);
    }
  }
  if (sessionMatches.length > 1) return ambiguousMatch('session_identity', sessionMatches, 'multiple_session_id_candidates');
  if (sessionMatches.length === 1) {
    return { state: 'matched', strength: 'weak', basis: 'session_identity_only', invocation: sessionMatches[0] };
  }

  // Timestamp proximity can suggest a candidate, never confirm the run. All
  // candidates within the window are reported; without an identity match the
  // caller must treat the association as unproven.
  const recordedAt = scopeArrays(record, 'toolCalls')
    .map((row) => row.recordedAt).filter(text)
    .map((value) => Date.parse(value)).filter(Number.isFinite);
  if (recordedAt.length === 0) return { state: 'no_matching_invocation' };
  const proximity = [];
  for (const invocation of invocations) {
    const actionTimes = invocation.actionTimes ?? [];
    let best = Number.NaN;
    for (const time of actionTimes) {
      const delta = Math.min(...recordedAt.map((value) => Math.abs(time - value)));
      if (Number.isFinite(delta) && delta <= 5000 && (!Number.isFinite(best) || delta < best)) best = delta;
    }
    if (Number.isFinite(best)) proximity.push({ invocation, deltaMs: best });
  }
  if (proximity.length === 0) return { state: 'no_matching_invocation' };
  proximity.sort((a, b) => a.deltaMs - b.deltaMs
    || a.invocation.hookInvocationId.localeCompare(b.invocation.hookInvocationId));
  if (proximity.length > 1) {
    return ambiguousMatch('action_timestamp_proximity', proximity.map((row) => row.invocation), 'multiple_proximity_candidates');
  }
  return {
    state: 'matched',
    strength: 'weak',
    basis: 'action_timestamp_proximity',
    invocation: proximity[0].invocation,
    deltaMs: proximity[0].deltaMs,
  };
}

function semanticInvocation(invocation) {
  // Only facts and identity participate in duplicate/conflict comparison.
  // Report-time diagnostics (unknowns, weakCandidates, associationReasons,
  // conflicts) are derived and may legitimately differ between two reports of
  // the same invocation.
  return {
    intervention: {
      hookInvocationId: invocation.intervention?.hookInvocationId ?? null,
      runId: invocation.intervention?.runId ?? null,
      sessionId: invocation.intervention?.sessionId ?? null,
      host: invocation.intervention?.host ?? null,
      workspaceVerified: invocation.intervention?.workspaceVerified ?? null,
      artifactId: invocation.intervention?.artifactId ?? null,
      activationId: invocation.intervention?.activationId ?? null,
      targetBodySha256: invocation.intervention?.targetBodySha256 ?? null,
      configIdentity: invocation.intervention?.configIdentity ?? null,
      terminal: invocation.intervention?.terminal ?? null,
      openTs: invocation.intervention?.openTs ?? null,
      terminalTs: invocation.intervention?.terminalTs ?? null,
    },
    association: invocation.association ?? null,
    evidenceLayers: invocation.evidenceLayers ?? null,
    facts: invocation.facts ?? null,
  };
}

function canonicalUnique(values) {
  const byHash = new Map();
  for (const value of values) {
    if (value === undefined || value === null) continue;
    byHash.set(hashOfCanonical(value), value);
  }
  return [...byHash.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

function oneOrMany(values) {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  return { state: 'multiple', values };
}

function linkageInvocations(linkageEntries) {
  const seen = new Map();
  let duplicates = 0;
  const invocations = [];
  let sourceComplete = null;
  const windows = [];
  const workspaces = [];
  const hosts = [];
  const totals = [];
  const configs = [];
  for (const entry of linkageEntries) {
    const report = linkageReportOf(entry.value);
    requireValid(report !== null, 'linkage_schema_invalid');
    if (object(report.totals)) totals.push(report.totals);
    if (object(report.coverage?.window)) windows.push(report.coverage.window);
    const workspaceDir = text(report.request?.workspaceDir) ? report.request.workspaceDir : null;
    const host = text(report.request?.host) ? report.request.host : null;
    if (workspaceDir !== null) workspaces.push(workspaceDir);
    if (host !== null) hosts.push(host);
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
      const config = object(invocation.intervention.configIdentity) ? invocation.intervention.configIdentity : {};
      const scope = { workspaceDir, host, configDigest: hashOfCanonical(config) };
      const scopeHash = hashOfCanonical(scope);
      const semanticHash = hashOfCanonical(semanticInvocation(invocation));
      if (seen.has(key)) {
        const prior = seen.get(key);
        // Equal invocation ids are only duplicates when they describe the same
        // invocation in the same workspace/host/config scope. Different facts
        // are a conflict, never a silent dedupe.
        if (prior.scopeHash !== scopeHash) throw new TypeError('conflicting_linkage_scopes');
        if (prior.semanticHash !== semanticHash) throw new TypeError('conflicting_linkage_invocations');
        duplicates++;
        continue;
      }
      seen.set(key, { scopeHash, semanticHash });
      configs.push(config);
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
  const configIdentities = [...new Set(configs.map((config) => hashOfCanonical(config)))].sort();
  return {
    invocations,
    duplicates,
    sourceComplete: sourceComplete === null ? false : sourceComplete,
    window: oneOrMany(canonicalUnique(windows)),
    workspaceDir: oneOrMany(canonicalUnique(workspaces)),
    host: oneOrMany(canonicalUnique(hosts)),
    configVariants: canonicalUnique(configs),
    configIdentities,
    scopeVariants: {
      windows: canonicalUnique(windows),
      workspaces: canonicalUnique(workspaces),
      hosts: canonicalUnique(hosts),
      configIdentities,
    },
    reportedTotals: oneOrMany(canonicalUnique(totals)),
  };
}

function commonConfigValue(variants, key) {
  const known = variants.map((variant) => variant[key]).filter((value) => value !== undefined && value !== null);
  const unique = new Set(known.map((value) => JSON.stringify(value)));
  if (unique.size !== 1) return undefined;
  return known[0];
}

function buildConfig(linkage, hostFromReport) {
  const variants = Array.isArray(linkage.configVariants) ? linkage.configVariants : [];
  const host = text(hostFromReport) && ['openclaw', 'codex', 'workbuddy'].includes(hostFromReport)
    ? hostFromReport : 'unknown';
  const coverage = commonConfigValue(variants, 'evidenceCoverage');
  return {
    host,
    hostVersion: text(commonConfigValue(variants, 'hostVersion')) ? commonConfigValue(variants, 'hostVersion') : 'unknown',
    runtimeMode: text(commonConfigValue(variants, 'runtimeMode')) ? commonConfigValue(variants, 'runtimeMode') : 'unknown',
    pluginVersion: text(commonConfigValue(variants, 'pluginVersion')) ? commonConfigValue(variants, 'pluginVersion') : 'unknown',
    effectiveHookSetFingerprint: text(commonConfigValue(variants, 'effectiveHookSetFingerprint'))
      ? commonConfigValue(variants, 'effectiveHookSetFingerprint') : 'unknown',
    evidenceCoverage: coverage === 'complete' || coverage === 'partial' ? coverage : 'unknown',
  };
}

function buildCoverageInput(linkage) {
  const config = buildConfig(linkage, linkage.host);
  const identity = adaptiveConfigIdentity(config);
  requireValid(identity !== null, 'config_identity_invalid');
  const workspaceId = text(linkage.workspaceDir)
    ? `workspace-sha256:${hashOfCanonical(linkage.workspaceDir).slice(0, 16)}`
    : object(linkage.workspaceDir) && Array.isArray(linkage.workspaceDir.values)
      ? `workspaces-sha256:${hashOfCanonical(linkage.workspaceDir.values).slice(0, 16)}`
      : 'workspace:unknown';
  const window = linkage.window ?? {};
  const windowId = text(window.start) && text(window.end)
    ? `window:${window.start}..${window.end}`
    : Array.isArray(window.values)
      ? `windows-sha256:${hashOfCanonical(window.values).slice(0, 16)}`
      : 'window:unknown';
  const opportunities = linkage.invocations.map((invocation) => ({
    // A hook invocation is a call. Minting an opportunity id from it would
    // silently turn callback volume into an opportunity denominator.
    opportunityId: null,
    classification: { T: 'unknown', V: 'unknown', O: 'unknown' },
    classificationReferences: {
      T: 'missing:no_decision_opportunity_census',
      V: 'missing:no_pre_action_eligible_signal_visibility',
      O: 'missing:no_pre_action_recognition',
      D: 'missing:no_independent_request_and_action_order',
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
  const runsKnown = units?.runs?.state !== 'unknown';
  const controlExecuted = units?.experimentAttempts?.controlArmsExecuted ?? 0;
  return {
    T: layer('T', 'no declared decision-opportunity census; calls and runs are not the denominator'),
    V: layer('V', 'no linked opportunity with a pre-action visible eligible signal; visibility is not delivery'),
    O: layer('O', 'no linked opportunity with PD pre-action recognition; recognition is not Agent adherence'),
    D: layer('D', 'no independently pinned confirmation that the target body entered the actual request before the key action; strong_run is not D'),
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
    benefit: {
      state: 'not_evaluated',
      value: null,
      reason: !runsKnown
        ? 'no run record supplied; benefit and harm are not evaluated'
        : controlExecuted === 0
          ? 'no executed control arm and no evaluation evidence'
          : 'no evaluation evidence',
    },
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
  const linkages = uniqueByHash(linkage, 'linkage');
  const reeval = uniqueReevaluations(reevaluations);
  const planSet = uniquePlans(plans);
  const budgetSet = uniqueBudgets(budget);
  const pollution = uniquePollutionAudits(pollutionAudits);

  const linkageFacts = linkageInvocations(linkages.unique);
  const coverageInput = buildCoverageInput(linkageFacts);

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
      linkage: linkageFromMatch(match),
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

  const runsRecorded = runReports.length > 0;
  return {
    schemaVersion: SUMMARY_SCHEMA,
    generatedAt,
    coverageInput,
    definitions: COVERAGE_DEFINITIONS,
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
      invocations: linkageFacts.duplicates,
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
        scopeVariants: linkageFacts.scopeVariants,
      },
      runs: {
        state: runsRecorded ? 'recorded' : 'unknown',
        observed: runReports.length,
        ids: runReports.map((run) => run.runId),
      },
      decisionOpportunities: {
        state: 'unknown',
        observed: 0,
        reason: 'no declared task-opportunity census; linking calls to opportunities is not permitted',
      },
      experimentAttempts: {
        state: runsRecorded ? 'recorded' : 'unknown',
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
      reason: runsRecorded
        ? 'no independent evaluation evidence; benefit and harm stay not evaluated'
        : 'no run record supplied; benefit and harm stay not evaluated',
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
  const runs = Array.isArray(adapted.runs) ? adapted.runs : [];
  const runsKnown = adapted.units?.runs?.state !== 'unknown';
  const controlExecuted = adapted.units?.experimentAttempts?.controlArmsExecuted ?? 0;
  const endpointDifferent = runs.some((run) => run.endpoint?.userMessageMatchesFrozenInput === 'different');
  const remaining = adapted.budget?.remaining ?? {};
  const budgetLimits = [];
  if (Number.isFinite(remaining.hostTurns)) budgetLimits.push(`${remaining.hostTurns} 次宿主回合`);
  if (Number.isFinite(remaining.httpRequests)) budgetLimits.push(`${remaining.httpRequests} 次 HTTP 请求`);
  const budgetSuffix = budgetLimits.length ? `（剩余 ${budgetLimits.join(' / ')}）` : '';
  const unknowns = [
    '没有任务机会普查，因此 T 与总体比例均为 unknown。',
    runsKnown
      ? '没有独立固定的 request 与 action 证据，因此即使 association=strong_run，D 仍为 unknown。'
      : '未提供运行记录，因此 D 为 unknown，也没有可用的实验结论。',
    ...(endpointDifferent
      ? ['端点用户正文摘要与冻结输入不同；该限制保留，不据此判定 D。'] : []),
    runsKnown
      ? (controlExecuted === 0
        ? '已提供的记录中没有执行对照，因此收益、损害与因果改善均未评价。'
        : '对照已执行，但没有独立评价证据，因此收益、损害与因果改善均未评价。')
      : '未提供运行记录，实验尝试与对照状态均为 unknown。',
    ...(runsKnown
      ? ['假 provider 指定工具，不代表 Agent 自主遵循原则。'] : []),
    ...(adapted.coverageGuards.sourceComplete ? [] : ['linkage 来源报告覆盖不完整或被截断。']),
  ];
  return {
    ...adapted,
    coverage,
    coverageInterpretation: coverageInterpretation(coverage, adapted.units),
    unknowns,
    nextDecisions: options.nextDecisions ?? [
      ...(runsKnown ? [] : ['先补齐该证据集的 run-record，再得出任何实验结论。']),
      ...(runsKnown && controlExecuted === 0
        ? [`决定是否在剩余预算内执行未动的对照臂${budgetSuffix}。`] : []),
      ...(runsKnown
        ? ['决定未来运行是否采集独立固定的 request 与 action 证据，或接受本实验 D 永久为 unknown。'] : []),
      '在作出任何总体覆盖率结论前，决定是否设计任务机会普查。',
    ],
  };
}

export const __test__ = { uniqueByHash, uniqueRuns, scopeArrays, gateCheckState };
