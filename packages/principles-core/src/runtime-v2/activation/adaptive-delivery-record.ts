export const ADAPTIVE_DELIVERY_RECORD_ENUMS = {
  receiptState: ['open', 'closed', 'reconciled'],
  execution: ['completed', 'degraded', 'timeout', 'failed', 'unknown'],
  payload: ['none', 'prepared', 'returned', 'confirmed', 'unknown'],
  selection: ['selected', 'none_applicable', 'skipped', 'unavailable'],
  submission: ['proceeded', 'blocked', 'unknown'],
} as const;

export type AdaptiveDeliveryReceiptState = typeof ADAPTIVE_DELIVERY_RECORD_ENUMS.receiptState[number];
export type AdaptiveDeliveryExecution = typeof ADAPTIVE_DELIVERY_RECORD_ENUMS.execution[number];
export type AdaptiveDeliveryPayload = typeof ADAPTIVE_DELIVERY_RECORD_ENUMS.payload[number];
export type AdaptiveDeliverySelection = typeof ADAPTIVE_DELIVERY_RECORD_ENUMS.selection[number];
export type AdaptiveDeliverySubmission = typeof ADAPTIVE_DELIVERY_RECORD_ENUMS.submission[number];

export interface AdaptiveDeliveryEvidence {
  reference?: string;
  independentlyVerified?: boolean;
  hostKillConfirmed?: boolean;
  [key: string]: unknown;
}

export interface AdaptiveDeliveryRecord {
  hookInvocationId: string;
  requestId?: string;
  receiptState: AdaptiveDeliveryReceiptState;
  execution: AdaptiveDeliveryExecution;
  payload: AdaptiveDeliveryPayload;
  selection: AdaptiveDeliverySelection;
  submission: AdaptiveDeliverySubmission;
  selectionPending?: boolean;
  evidence?: AdaptiveDeliveryEvidence;
  [key: string]: unknown;
}

export interface AdaptiveDeliveryRecordValidation {
  ok: boolean;
  errors: string[];
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) return false;
  if (Object.hasOwn(value, '__proto__')) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
  });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOneOf<const T extends readonly string[]>(value: unknown, options: T): value is T[number] {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

const invalidRecord = (): AdaptiveDeliveryRecordValidation => ({
  ok: false,
  errors: ['record must be a plain data object'],
});

/** Validate one adaptive-delivery receipt as pure data; never infer delivery success. */
export function validateAdaptiveDeliveryRecord(record: unknown): AdaptiveDeliveryRecordValidation {
  try {
    const errors: string[] = [];
    if (!isPlainDataObject(record)) return invalidRecord();

    const hasEvidence = Object.hasOwn(record, 'evidence');
    const evidence = hasEvidence ? record.evidence : undefined;
    const evidenceRecord = isPlainDataObject(evidence) ? evidence : undefined;
    const validEvidence = !hasEvidence || evidenceRecord !== undefined;
    const evidenceAvailable = validEvidence && hasEvidence;
    if (!validEvidence) errors.push('evidence must be a plain data object when present');

    if (!Object.hasOwn(record, 'hookInvocationId') || !nonEmptyString(record.hookInvocationId)) {
      errors.push('hookInvocationId must be a non-empty string');
    }
    if (Object.hasOwn(record, 'requestId') && !nonEmptyString(record.requestId)) {
      errors.push('requestId must be a non-empty string when present');
    }

    for (const field of Object.keys(ADAPTIVE_DELIVERY_RECORD_ENUMS) as (keyof typeof ADAPTIVE_DELIVERY_RECORD_ENUMS)[]) {
      const values = ADAPTIVE_DELIVERY_RECORD_ENUMS[field];
      if (!Object.hasOwn(record, field) || !isOneOf(record[field], values)) {
        errors.push(`${field} must be one of: ${values.join(', ')}`);
      }
    }

    if (Object.hasOwn(record, 'selectionPending') && typeof record.selectionPending !== 'boolean') {
      errors.push('selectionPending must be a boolean when present');
    }
    if (record.receiptState === 'open') {
      for (const field of ['execution', 'payload', 'submission'] as const) {
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
      if (!evidenceAvailable || !evidenceRecord || !Object.hasOwn(evidenceRecord, 'independentlyVerified') || evidenceRecord.independentlyVerified !== true) {
        errors.push('confirmed payload requires independentlyVerified=true');
      }
      if (!evidenceAvailable || !evidenceRecord || !Object.hasOwn(evidenceRecord, 'reference') || !nonEmptyString(evidenceRecord.reference)) {
        errors.push('confirmed payload requires a non-empty evidence.reference');
      }
    }

    if (record.submission !== 'unknown' && (!evidenceAvailable || !evidenceRecord || !Object.hasOwn(evidenceRecord, 'reference') || !nonEmptyString(evidenceRecord.reference))) {
      errors.push('known submission requires a non-empty independent evidence.reference');
    }
    if (record.submission !== 'unknown' && (!evidenceAvailable || !evidenceRecord || !Object.hasOwn(evidenceRecord, 'independentlyVerified') || evidenceRecord.independentlyVerified !== true)) {
      errors.push('known submission requires independentlyVerified=true');
    }

    if (typeof record.execution === 'string' && ['degraded', 'timeout', 'failed', 'unknown'].includes(record.execution)
      && typeof record.payload === 'string' && ['returned', 'confirmed'].includes(record.payload)) {
      errors.push(`${record.execution} execution cannot have payload=${record.payload}`);
    }
    if (record.execution === 'timeout') {
      if (!evidenceAvailable || !evidenceRecord || !Object.hasOwn(evidenceRecord, 'independentlyVerified') || evidenceRecord.independentlyVerified !== true
        || !Object.hasOwn(evidenceRecord, 'reference') || !nonEmptyString(evidenceRecord.reference)) {
        errors.push('timeout requires independently verified evidence with a non-empty reference');
      }
      if (!evidenceAvailable || !evidenceRecord || !Object.hasOwn(evidenceRecord, 'hostKillConfirmed') || evidenceRecord.hostKillConfirmed !== true) {
        errors.push('timeout requires evidence.hostKillConfirmed=true');
      }
    }

    if (record.selection === 'none_applicable' && (record.execution !== 'completed' || record.payload !== 'none')) {
      errors.push('none_applicable requires execution=completed and payload=none');
    }
    if (record.selection === 'unavailable' && typeof record.payload === 'string'
      && ['prepared', 'returned', 'confirmed'].includes(record.payload)) {
      errors.push(`unavailable selection cannot have payload=${record.payload}`);
    }

    if (validEvidence && evidenceRecord) {
      if (Object.hasOwn(evidenceRecord, 'reference') && !nonEmptyString(evidenceRecord.reference)) {
        errors.push('evidence.reference must be a non-empty string when present');
      }
      for (const field of ['independentlyVerified', 'hostKillConfirmed'] as const) {
        if (Object.hasOwn(evidenceRecord, field) && typeof evidenceRecord[field] !== 'boolean') {
          errors.push(`evidence.${field} must be a boolean when present`);
        }
      }
    }

    return { ok: errors.length === 0, errors };
  } catch {
    // Proxies can throw from reflection traps; malformed input remains invalid.
    return invalidRecord();
  }
}
