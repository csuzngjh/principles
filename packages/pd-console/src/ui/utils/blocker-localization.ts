/**
 * Blocker localization for the Owner decision view (PRI-875).
 *
 * Dependency-free so UI tests can exercise the real behavior directly.
 */

export type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

function resolveBlockerTemplate(code: string, t: TranslateFn, values?: Record<string, unknown>): string {
  const safeKey = code.replace(/[^a-zA-Z0-9_.]/g, '_');
  return t(`principles.detail.ownerDecision.blocker.${safeKey}`, { defaultValue: '', ...values });
}

export function localizeBlocker(code: string, ownerText: string, t: TranslateFn): string {
  const localized = resolveBlockerTemplate(code, t);
  return localized === '' ? ownerText : localized;
}

export function isValidAggregatedCount(count: unknown): count is number {
  return typeof count === 'number' && Number.isInteger(count) && count >= 1;
}

const AGGREGATED_NOTICE_CODE = 'historical_processing_issue';

/**
 * Localize a blocker reason for rendering.
 *
 * The aggregated historical-processing notice's locale template carries an
 * `{{n}}` placeholder (PRI-875), so it is only safe to interpolate with a
 * validated integer count. A missing count (older core, version skew) or a
 * malformed one renders the core-provided ownerText, which is always a
 * complete sentence — never a raw placeholder. Other codes have no
 * placeholders and take the normal template path.
 */
export function localizeAggregatedBlocker(
  reason: { code: string; ownerText: string; count?: unknown },
  t: TranslateFn,
): string {
  if (reason.code !== AGGREGATED_NOTICE_CODE) {
    return localizeBlocker(reason.code, reason.ownerText, t);
  }
  if (!isValidAggregatedCount(reason.count)) return reason.ownerText;
  const localized = resolveBlockerTemplate(reason.code, t, { n: reason.count });
  return localized === '' ? reason.ownerText : localized;
}
