// SPEC-PD-EXAMINER-001 v0.4 — E-arm merge-based candidate adoption.
//
// Round-5 finding: the constrained input deliberately excludes judge-only
// fields (goldTruth/implies/gold), so the model CANNOT know the full caseDef
// envelope shape — it naturally echoes the input combination structure. The
// option-B contract is therefore completed by a MECHANICAL MERGE:
//   merged caseDef = frozen baseline skeleton (immutable fields) + model's
//   expression-layer fields (whitelisted: taskText, fact statements, obs
//   labels/outputs, constraints, stakes) matched by factId/obsId.
// The model is structurally unable to touch gold through this path: immutable
// fields are copied from the frozen baseline, never from model output. The
// skeleton gate + validator still run on the merged candidate and reject
// expression drift (polarity flags, leakage, out-of-domain params).
//
// No prompt is changed by this module; it only INTERPRETS the shapes models
// plausibly return (draft-level, top-level, or actorVisibleCase-level).

import { enumerateCandidates } from './challenge-enumerator.mjs';

function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] !== undefined) return obj[k];
  return undefined;
}

function extractExpressionFields(raw) {
  // Model output shapes seen in round5 / plausibly ahead:
  //  A) { candidateId, draft: {taskText, facts, observations, constraints}, caseDef: {...} }
  //  B) { candidateId, taskText, facts, observations, constraints }
  //  C) { candidateId, caseDef: {taskText, facts, ...} }
  //  D) { candidateId, actorVisibleCase: {taskText, facts, observations, constraints} }
  const d = raw && raw.draft;
  const cd = raw && raw.caseDef;
  const avc = raw && raw.actorVisibleCase;
  return {
    taskText: pick(raw, ['taskText']) ?? pick(d, ['taskText']) ?? pick(cd, ['taskText']) ?? pick(avc, ['taskText']),
    facts: pick(raw, ['facts']) ?? pick(d, ['facts']) ?? pick(cd, ['facts']) ?? pick(avc, ['facts']),
    observations: pick(raw, ['observations']) ?? pick(d, ['observations']) ?? pick(cd, ['observations']) ?? pick(avc, ['observations']),
    constraints: pick(raw, ['constraints']) ?? pick(d, ['constraints']) ?? pick(cd, ['constraints']) ?? pick(avc, ['constraints']),
    rationale: pick(d, ['rationaleForDesigner']) ?? pick(raw, ['rationaleForDesigner']) ?? pick(raw, ['rationale']) ?? null,
    declaredParameters: (d && d.parameters) || (raw && raw.parameters) || null,
  };
}

/**
 * Merge model expression output onto the frozen baseline candidate for the
 * same (family, domain, distractor). Immutable fields NEVER come from the
 * model. Returns null when the model output cannot be interpreted.
 */
export function mergeModelOutputToCandidate({ modelCandidate, inputCombination, baselineCandidate }) {
  if (!modelCandidate || typeof modelCandidate !== 'object') return null;
  const expr = extractExpressionFields(modelCandidate);
  if (typeof expr.taskText !== 'string' || !Array.isArray(expr.facts) || !Array.isArray(expr.observations)) return null;

  const merged = JSON.parse(JSON.stringify(baselineCandidate.caseDef));
  merged.taskText = String(expr.taskText);

  // facts: match by factId — only statement (+ optional stakes within domain) may change.
  const modelFacts = expr.facts.filter((f) => f && typeof f.factId === 'string');
  if (modelFacts.length === 0) return null;
  for (const mf of modelFacts) {
    const target = merged.facts.find((f) => f.factId === mf.factId);
    if (!target) continue; // unknown fact — cannot exist; baseline fact set is fixed
    if (typeof mf.statement === 'string' && mf.statement.length > 0) target.statement = mf.statement;
    if (mf.stakes !== undefined) target.stakes = mf.stakes; // domain-checked by validator
  }

  // observations: match by obsId — only label/output wording may change.
  const modelObs = expr.observations.filter((o) => o && typeof o.obsId === 'string');
  if (modelObs.length === 0 && (merged.observations || []).length > 0) {
    // model must echo at least the observation identities it keeps; if it omits
    // them entirely, keep baseline labels/outputs (still structurally valid).
  }
  for (const mo of modelObs) {
    const target = merged.observations.find((o) => o.obsId === mo.obsId);
    if (!target) continue;
    if (typeof mo.label === 'string' && mo.label.length > 0) target.label = mo.label;
    if (typeof mo.output === 'string' && mo.output.length > 0) target.output = mo.output;
  }

  // constraints: wholesale replace (validator enforces value domains).
  if (expr.constraints && typeof expr.constraints === 'object') {
    merged.constraints = {
      budgetUnits: expr.constraints.budgetUnits ?? merged.constraints.budgetUnits,
      deadlineUnits: expr.constraints.deadlineUnits ?? merged.constraints.deadlineUnits,
      askOwnerAllowed: expr.constraints.askOwnerAllowed ?? merged.constraints.askOwnerAllowed,
    };
  }

  const candidateId = `E-${merged.caseId || inputCombination.candidateId || 'cand'}-${Math.abs(hashStr(modelCandidate.candidateId || JSON.stringify(expr.taskText))) % 100000}`;
  merged.caseId = candidateId;

  const draft = {
    scenarioId: candidateId,
    family: baselineCandidate.draft.family,
    templateId: baselineCandidate.draft.templateId,
    templateVersion: baselineCandidate.draft.templateVersion,
    parameters: { ...(baselineCandidate.draft.parameters || {}), strategy: 'e-expressive-merge-v1' },
    sourceMechanismRef: baselineCandidate.draft.sourceMechanismRef,
    rationaleForDesigner: expr.rationale || `E 表达层改写（基于冻结骨架 ${inputCombination.candidateId || baselineCandidate.candidateId}）`,
  };

  return {
    candidateId,
    syntheticTestFixture: false,
    draft,
    caseDef: merged,
    sourceBinding: baselineCandidate.sourceBinding,
    provenance: { generator: 'e-arm expressive merge v1', modelCalls: 1, mergeBase: baselineCandidate.candidateId },
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Full E-arm adoption: interpret a raw model candidate, find its baseline by
 * declared parameters (or candidateId), merge, and return the adoptable
 * envelope — or a structured rejection reason.
 */
export function adoptRawModelCandidate({ rawCandidate, spec }) {
  const expr = rawCandidate && extractExpressionFields(rawCandidate);
  if (!expr || typeof expr.taskText !== 'string' || !Array.isArray(expr.facts)) {
    return { adoptable: false, reason: 'model output shape not interpretable (no taskText/facts found at any level)', declaredBaselineMismatch: false };
  }
  // Locate the baseline: prefer declared domain/distractor, else match by candidateId echo.
  const params = (rawCandidate.draft && rawCandidate.draft.parameters) || rawCandidate.parameters
    || (rawCandidate.caseDef && rawCandidate.caseDef.parameters) || null;
  const pool = enumerateCandidates({ mappingId: spec.mappingId, mappingHash: spec.mappingHash });
  let baseline = null;
  let declaredBaselineMismatch = false;
  if (params && params.domain && params.distractor) {
    baseline = pool.find((c) => c.draft.parameters.domain === params.domain && c.draft.parameters.distractor === params.distractor);
    if (!baseline) declaredBaselineMismatch = true; // declared a combination that doesn't exist — claim ignored
  }
  if (!baseline && typeof rawCandidate.candidateId === 'string') {
    const id = rawCandidate.candidateId;
    baseline = pool.find((c) => id.startsWith(c.candidateId) || c.candidateId.startsWith(id.replace(/^E-/, '')));
  }
  if (!baseline) return { adoptable: false, reason: 'cannot resolve baseline combination (no matching domain/distractor or candidateId echo)', declaredBaselineMismatch };
  if (params && params.domain && params.distractor && (params.domain !== baseline.draft.parameters.domain || params.distractor !== baseline.draft.parameters.distractor)) {
    declaredBaselineMismatch = true; // anchored via candidateId but declared a different combination — claim ignored, recorded
  }

  const mergedEnvelope = mergeModelOutputToCandidate({ modelCandidate: rawCandidate, inputCombination: baseline, baselineCandidate: baseline });
  if (!mergedEnvelope) return { adoptable: false, reason: 'expression fields not extractable from model output', declaredBaselineMismatch };
  return { adoptable: true, candidate: mergedEnvelope, baselineCandidateId: baseline.candidateId, declaredBaselineMismatch };
}

/** v0.5 uses one closed expression envelope, without v1's permissive shape
 * recovery. Registered candidates remain the sole owner of gold/actions. */
export function adoptProductizationCandidate({ rawCandidate, registeredCandidates }) {
  const problems = [];
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  const keys = (value, allowed, at) => {
    if (!object(value)) { problems.push(`${at} must be an object`); return; }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`unknown ${at} field: ${key}`);
    for (const key of allowed) if (!Object.hasOwn(value, key)) problems.push(`missing ${at} field: ${key}`);
  };
  keys(rawCandidate, ['schema', 'candidateId', 'baselineCandidateId', 'templateId', 'templateVersion', 'parameters', 'expression'], 'candidate');
  if (!object(rawCandidate)) return { adoptable: false, reason: problems.join('; ') };
  if (rawCandidate.schema !== 'examiner-expression.v2') problems.push('unknown expression schema');
  if (!text(rawCandidate.candidateId) || !/^[A-Za-z0-9_-]{1,100}$/.test(rawCandidate.candidateId)) problems.push('candidateId must be a safe identifier');
  const baseline = registeredCandidates.find((c) => c.candidateId === rawCandidate.baselineCandidateId);
  if (!baseline) problems.push('unknown registered baselineCandidateId');
  if (baseline && (rawCandidate.templateId !== baseline.draft.templateId || rawCandidate.templateVersion !== baseline.draft.templateVersion)) problems.push('unknown template identity/version');
  keys(rawCandidate.parameters, ['budgetUnits', 'deadlineUnits', 'askOwnerAllowed'], 'parameters');
  const p = rawCandidate.parameters;
  if (object(p) && (!Number.isSafeInteger(p.budgetUnits) || p.budgetUnits < 0 || !Number.isSafeInteger(p.deadlineUnits) || p.deadlineUnits < 0 || typeof p.askOwnerAllowed !== 'boolean')) problems.push('parameters outside registered value domain');
  // Budget changes may change which gold alternatives are obtainable. v2
  // accepts only the constraint point that was independently registered.
  if (baseline && object(p) && ['budgetUnits', 'deadlineUnits', 'askOwnerAllowed'].some((k) => p[k] !== baseline.caseDef.constraints[k])) problems.push('parameters differ from registered decision point');
  keys(rawCandidate.expression, ['taskText', 'facts', 'observations'], 'expression');
  const expr = rawCandidate.expression;
  if (object(expr)) {
    if (!text(expr.taskText) || expr.taskText.length > 600) problems.push('expression.taskText must contain 1..600 characters');
    for (const [field, idKey, allowed, baselineRows] of [
      ['facts', 'factId', ['factId', 'statement'], baseline?.caseDef.facts],
      ['observations', 'obsId', ['obsId', 'label'], baseline?.caseDef.observations],
    ]) {
      if (!Array.isArray(expr[field])) { problems.push(`expression.${field} must be an array`); continue; }
      const seen = new Set();
      for (const row of expr[field]) {
        keys(row, allowed, field);
        if (!object(row)) continue;
        if (!text(row[idKey]) || seen.has(row[idKey]) || !baselineRows?.some((b) => b[idKey] === row[idKey])) problems.push(`unknown/duplicate ${field} identity`);
        seen.add(row[idKey]);
        for (const key of allowed.filter((k) => k !== idKey)) if (typeof row[key] !== 'string' || row[key].length > 400 || (key !== 'output' && row[key].trim().length === 0)) problems.push(`invalid ${field}.${key}`);
      }
      if (baselineRows && (seen.size !== baselineRows.length || expr[field].length !== baselineRows.length)) problems.push(`expression.${field} must cover the registered identities exactly`);
    }
  }
  if (problems.length) return { adoptable: false, reason: problems.join('; ') };
  const candidate = structuredClone(baseline);
  candidate.candidateId = rawCandidate.candidateId;
  candidate.caseDef.caseId = rawCandidate.candidateId;
  candidate.draft.scenarioId = rawCandidate.candidateId;
  candidate.caseDef.taskText = expr.taskText;
  for (const row of expr.facts) candidate.caseDef.facts.find((f) => f.factId === row.factId).statement = row.statement;
  for (const row of expr.observations) candidate.caseDef.observations.find((o) => o.obsId === row.obsId).label = row.label;
  return { adoptable: true, candidate, baselineCandidateId: baseline.candidateId, declaredBaselineMismatch: false };
}
