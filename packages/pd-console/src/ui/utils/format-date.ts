/**
 * Format an ISO timestamp following the UI language, not the browser/OS locale.
 *
 * PD is bilingual (zh-CN / en): a user running an English OS while viewing the
 * zh-CN UI must still see zh-CN dates (and vice versa), so the locale always
 * comes from i18n.language instead of the ambient environment.
 *
 * Invalid or missing input returns the raw string unchanged — Intl would
 * render "Invalid Date" for NaN dates, which must never reach the screen.
 */
export function formatDate(
  iso: string,
  language?: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const locale = language && language !== "unknown" ? language : undefined;
  return new Intl.DateTimeFormat(locale, options).format(date);
}
