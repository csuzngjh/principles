const UPDATE_APPLY_FULL_DEFAULT_TIMEOUT_MS = 180000;
// Node clamps delays above this limit to 1ms instead of honoring the timeout.
const MAX_APPLY_FULL_TIMEOUT_MS = 2_147_483_647;

export function resolveApplyFullTimeoutMs(): number {
  const raw = process.env.PD_UPDATE_APPLY_FULL_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) return UPDATE_APPLY_FULL_DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_APPLY_FULL_TIMEOUT_MS) {
    console.error(`[pd-console] PD_UPDATE_APPLY_FULL_TIMEOUT_MS=${JSON.stringify(raw)} must be an integer between 1 and ${MAX_APPLY_FULL_TIMEOUT_MS} — using the ${UPDATE_APPLY_FULL_DEFAULT_TIMEOUT_MS}ms default.`);
    return UPDATE_APPLY_FULL_DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}
