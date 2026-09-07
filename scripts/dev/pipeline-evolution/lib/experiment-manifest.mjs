// PRI-685 Evidence Foundation — experiment manifest contract.
//
// The manifest is the experiment METADATA authority (what this experiment IS:
// id, scenario, code version, environment, scope bindings) — it is NOT a
// runtime evidence authority. What HAPPENED remains owned by the stores:
// state.db / trajectory.db / telemetry. The collector derives claims from
// those stores; the manifest only scopes the derivation. If a manifest and a
// store ever disagree, the store wins (the manifest is operator input).
//
// Fields follow SPEC §6; extras (painIds/correlations/behaviorObservation)
// are the binding surface the collector needs. A bare experiment id cannot
// locate any data (no registry until SPEC Phase 2), so
// `--experiment <path-to-manifest.json>` is the only supported shape.

import { readFileSync } from 'node:fs';

export const MANIFEST_SCHEMA = 'experiment-manifest.v1';

const REQUIRED = ['experimentId', 'scenarioId', 'host', 'startedAt'];

/**
 * PRI-703 Phase 3 (Owner decision 2026-09-07): behavior observation outcome
 * vocabulary. IMPROVED / NO_IMPROVEMENT / REGRESSION are observation
 * OUTCOMES (what the post-activation behavior looked like); NOT_REACHED
 * stays derived (never asserted — no activation in scope); INCONCLUSIVE =
 * evidence insufficient. CONFIRMED / INCONCLUSIVE remain accepted as
 * legacy aliases: CONFIRMED ≡ IMPROVED (and must then satisfy the same
 * evidence gate).
 */
export const BEHAVIOR_OUTCOMES = ['IMPROVED', 'NO_IMPROVEMENT', 'REGRESSION', 'INCONCLUSIVE'];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStringArray(v, field, problems) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    problems.push(`${field} must be an array of strings`);
    return [];
  }
  return v;
}

// rc-1/rc-3 discipline: manifest content is operator-written JSON = untrusted
// input. Validate loudly; a manifest that cannot name its experiment is a
// usage error, not a degraded report.
export function parseManifest(json) {
  const problems = [];
  if (!isPlainObject(json)) throw new Error('manifest root must be a JSON object');

  const m = { ...json };
  for (const field of REQUIRED) {
    if (typeof m[field] !== 'string' || m[field].trim() === '') {
      problems.push(`missing required field: ${field}`);
    }
  }
  if (typeof m.pdCommit !== 'string' || m.pdCommit.trim() === '') {
    problems.push('missing required field: pdCommit (AC1 — an experiment that cannot name its code is not reproducible)');
  }

  m.sessionIds = asStringArray(m.sessionIds, 'sessionIds', problems);
  m.painIds = asStringArray(m.painIds, 'painIds', problems);
  m.correlations = asStringArray(m.correlations, 'correlations', problems);

  if (m.model !== undefined && m.model !== null && !isPlainObject(m.model)) {
    problems.push('model must be an object {provider, name, ...}');
  }
  if (m.featureFlags !== undefined && m.featureFlags !== null && !isPlainObject(m.featureFlags)) {
    problems.push('featureFlags must be an object');
  }
  if (m.behaviorObservation !== undefined && m.behaviorObservation !== null) {
    if (!isPlainObject(m.behaviorObservation)) problems.push('behaviorObservation must be an object');
    else {
      const obs = m.behaviorObservation;
      // PRI-703 Phase 3: field-name drift normalization — the Episode-001
      // manifest hand-fill used `result` instead of the contract's `status`
      // (real-data drift; re-running collect-evidence against it would have
      // thrown). Accept both spellings; the canonical key stays `status`.
      if (obs.status === undefined && typeof obs.result === 'string' && obs.result.trim() !== '') {
        obs.status = obs.result;
      }
      const status = obs.status;
      if (status !== 'CONFIRMED' && status !== 'INCONCLUSIVE' && !BEHAVIOR_OUTCOMES.includes(status)) {
        problems.push(`behaviorObservation.status must be one of ${BEHAVIOR_OUTCOMES.join('/')}(legacy CONFIRMED/INCONCLUSIVE accepted; NOT_REACHED is derived, never asserted)`);
      } else {
        // Evidence integrity gate (PRI-703 Phase 3): a positive observation
        // (CONFIRMED / IMPROVED) without at least one evidence entry is a
        // claim with no support — reject loudly instead of deriving a
        // CONFIRMED with evidence:[] (Episode-001 contract hole).
        if (status === 'CONFIRMED' || status === 'IMPROVED') {
          const evidenceList = obs.evidence;
          if (!Array.isArray(evidenceList) || evidenceList.length === 0) {
            problems.push("behaviorObservation with status CONFIRMED/IMPROVED requires evidence: at least 1 entry (session evidence / tool trajectory evidence / behavior diff evidence) — an unsupported positive claim is not a valid observation");
          } else {
            for (const e of evidenceList) {
              if (!isPlainObject(e) || ![e.detail, e.source].some((value) => typeof value === 'string' && value.trim() !== '')) {
                problems.push('behaviorObservation.evidence entries must be objects with a non-empty detail or source string');
                break;
              }
            }
          }
        }
      }
    }
  }
  // finishedAt may be null/absent while the experiment is still running.
  if (m.finishedAt !== undefined && m.finishedAt !== null && typeof m.finishedAt !== 'string') {
    problems.push('finishedAt must be an ISO string (or null) when present');
  }

  if (problems.length > 0) {
    throw new Error(`invalid experiment manifest:\n  - ${problems.join('\n  - ')}`);
  }
  return m;
}

export function loadManifest(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read manifest ${file}: ${err.message}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest ${file} is not valid JSON: ${err.message}`);
  }
  return parseManifest(json);
}

export function newManifestTemplate(partial) {
  const now = new Date().toISOString();
  return {
    schemaVersion: MANIFEST_SCHEMA,
    experimentId: partial.experimentId,
    scenarioId: partial.scenarioId,
    scenarioVersion: partial.scenarioVersion ?? '1',
    pdCommit: partial.pdCommit ?? '',
    pdCoreVersion: partial.pdCoreVersion ?? null,
    pdPluginVersion: partial.pdPluginVersion ?? null,
    pdCliVersion: partial.pdCliVersion ?? null,
    bundleHash: partial.bundleHash ?? null,
    host: partial.host ?? 'openclaw',
    hostVersion: partial.hostVersion ?? null,
    model: partial.model ?? { provider: null, name: null, thinking: null, timeoutMs: null },
    featureFlags: partial.featureFlags ?? {},
    fixtureHash: partial.fixtureHash ?? null,
    workspaceFingerprint: partial.workspaceFingerprint ?? null,
    sessionIds: partial.sessionIds ?? [],
    painIds: partial.painIds ?? [],
    correlations: partial.correlations ?? [],
    startedAt: partial.startedAt ?? now,
    finishedAt: partial.finishedAt ?? null,
    behaviorObservation: null,
  };
}
