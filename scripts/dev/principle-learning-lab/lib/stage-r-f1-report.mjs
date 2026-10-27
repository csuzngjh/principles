// SPEC-PD-EXAMINER-001 v0.4 §12.4 — "报告可从轨迹重算" for Stage R F1:
// rebuilds the study report from RAW attempt files + ledgers + the
// authorization copy in a study directory. READ-ONLY over the study; output
// goes wherever the caller points it (CLI: --out, tests: buffer).
//
// Evidence sources actually consumed:
//   - runs/**/*.json attempt files   → per-unit settlement, rounds, tokens
//   - budget-ledger.jsonl            → RESERVE/REQUEST_RESERVE accounting
//   - adjudications.jsonl            → cross-checked against SUCCEEDED
//     attempt files (a SUCCEEDED record without its append-only adjudication
//     row — or vice versa — is an integrity finding, never a silent pass)
//   - events.jsonl                   → UNIT_FINISHED rows cross-checked
//     against the attempt-file settlement of the same unit+result
//   - suite-manifest.json / run-authorization.json → plan grid + auth snapshot
//
// Zero network, zero credentials, zero mutation of the study directory.

import fs from 'node:fs';
import path from 'node:path';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readJsonl = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

/** 1-based file line of the Nth non-blank line (readJsonl index → source line),
 *  so a malformed record can be located in the raw evidence. Never throws. */
const nonBlankLineOf = (file, nonBlankIndex) => {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let seen = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      seen += 1;
      if (seen === nonBlankIndex) return i + 1;
    }
  } catch { /* unreadable file: position unavailable */ }
  return '?';
};

const ARMS = ['A', 'B', 'C'];

/** Recompute the Stage R F1 study report from a study directory.
 *  Never throws on data problems — data faults become findings. */
export function buildStageRF1Report(studyDir) {
  const findings = [];
  const manifest = readJson(path.join(studyDir, 'suite-manifest.json'));
  const auth = readJson(path.join(studyDir, 'run-authorization.json'));
  const budget = readJsonl(path.join(studyDir, 'budget-ledger.jsonl'));
  const events = readJsonl(path.join(studyDir, 'events.jsonl'));
  const adjudications = readJsonl(path.join(studyDir, 'adjudications.jsonl'));

  // plan grid
  const planned = [];
  for (const c of manifest.cases) for (const arm of ARMS) planned.push({ caseId: c.caseId, armId: arm, repetitionId: 1, attemptId: 'a1' });
  const planKey = (u) => `${u.caseId}|${u.armId}|${u.repetitionId}|${u.attemptId}`;

  // attempts from raw files
  const files = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) files.push(p);
    }
  })(path.join(studyDir, 'runs'));

  const units = new Map(planned.map(u => [planKey(u), {
    ...u, status: 'NOT_SETTLED', rounds: 0, okRounds: 0, modelRequests: 0,
    identities: [], promptTokens: 0, completionTokens: 0,
    tracePresent: false, adjudicationPresent: false, objective: null, errorHead: null,
  }]));
  let duplicates = 0; const unplanned = [];
  for (const f of files) {
    const a = readJson(f);
    const key = planKey(a.unit);
    const row = units.get(key);
    if (!row) { unplanned.push(path.relative(path.join(studyDir, 'runs'), f)); continue; }
    if (row.status !== 'NOT_SETTLED') duplicates += 1; // second settlement of the same unit
    row.status = a.result;
    row.errorHead = a.error ? a.error.slice(0, 160) : null;
    row.tracePresent = !!a.trace && Array.isArray(a.trace.records);
    row.adjudicationPresent = !!a.adjudication;
    row.objective = a.adjudication ? a.adjudication.objectiveTaskOutcome : null;
    for (const r of a.actorRounds || []) {
      row.rounds += 1;
      if (r.ok === true) {
        row.okRounds += 1;
        if (r.observedModelIdentity) row.identities.push(r.observedModelIdentity);
        row.promptTokens += r.usage?.prompt_tokens ?? 0;
        row.completionTokens += r.usage?.completion_tokens ?? 0;
      }
    }
  }
  const reqRes = budget.filter(e => e.type === 'REQUEST_RESERVE');
  for (const e of reqRes) {
    const row = units.get(planKey(e.unit));
    if (row) row.modelRequests += 1; else unplanned.push(`REQUEST_RESERVE:${JSON.stringify(e.unit)}`);
  }

  // per-arm rollup (both denominators kept explicit)
  const byArm = {};
  for (const arm of ARMS) byArm[arm] = { planned: 0, SUCCEEDED: 0, RESULT_UNKNOWN: 0, FAILED_KNOWN: 0, NOT_SETTLED: 0, pass: 0, rounds: 0, okRounds: 0, modelRequests: 0, promptTokens: 0, completionTokens: 0 };
  const identities = new Set();
  let totalRounds = 0, totalOkRounds = 0, pTok = 0, cTok = 0;
  const statusCounts = {};
  for (const row of units.values()) {
    byArm[row.armId].planned += 1;
    byArm[row.armId][row.status] = (byArm[row.armId][row.status] || 0) + 1;
    if (row.status === 'SUCCEEDED' && row.objective === 'PASS') byArm[row.armId].pass += 1;
    byArm[row.armId].rounds += row.rounds; byArm[row.armId].okRounds += row.okRounds;
    byArm[row.armId].modelRequests += row.modelRequests;
    byArm[row.armId].promptTokens += row.promptTokens; byArm[row.armId].completionTokens += row.completionTokens;
    statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
    totalRounds += row.rounds; totalOkRounds += row.okRounds;
    pTok += row.promptTokens; cTok += row.completionTokens;
    for (const i of row.identities) identities.add(i);
    // data-integrity findings
    if (row.status === 'SUCCEEDED' && !(row.tracePresent && row.adjudicationPresent)) findings.push(`${row.caseId}/${row.armId}: SUCCEEDED without trace+adjudication`);
    if (row.status === 'RESULT_UNKNOWN' && row.errorHead && !row.errorHead.includes('request timeout after')) findings.push(`${row.caseId}/${row.armId}: RESULT_UNKNOWN with non-timeout error head`);
  }

  // pairing completeness: which case families have ALL THREE arms SUCCEEDED
  const completePairs = [];
  for (const c of manifest.cases) {
    const arms = ARMS.map(a => units.get(planKey({ caseId: c.caseId, armId: a, repetitionId: 1, attemptId: 'a1' })));
    if (arms.every(u => u.status === 'SUCCEEDED' && u.objective === 'PASS')) completePairs.push(c.caseId);
  }

  // ledger↔file cross-checks (the two append-only ledgers this report's
  // integrity claim depends on — see header). Mismatches become findings;
  // they never change any statistic above. Counts are grouped per unit key —
  // duplicates are NEVER folded away by a Set/Map: a repeated adjudication
  // row or UNIT_FINISHED event is itself an integrity finding whether or not
  // the copies agree, and no side of the comparison silently wins. Records
  // that parse but carry NO unit identity are flagged with their source line
  // — never silently skipped, never matched to any study unit.
  const settledRows = [...units.values()].filter(u => u.status !== 'NOT_SETTLED');
  const settledKey = (u) => `${u.caseId}|${u.armId}|${u.repetitionId}|${u.attemptId}`;
  const adjudicationCounts = new Map();
  const adjudicationsFile = path.join(studyDir, 'adjudications.jsonl');
  adjudications.forEach((a, index) => {
    if (!a || !a.unit) {
      findings.push(`adjudications.jsonl line ${nonBlankLineOf(adjudicationsFile, index)}: record without a unit field — cannot participate in unit matching`);
      return;
    }
    const key = planKey(a.unit);
    adjudicationCounts.set(key, (adjudicationCounts.get(key) || 0) + 1);
  });
  // every SUCCEEDED attempt file with adjudication data must have EXACTLY ONE ledger row
  for (const row of settledRows.filter(u => u.status === 'SUCCEEDED' && u.adjudicationPresent)) {
    const count = adjudicationCounts.get(settledKey(row)) || 0;
    if (count === 0) findings.push(`${row.caseId}/${row.armId}: SUCCEEDED record has no adjudications.jsonl row`);
    else if (count > 1) findings.push(`${row.caseId}/${row.armId}: ${count} duplicate adjudications.jsonl rows for one SUCCEEDED record`);
  }
  // every adjudication row must map to an in-plan SUCCEEDED attempt file that carries adjudication data
  for (const [key] of adjudicationCounts) {
    const row = units.get(key);
    if (!row || row.status !== 'SUCCEEDED' || !row.adjudicationPresent) {
      findings.push(`adjudications.jsonl row ${key.replaceAll('|', '/')} has no matching SUCCEEDED attempt file`);
    }
  }
  const finishedGroups = new Map();
  const eventsFile = path.join(studyDir, 'events.jsonl');
  events.forEach((e, index) => {
    if (!e || e.type !== 'UNIT_FINISHED') return;
    if (!e.unit) {
      findings.push(`events.jsonl line ${nonBlankLineOf(eventsFile, index)}: UNIT_FINISHED event without a unit field — cannot participate in unit matching`);
      return;
    }
    const key = planKey(e.unit);
    if (!finishedGroups.has(key)) finishedGroups.set(key, []);
    finishedGroups.get(key).push(e.result);
  });
  // every settled attempt must have EXACTLY ONE matching event, same result
  for (const row of settledRows) {
    const group = finishedGroups.get(settledKey(row));
    if (group === undefined) {
      findings.push(`${row.caseId}/${row.armId}: settled ${row.status} in attempt file but no UNIT_FINISHED event`);
    } else if (group.length > 1) {
      const agree = group.every((r) => r === group[0]);
      findings.push(`${row.caseId}/${row.armId}: ${group.length} duplicate UNIT_FINISHED events (${agree ? 'same result' : 'conflicting results'}: ${group.join(', ')})`);
    } else if (group[0] !== row.status) {
      findings.push(`${row.caseId}/${row.armId}: UNIT_FINISHED says ${group[0]}, attempt file says ${row.status}`);
    }
  }
  // every event must point at an in-plan unit that actually settled (orphan events included)
  for (const [key, group] of finishedGroups) {
    const row = units.get(key);
    if (row === undefined) {
      findings.push(`UNIT_FINISHED event for unplanned unit ${key.replaceAll('|', '/')} (${group.join(', ')})`);
    } else if (row.status === 'NOT_SETTLED') {
      findings.push(`UNIT_FINISHED ${group[0]} for ${key.replaceAll('|', '/')} but the unit has no settled attempt file`);
    }
  }

  // authorization snapshot (from the copy — the study's own authority)
  const authorized = {
    status: auth.status, identity: auth.requestedActorIdentity, executionMode: auth.executionMode,
    attemptCap: auth.attemptCap, requestCap: auth.requestCap, requestTimeoutMs: auth.requestTimeoutMs ?? null,
    validFrom: auth.validFrom, validUntil: auth.validUntil, issuedBy: auth.issuedBy,
  };

  const attemptsUsed = budget.filter(e => e.type === 'RESERVE').length;
  const requestsUsed = reqRes.length;
  return {
    schema: 'stage-r-f1-report.v1',
    generatedAt: new Date().toISOString(),
    studyId: manifest.studyId,
    authorization: authorized,
    budget: { attemptsUsed, attemptsRemaining: (auth.attemptCap ?? 0) - attemptsUsed, requestsUsed, requestsRemaining: (auth.requestCap ?? 0) - requestsUsed },
    plan: { plannedUnits: planned.length, arms: Object.fromEntries(ARMS.map(a => [a, planned.filter(u => u.armId === a).length])) },
    statusCounts,
    denominators: {
      allPlanned: planned.length,
      successfullyScored: statusCounts.SUCCEEDED || 0,
      unknown: statusCounts.RESULT_UNKNOWN || 0,
      failedKnown: statusCounts.FAILED_KNOWN || 0,
    },
    totals: { rounds: totalRounds, okRounds: totalOkRounds, promptTokens: pTok, completionTokens: cTok, identities: [...identities] },
    byArm,
    completeTripleArmPairs: completePairs,
    integrity: { duplicates, unplanned, findings },
    units: [...units.values()].map(u => ({
      caseId: u.caseId, armId: u.armId, status: u.status, objective: u.objective,
      rounds: u.rounds, okRounds: u.okRounds, modelRequests: u.modelRequests,
      identities: [...new Set(u.identities)], promptTokens: u.promptTokens, completionTokens: u.completionTokens,
      errorHead: u.errorHead,
    })),
  };
}
