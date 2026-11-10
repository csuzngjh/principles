/**
 * Response budget — SPEC-PD-MCP-GATE4-001 §4.6 (Gate 4 Adapter responsibility;
 * NOT a Core Capability constraint).
 *
 * The single text content block carries the `pd.capability.v1` JSON. Its
 * UTF-8 byte size must be ≤ 32768: 32768 passes, 32769 is over budget.
 * Over budget is a bounded failure envelope (`unavailable` +
 * `response_budget_exceeded`), never a silent truncation, never a field-drop
 * disguised as success. The failure envelope itself must fit the budget.
 */
export const RESPONSE_BUDGET_BYTES = 32768 as const;

/** UTF-8 byte length of the exact string that will be placed in the text
 * content block — the measure the contract is written against. */
export function measureTextBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function withinBudget(text: string, limit: number = RESPONSE_BUDGET_BYTES): boolean {
  return measureTextBytes(text) <= limit;
}
