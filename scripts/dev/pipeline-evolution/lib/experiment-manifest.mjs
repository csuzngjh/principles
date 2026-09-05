// PRI-685 Evidence Foundation — experiment manifest contract.
//
// The manifest IS the experiment's single authority (audit §3.1): a bare
// experiment id cannot locate any data (no registry until SPEC Phase 2), so
// `--experiment <path-to-manifest.json>` is the only supported shape.
// Fields follow SPEC §6; extras (painIds/correlations/behaviorObservation)
// are the binding surface the collector needs.

import { readFileSync } from 'node:fs';

export const MANIFEST_SCHEMA = 'experiment-manifest.v1';

const REQUIRED = ['experimentId', 'scenarioId', 'host', 'startedAt'];

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
    else if (m.behaviorObservation.status !== 'CONFIRMED' && m.behaviorObservation.status !== 'INCONCLUSIVE') {
      problems.push("behaviorObservation.status must be 'CONFIRMED' or 'INCONCLUSIVE' (NOT_REACHED is derived, never asserted)");
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
