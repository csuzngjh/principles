// PRI-967 — Principle Learning Lab fixture layer.
//
// Owns: loading the frozen research dataset, computing its content hash,
// running the fixture health check, assembling actor-visible inputs, and
// scanning actor inputs for judge-only gold leakage.
//
// Determinism contract: everything derived here is a pure function of the
// frozen files. No timestamps, no randomness — repeated loads produce
// byte-identical outputs, so run outputs are replayable.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DATASET_SCHEMA = 'pd-principles-dataset.v0.1';

// Canonical JSON: sorted keys, no whitespace — the hash basis.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readJson(dir, rel) {
  const file = path.join(dir, rel);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read dataset file ${rel}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`dataset file ${rel} is not valid JSON: ${err.message}`);
  }
}

// Fixed traversal order — the fixture hash must not depend on OS dir listing.
const FILE_ORDER = [
  'dataset-manifest.json',
  'world-manual.json',
  'episodes/PLE-PILOT-01.json',
  'histories/E0.json',
  'histories/EA.json',
  'histories/EB.json',
  'histories/EN.json',
  'probes/P1.json',
  'probes/P2.json',
  'probes/P3.json',
  'probes/P4.json',
  'judgments/gold.json',
  'judgments/calibration.json',
  'splits.json',
];

// Optional dataset extensions, appended AFTER the fixed core in this exact
// order when present. A v1 dataset (no optional file) hashes over exactly
// FILE_ORDER — byte-identical to the historical baseline; a v2 dataset
// shipping `histories/G.json` (the generic-context control) gets its own
// hash. Determinism contract unchanged: presence, not dir listing, decides.
const OPTIONAL_ORDER = [
  'histories/G.json',
];

export function computeFixtureHash(dataset) {
  const parts = FILE_ORDER.map((rel) => `${rel}:${canonicalJson(dataset.byFile[rel])}`);
  for (const rel of OPTIONAL_ORDER) {
    if (dataset.byFile[rel] !== undefined) parts.push(`${rel}:${canonicalJson(dataset.byFile[rel])}`);
  }
  return sha256(parts.join('\n'));
}

/**
 * Load the frozen dataset from a fixtures directory.
 * Returns the parsed graph plus a per-file map (hash basis) — rc-1 discipline:
 * file JSON is untrusted input; healthCheck() is the gate that fails loudly.
 */
export function loadDataset(dir) {
  const byFile = {};
  for (const rel of FILE_ORDER) byFile[rel] = readJson(dir, rel);
  for (const rel of OPTIONAL_ORDER) {
    try {
      byFile[rel] = readJson(dir, rel);
    } catch (err) {
      if (String(err.message).startsWith('cannot read dataset file')) continue; // absent optional file
      throw err;
    }
  }
  const dataset = {
    dir,
    manifest: byFile['dataset-manifest.json'],
    worldManual: byFile['world-manual.json'],
    episode: byFile['episodes/PLE-PILOT-01.json'],
    splits: byFile['splits.json'],
    histories: {
      E0: byFile['histories/E0.json'],
      EA: byFile['histories/EA.json'],
      EB: byFile['histories/EB.json'],
      EN: byFile['histories/EN.json'],
      ...(byFile['histories/G.json'] !== undefined ? { G: byFile['histories/G.json'] } : {}),
    },
    probes: {
      P1: byFile['probes/P1.json'],
      P2: byFile['probes/P2.json'],
      P3: byFile['probes/P3.json'],
      P4: byFile['probes/P4.json'],
    },
    gold: byFile['judgments/gold.json'],
    calibration: byFile['judgments/calibration.json'],
    byFile,
  };
  dataset.fixtureHash = computeFixtureHash(dataset);
  return dataset;
}

/** Normalize any probe into a flat opportunity list (P4 has two phases). */
export function opportunitiesOf(probe) {
  if (Array.isArray(probe.opportunities) && probe.opportunities.length > 0) {
    return probe.opportunities.map((o) => ({
      opportunityId: o.opportunityId,
      taskInstructions: o.taskInstructions,
      environment: o.environment,
      preTaskEligibleCondition: o.preTaskEligibleCondition,
      probeKind: probe.probeKind,
    }));
  }
  return [
    {
      opportunityId: probe.probeId,
      taskInstructions: probe.taskInstructions,
      environment: probe.environment,
      preTaskEligibleCondition: probe.preTaskEligibleCondition,
      probeKind: probe.probeKind,
    },
  ];
}

/** All opportunities across the dataset, in canonical (probe, phase) order. */
export function allOpportunities(dataset) {
  const rows = [];
  for (const probeId of Object.keys(dataset.probes)) {
    for (const opp of opportunitiesOf(dataset.probes[probeId])) {
      rows.push({ probeId, ...opp });
    }
  }
  return rows;
}

/** Gold record for one opportunity (P4 is keyed by phase). */
export function goldFor(dataset, probeId, opportunityId) {
  const g = dataset.gold.gold[probeId];
  if (!g) throw new Error(`gold missing for probe ${probeId}`);
  if (g.phases) {
    const phase = g.phases[opportunityId];
    if (!phase) throw new Error(`gold missing for opportunity ${opportunityId}`);
    return { opportunityId, ...phase };
  }
  return g;
}

/** Deterministic rendering of a history into actor-visible text. */
export function renderHistoryText(history) {
  const lines = [`## Learning history: ${history.historyId} (${history.label})`];
  lines.push(history.narrative);
  for (const ev of history.events) {
    lines.push('');
    lines.push(`### ${ev.kind} ${ev.ticket} — ${ev.summary}`);
    for (const line of ev.whatHappened) lines.push(`- ${line}`);
    if (ev.whatWouldHaveCaughtIt) lines.push(`What would have caught it: ${ev.whatWouldHaveCaughtIt}`);
    if (ev.ownerFeedback) lines.push(`Owner feedback: ${ev.ownerFeedback}`);
  }
  return lines.join('\n');
}

/**
 * Assemble the actor-visible input for one (history, probe, opportunity) run.
 * Outer-leak guard: a probe whose leakage group differs from the history's is
 * rejected here (negative test NT-02); the same-episode history→future pair is
 * legitimate by the inner split and must pass (negative test NT-03).
 */
export function assembleActorInput(dataset, historyId, probeId, opportunityId) {
  const history = dataset.histories[historyId];
  const probe = dataset.probes[probeId];
  if (!history) throw new Error(`unknown historyId: ${historyId}`);
  if (!probe) throw new Error(`unknown probeId: ${probeId}`);
  if (history.leakageGroupId !== probe.leakageGroupId) {
    throw new Error(
      `outer leakage violation: history ${historyId} (group ${history.leakageGroupId}) cannot be paired with probe ${probeId} (group ${probe.leakageGroupId})`,
    );
  }
  if (probe.episodeId !== dataset.episode.episodeId) {
    throw new Error(`probe ${probeId} does not belong to episode ${dataset.episode.episodeId}`);
  }
  const opp = opportunitiesOf(probe).find((o) => o.opportunityId === opportunityId);
  if (!opp) throw new Error(`probe ${probeId} has no opportunity ${opportunityId}`);

  const visibleText = [
    dataset.worldManual.manualText.join('\n'),
    '',
    renderHistoryText(history),
    '',
    opp.taskInstructions.join('\n'),
  ].join('\n');

  return {
    historyId,
    probeId,
    opportunityId,
    leakageGroupId: probe.leakageGroupId,
    worldManualRef: 'fixtures/world-manual.json',
    historySynthetic: history.synthetic === true,
    visibleText,
  };
}

/**
 * Scan actor-visible text for judge-only canaries (negative test NT-01 basis).
 * Returns findings; empty means clean.
 */
export function scanGoldLeak(visibleText, goldRecord) {
  const findings = [];
  for (const canary of goldRecord.canaryStrings ?? []) {
    if (visibleText.includes(canary)) {
      findings.push({ canary, where: 'actor-visible input' });
    }
  }
  return findings;
}

const MANUAL_COST_ROW = /^\|\s*([a-z-]+)(?:\s+<[^>]+>)?\s*\|\s*(\d+)\s*\|/;

/** Parse the world manual's cost table — the actor-facing copy of the registry. */
export function parseManualCosts(worldManual) {
  const costs = {};
  for (const line of worldManual.manualText) {
    const m = MANUAL_COST_ROW.exec(line);
    if (m) costs[m[1]] = Number(m[2]);
  }
  return costs;
}

/**
 * PRI-967 fixture health check (requirement 7). Returns problems; empty = healthy.
 * Verifies: graph consistency, synthetic markers, gold coverage, manual↔registry
 * cost agreement, and that no canary leaks into any actor-visible assembly.
 */
export function healthCheck(dataset, actionCosts) {
  const problems = [];
  const p = (msg) => problems.push(msg);

  if (dataset.manifest.schemaVersion !== DATASET_SCHEMA) {
    p(`dataset-manifest schemaVersion must be ${DATASET_SCHEMA}`);
  }
  if (dataset.manifest.synthetic !== true) p('dataset-manifest must mark synthetic=true');

  for (const [id, history] of Object.entries(dataset.histories)) {
    if (history.historyId !== id) p(`history file/id mismatch: ${id} vs ${history.historyId}`);
    if (history.synthetic !== true) p(`history ${id} must mark synthetic=true`);
    if (!Array.isArray(history.syntheticMarkers) || !history.syntheticMarkers.includes('synthetic_environment')) {
      p(`history ${id} must carry syntheticMarkers including synthetic_environment`);
    }
    if (history.innerRole !== 'learning_history') p(`history ${id} innerRole must be learning_history`);
    if (history.leakageGroupId !== dataset.manifest.leakageGroupId) {
      p(`history ${id} leakage group must match the dataset group`);
    }
  }
  if (dataset.histories.EN.derivedFrom !== 'EA') p('EN must declare derivedFrom=EA');
  const normEvidence = (arr) => arr.map((s) => s.replace(/E[AN]-\d+/g, 'EVT')).join('|');
  if (normEvidence(dataset.histories.EN.causalKeyEvidence) !== normEvidence(dataset.histories.EA.causalKeyEvidence)) {
    p('EN causalKeyEvidence must be identical to EA modulo event-id prefixes (only irrelevant deltas allowed)');
  }

  for (const [id, probe] of Object.entries(dataset.probes)) {
    if (probe.probeId !== id) p(`probe file/id mismatch: ${id} vs ${probe.probeId}`);
    if (probe.innerRole !== 'future_probe') p(`probe ${id} innerRole must be future_probe`);
    if (probe.episodeId !== dataset.episode.episodeId) p(`probe ${id} episodeId mismatch`);
    if (probe.leakageGroupId !== dataset.manifest.leakageGroupId) p(`probe ${id} leakage group mismatch`);
    for (const opp of opportunitiesOf(probe)) {
      if (!Number.isInteger(opp.environment.deadlineUnits) || opp.environment.deadlineUnits <= 0) {
        p(`probe ${id}/${opp.opportunityId} deadlineUnits must be a positive integer`);
      }
      for (const c of opp.environment.hiddenConsumers ?? []) {
        if (!Array.isArray(c.detectedBy) || c.detectedBy.length === 0) {
          p(`probe ${id} consumer ${c.id} must list detectedBy actions`);
        }
      }
      if (opp.preTaskEligibleCondition?.eligible !== true) {
        p(`probe ${id}/${opp.opportunityId} must be pre-task eligible`);
      }
      const g = goldFor(dataset, id, opp.opportunityId);
      if (!g?.expectedDecisionSpace) p(`gold missing decision space for ${id}/${opp.opportunityId}`);
    }
  }

  // Gold canaries must be present in gold (else the leak scan is vacuous).
  for (const row of allOpportunities(dataset)) {
    const g = goldFor(dataset, row.probeId, row.opportunityId);
    if (!Array.isArray(g.canaryStrings)) p(`gold ${row.opportunityId} canaryStrings must be an array`);
    if (!Array.isArray(g.ownVisibleTokens)) p(`gold ${row.opportunityId} ownVisibleTokens must be an array`);
  }

  // Probe keys are allowed ONLY in their own probe's task text — never in the
  // manual, the histories, or another probe's instructions (cross-probe leak).
  const manualAndHistories = [
    dataset.worldManual.manualText.join('\n'),
    ...Object.values(dataset.histories).map(renderHistoryText),
  ].join('\n');
  for (const row of allOpportunities(dataset)) {
    const g = goldFor(dataset, row.probeId, row.opportunityId);
    for (const token of g.ownVisibleTokens) {
      if (manualAndHistories.includes(token)) {
        p(`cross-leak: probe token '${token}' appears in the manual or a history`);
      }
      for (const other of allOpportunities(dataset)) {
        if (other.opportunityId === row.opportunityId) continue;
        if (other.taskInstructions.join('\n').includes(token)) {
          p(`cross-leak: probe token '${token}' from ${row.opportunityId} appears in ${other.opportunityId}`);
        }
      }
    }
  }

  // Canary non-leak into every legitimate actor-visible assembly.
  for (const historyId of Object.keys(dataset.histories)) {
    for (const row of allOpportunities(dataset)) {
      const input = assembleActorInput(dataset, historyId, row.probeId, row.opportunityId);
      const g = goldFor(dataset, row.probeId, row.opportunityId);
      for (const f of scanGoldLeak(input.visibleText, g)) {
        p(`canary leak: '${f.canary}' is actor-visible in ${historyId}/${row.opportunityId}`);
      }
    }
  }

  // Manual cost table must agree with the mechanical action registry.
  const manualCosts = parseManualCosts(dataset.worldManual);
  for (const [action, cost] of Object.entries(actionCosts)) {
    if (manualCosts[action] !== cost) {
      p(`manual/registry cost mismatch for ${action}: manual=${manualCosts[action]} registry=${cost}`);
    }
  }

  // Calibration cases must reference real probes/opportunities.
  for (const c of dataset.calibration.cases) {
    if (!dataset.probes[c.probeId]) {
      p(`calibration ${c.caseId} references unknown probe ${c.probeId}`);
      continue;
    }
    const opp = opportunitiesOf(dataset.probes[c.probeId]).find((o) => o.opportunityId === (c.opportunityId ?? c.probeId));
    if (!opp) p(`calibration ${c.caseId} references unknown opportunity`);
  }

  // Episode evidence refs must respect the information cutoff (rc-6 lineage).
  const cutoff = Date.parse(dataset.episode.informationCutoff);
  for (const ref of dataset.episode.evidenceRefs) {
    const occurred = Date.parse(ref.occurredAt);
    if (Number.isNaN(occurred)) p(`evidenceRef ${ref.sourceExactRef} has invalid occurredAt`);
    else if (occurred > cutoff) {
      p(`evidenceRef ${ref.sourceExactRef} occurredAt is after the episode informationCutoff`);
    }
    if (ref.realOrSynthetic !== 'synthetic') p(`evidenceRef ${ref.sourceExactRef} must be marked synthetic`);
  }

  return problems;
}
