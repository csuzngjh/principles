import type { IdleTriggerInput, IdleTriggerResult } from './idle-trigger-types.js';
import { evaluateIdleTrigger } from './idle-trigger-policy.js';

export function evaluateIdleTriggerDecision(input: IdleTriggerInput): IdleTriggerResult {
  return evaluateIdleTrigger(input);
}
