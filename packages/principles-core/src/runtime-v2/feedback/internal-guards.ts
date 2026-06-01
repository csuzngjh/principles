// internal-guards.ts
// Re-exported shared primitive guards used across the feedback module.

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}
