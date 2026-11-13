const UPDATE_APPLY_FULL_DEFAULT_TIMEOUT_MS = 180000;
// PRI-1101: this is an EMPIRICAL budget, not a proven bound on the inner work.
// The check refreshes signed metadata through tuf-js, whose defaults are
// `fetchTimeout: 100_000` PER ATTEMPT and `fetchRetry: 2`. @gar/promise-retry
// reads that as "two retries after the first attempt", so ONE metadata request
// can take 3 x 100s. `Updater.refresh()` then issues at least four sequential
// requests (root, timestamp, snapshot, targets) before the channel document and
// the release metadata, so the derivable worst case is on the order of 1200s.
//
// 120s covers the observed slow examples (~12.5s on a CN network; the 30s
// budget this replaces was outlived at least once) with a wide margin, while
// staying far below that worst case. A check exceeding 120s is therefore STILL
// reported as a timeout even when it later succeeds: that is an accepted
// residual, not coverage. The 30s "still running" log in routes/update.ts makes
// the wait observable.
const UPDATE_CHECK_DEFAULT_TIMEOUT_MS = 120000;
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
