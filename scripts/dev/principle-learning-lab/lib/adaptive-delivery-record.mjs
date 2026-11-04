const ENUMS = {
  receiptState: ['open', 'closed', 'reconciled'],
  execution: ['completed', 'degraded', 'timeout', 'failed', 'unknown'],
  payload: ['none', 'prepared', 'returned', 'confirmed', 'unknown'],
  selection: ['selected', 'none_applicable', 'skipped', 'unavailable'],
  submission: ['proceeded', 'blocked', 'unknown'],
};

const isRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) return false;
  if (Object.hasOwn(value, '__proto__')) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value');
  });
};

const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/** Validate one offline adaptive-delivery receipt without mutating it. */
export function validateAdaptiveDeliveryRecord(record) {
  const errors = [];
  if (!isRecord(record)) {
    return { ok: false, errors: ['record must be a plain data object'] };
  }
  const evidence = Object.hasOwn(record, 'evidence') ? record.evidence : undefined;
  const validEvidence = !Object.hasOwn(record, 'evidence') || isRecord(evidence);
  const evidenceAvailable = validEvidence && Object.hasOwn(record, 'evidence');
  if (!validEvidence) errors.push('evidence must be a plain data object when present');

  for (const field of ['hookInvocationId']) {
    if (!Object.hasOwn(record, field) || !nonEmptyString(record[field])) errors.push(`${field} must be a non-empty string`);
  }
  if (Object.hasOwn(record, 'requestId') && !nonEmptyString(record.requestId)) {
    errors.push('requestId must be a non-empty string when present');
  }

  for (const [field, values] of Object.entries(ENUMS)) {
    if (!Object.hasOwn(record, field) || !values.includes(record[field])) errors.push(`${field} must be one of: ${values.join(', ')}`);
  }

  if (Object.hasOwn(record, 'selectionPending') && typeof record.selectionPending !== 'boolean') {
    errors.push('selectionPending must be a boolean when present');
  }
  if (record.receiptState === 'open') {
    for (const field of ['execution', 'payload', 'submission']) {
      if (record[field] !== 'unknown') errors.push(`open receipt requires ${field}=unknown`);
    }
    if (record.selection !== 'unavailable' || record.selectionPending !== true) {
      errors.push('open receipt requires selection=unavailable and selectionPending=true');
    }
  } else if (record.selectionPending === true) {
    errors.push('selectionPending cannot be true for a terminal receipt');
  }

  if (record.payload === 'confirmed') {
    if (record.execution !== 'completed') errors.push('confirmed payload requires execution=completed');
    if (!evidenceAvailable || !Object.hasOwn(evidence, 'independentlyVerified') || evidence.independentlyVerified !== true) errors.push('confirmed payload requires independentlyVerified=true');
    if (!evidenceAvailable || !Object.hasOwn(evidence, 'reference') || !nonEmptyString(evidence.reference)) errors.push('confirmed payload requires a non-empty evidence.reference');
  }

  if (record.submission !== 'unknown' && (!evidenceAvailable || !Object.hasOwn(evidence, 'reference') || !nonEmptyString(evidence.reference))) {
    errors.push('known submission requires a non-empty independent evidence.reference');
  }
  if (record.submission !== 'unknown' && (!evidenceAvailable || !Object.hasOwn(evidence, 'independentlyVerified') || evidence.independentlyVerified !== true)) {
    errors.push('known submission requires independentlyVerified=true');
  }

  if (['degraded', 'timeout', 'failed', 'unknown'].includes(record.execution) && ['returned', 'confirmed'].includes(record.payload)) {
    errors.push(`${record.execution} execution cannot have payload=${record.payload}`);
  }
  if (record.execution === 'timeout') {
    if (!evidenceAvailable || !Object.hasOwn(evidence, 'independentlyVerified') || evidence.independentlyVerified !== true || !Object.hasOwn(evidence, 'reference') || !nonEmptyString(evidence.reference)) {
      errors.push('timeout requires independently verified evidence with a non-empty reference');
    }
    if (!evidenceAvailable || !Object.hasOwn(evidence, 'hostKillConfirmed') || evidence.hostKillConfirmed !== true) errors.push('timeout requires evidence.hostKillConfirmed=true');
  }

  if (record.selection === 'none_applicable' && (record.execution !== 'completed' || record.payload !== 'none')) {
    errors.push('none_applicable requires execution=completed and payload=none');
  }
  if (record.selection === 'unavailable' && ['prepared', 'returned', 'confirmed'].includes(record.payload)) {
    errors.push(`unavailable selection cannot have payload=${record.payload}`);
  }

  if (validEvidence && evidence !== undefined) {
    if (Object.hasOwn(evidence, 'reference') && !nonEmptyString(evidence.reference)) {
      errors.push('evidence.reference must be a non-empty string when present');
    }
    for (const field of ['independentlyVerified', 'hostKillConfirmed']) {
      if (Object.hasOwn(evidence, field) && typeof evidence[field] !== 'boolean') {
        errors.push(`evidence.${field} must be a boolean when present`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
