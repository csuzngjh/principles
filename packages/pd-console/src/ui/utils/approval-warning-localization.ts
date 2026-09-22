/**
 * Approval warning localization (PRI-908).
 *
 * Approve responses carry non-fatal warnings as raw English technical strings
 * (PRI-890, rc-9). This module maps known warning codes to Owner-facing i18n
 * templates; unrecognized text falls back to the raw string so information is
 * never lost. Dependency-free like blocker-localization.ts so UI tests can
 * exercise the real behavior directly.
 */

export type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

export interface LocalizedApprovalWarning {
  /** Stable machine code when recognized, otherwise 'unknown'. */
  code: string;
  /** Localized headline, or the raw server text when the code is unknown. */
  title: string;
  /** Localized plain-language body; present only for recognized codes. */
  body?: string;
  /** Raw server text, for the expandable details line (rc-9: never dropped). */
  detail: string;
  /** Whether to offer the Owner a jump to the activation page. */
  activationAction: boolean;
}

/** A warning is "<code>: <free text>" — the code itself is always snake_case. */
function splitWarningCode(warning: string): { code: string; message: string } {
  const trimmed = warning.trim();
  const separator = trimmed.indexOf(':');
  if (separator === -1) return { code: 'unknown', message: trimmed };
  const head = trimmed.slice(0, separator);
  if (!/^[a-z][a-z0-9_]*$/.test(head)) return { code: 'unknown', message: trimmed };
  return { code: head, message: trimmed.slice(separator + 1).trim() };
}

/** Digits immediately after `prefix`, ended by any non-digit — else null. */
function intAfterPrefix(message: string, prefix: string): number | null {
  const start = message.indexOf(prefix);
  if (start === -1) return null;
  const valueStart = start + prefix.length;
  let end = valueStart;
  while (end < message.length && message.charCodeAt(end) >= 48 && message.charCodeAt(end) <= 57) end += 1;
  if (end === valueStart) return null;
  return Number(message.slice(valueStart, end));
}

/**
 * Localize one server warning. Unknown codes degrade to the raw server text
 * verbatim (title === detail) — never a placeholder, never dropped (rc-9).
 */
export function localizeApprovalWarning(warning: string, t: TranslateFn): LocalizedApprovalWarning {
  const { code, message } = splitWarningCode(warning);
  const base = { code, detail: warning.trim() };

  if (code === 'injection_budget_excluded') {
    const budget = intAfterPrefix(message, '(');
    const earlierCount = intAfterPrefix(message, 'filled by ');
    return {
      ...base,
      title: t('pages.focus.approveWarning.budgetExcludedTitle'),
      // PRI-875 precedent: a template with placeholders is only safe to use
      // when every value was parsed — otherwise fall back to the
      // placeholder-free variant so no raw "{{budget}}" ever reaches the UI.
      body: budget !== null && earlierCount !== null
        ? t('pages.focus.approveWarning.budgetExcludedBody', { budget, earlierCount })
        : t('pages.focus.approveWarning.budgetExcludedBodySimple'),
      activationAction: true,
    };
  }
  if (code === 'injection_excluded_non_budget') {
    return {
      ...base,
      title: t('pages.focus.approveWarning.excludedTitle'),
      body: t('pages.focus.approveWarning.excludedNonBudgetBody'),
      activationAction: true,
    };
  }
  if (code === 'injection_budget_check_failed') {
    return {
      ...base,
      title: t('pages.focus.approveWarning.checkFailedTitle'),
      body: t('pages.focus.approveWarning.checkFailedBody'),
      activationAction: true,
    };
  }
  if (code === 'ledger_activate_skipped' || code === 'ledger_activate_failed') {
    return {
      ...base,
      title: t('pages.focus.approveWarning.ledgerTitle'),
      body: t('pages.focus.approveWarning.ledgerBody'),
      activationAction: false,
    };
  }
  return { ...base, title: warning.trim(), activationAction: false };
}
