import { useTranslation } from "react-i18next";

/**
 * "截至 18:42" — the single factual answer to "how old is what I am looking at?"
 *
 * DESIGN_BRIEF D1: the console refreshes once when it opens and never polls.
 * Instead of a live stream or a refresh spinner, each page stamps the moment its
 * data was read. The stamp is deliberately terse: it is a fact about the page,
 * not a prompt to reload.
 */
export function FreshnessStamp({ at, className = "" }: { at: Date | null; className?: string }) {
  const { t } = useTranslation();
  if (at === null) return null;
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <span
      data-testid="freshness-stamp"
      className={`font-mono text-caption text-ink-4 tabular-nums ${className}`.trim()}
    >
      {t("common.asOf", { time })}
    </span>
  );
}
