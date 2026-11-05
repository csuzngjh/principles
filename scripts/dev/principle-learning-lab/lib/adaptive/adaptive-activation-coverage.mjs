import { hashOfCanonical } from '../challenge-freeze.mjs';

const LAYERS = ['T', 'V', 'O'];
const STATES = new Set([true, false, 'unknown']);
const SHA256 = /^[a-f0-9]{64}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireValid(condition, message) {
  if (!condition) throw new TypeError(message);
}

function validateRecord(record, index) {
  const prefix = `records[${index}]`;
  requireValid(isObject(record), `${prefix} must be an object`);
  requireValid(record.opportunityId === null
    || (typeof record.opportunityId === 'string' && record.opportunityId.trim() !== ''),
  `${prefix}.opportunityId must be a non-empty string or null`);
  requireValid(isObject(record.classification), `${prefix}.classification must be an object`);
  requireValid(isObject(record.classificationReferences), `${prefix}.classificationReferences must be an object`);
  for (const layer of LAYERS) {
    const state = record.classification[layer];
    requireValid(STATES.has(state), `${prefix}.classification.${layer} has an invalid state`);
    const reference = record.classificationReferences[layer];
    requireValid(typeof reference === 'string', `${prefix}.classificationReferences.${layer} must be a string`);
    if (state !== 'unknown') {
      requireValid(reference.trim() !== '', `${prefix}.classificationReferences.${layer} is required for a known state`);
    }
  }
  const states = LAYERS.map((layer) => record.classification[layer]);
  requireValid(!states.some((state, position) => state === true && states.slice(0, position).includes(false)),
    prefix + ' contradicts the nested opportunity sets');
  requireValid(record.sameText === true || record.sameText === false || record.sameText === 'unknown',
    `${prefix}.sameText has an invalid state`);
  requireValid(Array.isArray(record.checks), `${prefix}.checks must be an array`);
  for (let checkIndex = 0; checkIndex < record.checks.length; checkIndex++) {
    const check = record.checks[checkIndex];
    const checkPrefix = `${prefix}.checks[${checkIndex}]`;
    requireValid(isObject(check), `${checkPrefix} must be an object`);
    requireValid(typeof check.hookInvocationId === 'string' && check.hookInvocationId.trim() !== '',
      `${checkPrefix}.hookInvocationId must be a non-empty string`);
    requireValid(typeof check.inputDigest === 'string' && SHA256.test(check.inputDigest),
      `${checkPrefix}.inputDigest must be a lowercase SHA-256 digest`);
    requireValid(isObject(check.result), `${checkPrefix}.result must be an object`);
    const { result } = check;
    requireValid(typeof result.ok === 'boolean', `${checkPrefix}.result.ok must be a boolean`);
    requireValid(['unknown', 'confirmed', 'not_confirmed'].includes(result.delivery),
      `${checkPrefix}.result.delivery has an invalid state`);
    requireValid(['unknown', 'confirmed', 'not_confirmed'].includes(result.timely),
      `${checkPrefix}.result.timely has an invalid state`);
    requireValid(['unknown', 'L1', 'fixture'].includes(result.evidenceLevel),
      `${checkPrefix}.result.evidenceLevel has an invalid state`);
    requireValid(typeof result.fixtureMatch === 'boolean', `${checkPrefix}.result.fixtureMatch must be a boolean`);
  }
}

function sameClassification(left, right) {
  return LAYERS.every((layer) => left[layer] === right[layer]);
}

function sameResult(left, right) {
  return hashOfCanonical(left) === hashOfCanonical(right);
}

function mergeOpportunities(records) {
  const groups = new Map();
  let unlinkedRecords = 0;
  for (const record of records) {
    if (record.opportunityId === null) {
      unlinkedRecords++;
      continue;
    }
    let group = groups.get(record.opportunityId);
    if (!group) {
      group = {
        opportunityId: record.opportunityId,
        classification: { ...record.classification },
        classificationConflict: false,
        sameText: record.sameText,
        sameTextConflict: false,
        checks: new Map(),
        duplicateRows: 0,
        conflictingChecks: 0,
        fixtureChecks: 0,
      };
      groups.set(record.opportunityId, group);
    } else {
      group.duplicateRows++;
      if (!sameClassification(group.classification, record.classification)) {
        group.classificationConflict = true;
      }
      if (group.sameText !== record.sameText) group.sameTextConflict = true;
    }
    for (const check of record.checks) {
      const previous = group.checks.get(check.hookInvocationId);
      if (!previous) {
        group.checks.set(check.hookInvocationId, {
          inputDigest: check.inputDigest,
          result: check.result,
          conflict: false,
        });
      } else if (previous.inputDigest !== check.inputDigest || !sameResult(previous.result, check.result)) {
        if (!previous.conflict) group.conflictingChecks++;
        previous.conflict = true;
      }
    }
  }
  for (const group of groups.values()) {
    group.fixtureChecks = [...group.checks.values()].filter((check) => check.result.evidenceLevel === 'fixture').length;
  }
  return { groups: [...groups.values()], unlinkedRecords };
}

function deliveryState(group) {
  if (group.classificationConflict || group.classification.O !== true || group.conflictingChecks > 0) return 'unknown';
  if (group.checks.size === 0) return 'unknown';
  let sawUnknown = false;
  for (const check of group.checks.values()) {
    if (check.conflict || check.result.ok !== true || check.result.evidenceLevel === 'fixture') {
      sawUnknown = true;
      continue;
    }
    if (check.result.evidenceLevel === 'L1'
      && check.result.delivery === 'confirmed' && check.result.timely === 'confirmed') return true;
    if (check.result.evidenceLevel === 'L1'
      && (check.result.delivery === 'not_confirmed' || check.result.timely === 'not_confirmed')) continue;
    sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : false;
}

function effectiveStates(group) {
  if (group.classificationConflict) return { T: 'unknown', V: 'unknown', O: 'unknown', D: 'unknown' };
  const raw = { ...group.classification, D: deliveryState(group) };
  const states = {};
  let parent = true;
  for (const layer of ['T', 'V', 'O', 'D']) {
    states[layer] = parent === true ? raw[layer] : parent;
    parent = states[layer];
  }
  return states;
}

function countLayers(groups) {
  const counts = Object.fromEntries(['T', 'V', 'O', 'D'].map((name) => [name, { confirmed: 0, unknown: 0 }]));
  for (const group of groups) {
    const states = effectiveStates(group);
    for (const layer of Object.keys(counts)) {
      if (states[layer] === true) counts[layer].confirmed++;
      if (states[layer] === 'unknown') counts[layer].unknown++;
    }
  }
  return counts;
}

function ratio(numerator, denominator, numeratorUnknown, denominatorUnknown, forceUnknown = false) {
  const base = { numerator, denominator, value: null, unknownCount: Math.max(numeratorUnknown, denominatorUnknown),
    unknownNumerator: numeratorUnknown, unknownDenominator: denominatorUnknown };
  if (forceUnknown || denominatorUnknown > 0) return { ...base, status: 'unknown' };
  if (denominator === 0) return { ...base, status: 'not_applicable' };
  if (numeratorUnknown > 0) return { ...base, status: 'lower_bound', value: numerator / denominator };
  return { ...base, status: 'exact', value: numerator / denominator };
}

function ratiosFor(counts, forcePopulationUnknown) {
  return {
    'D/T': ratio(counts.D.confirmed, counts.T.confirmed, counts.D.unknown, counts.T.unknown, forcePopulationUnknown),
    'V/T': ratio(counts.V.confirmed, counts.T.confirmed, counts.V.unknown, counts.T.unknown, forcePopulationUnknown),
    'O/V': ratio(counts.O.confirmed, counts.V.confirmed, counts.O.unknown, counts.V.unknown),
    'D/O': ratio(counts.D.confirmed, counts.O.confirmed, counts.D.unknown, counts.O.unknown),
  };
}

function summarizeNewTimely(groups) {
  let confirmed = 0;
  let unknown = 0;
  for (const group of groups) {
    const delivered = effectiveStates(group).D;
    if (delivered === false) continue;
    if (group.sameText === true && !group.sameTextConflict) continue;
    if (delivered === 'unknown' || group.sameTextConflict || group.sameText === 'unknown') {
      unknown++;
    } else if (delivered === true && group.sameText === false) {
      confirmed++;
    }
  }
  return { confirmed, unknown };
}

/** Summarize a fixed set of manually/adjudicated opportunities and bound delivery evidence. */
export function summarizeAdaptiveCoverage(records, { enumeration = 'complete' } = {}) {
  requireValid(Array.isArray(records), 'records must be an array');
  requireValid(['complete', 'sample', 'unknown'].includes(enumeration), 'enumeration has an invalid state');
  records.forEach(validateRecord);
  const { groups, unlinkedRecords } = mergeOpportunities(records);
  const counts = countLayers(groups);
  const forcePopulationUnknown = enumeration === 'unknown' || unlinkedRecords > 0;
  const ratios = ratiosFor(counts, forcePopulationUnknown);
  const result = {
    enumeration: unlinkedRecords > 0 ? 'unknown' : enumeration,
    declaredEnumeration: enumeration,
    counts,
    ratios,
    newTimely: summarizeNewTimely(groups),
    diagnostics: {
      duplicateRows: groups.reduce((sum, group) => sum + group.duplicateRows, 0),
      conflictingOpportunities: groups.filter((group) => group.classificationConflict).length,
      conflictingChecks: groups.reduce((sum, group) => sum + group.conflictingChecks, 0),
      unlinkedRecords,
      fixtureChecks: groups.reduce((sum, group) => sum + group.fixtureChecks, 0),
      excludedTimelyDeliveries: groups.filter((group) => !group.classificationConflict && group.classification.T === false)
        .reduce((sum, group) => sum + [...group.checks.values()].filter((check) => !check.conflict
          && check.result.ok && check.result.evidenceLevel === 'L1'
          && check.result.delivery === 'confirmed' && check.result.timely === 'confirmed').length, 0),
    },
  };
  if (forcePopulationUnknown) result.linkedSubsetRatios = ratiosFor(counts, false);
  return result;
}
