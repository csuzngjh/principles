const UPDATE_APPLY_FULL_DEFAULT_TIMEOUT_MS = 180000;
const UPDATE_CHECK_DEFAULT_TIMEOUT_MS = 30000;
// Node clamps delays above this limit to 1ms instead of honoring the timeout.
const MAX_TIMEOUT_MS = 2_147_483_647;

function resolveTimeoutMs(envKey: string, defaultMs: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw.trim().length === 0) return defaultMs;
  // Plain decimal digits only: Number() also reads '0x10' as 16, so a hex or
  // exponent form would silently collapse the budget instead of widening it.
  const trimmed = raw.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MS) {
    console.error(`[pd-console] ${envKey}=${JSON.stringify(raw)} must be a plain decimal integer between 1 and ${MAX_TIMEOUT_MS} — using the ${defaultMs}ms default.`);
    return defaultMs;
  }
  return parsed;
}

export function resolveApplyFullTimeoutMs(): number {
  return resolveTimeoutMs('PD_UPDATE_APPLY_FULL_TIMEOUT_MS', UPDATE_APPLY_FULL_DEFAULT_TIMEOUT_MS);
}

export function resolveCheckTimeoutMs(): number {
  return resolveTimeoutMs('PD_UPDATE_CHECK_TIMEOUT_MS', UPDATE_CHECK_DEFAULT_TIMEOUT_MS);
}
