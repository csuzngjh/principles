import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * The one place raw identifiers, absolute paths and timestamps are allowed:
 * collapsed by default, opened only when the Owner asks for them.
 *
 * DESIGN_BRIEF D14: technical facts stay available but never set the tone of
 * the reading path.
 */
export function TechnicalDetails({
  children,
  testId,
  className = "",
}: {
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <details
      className={`mt-3 border-t border-line/60 pt-3 ${className}`.trim()}
      data-testid={testId ?? "technical-details"}
    >
      <summary className="cursor-pointer text-caption text-gov select-none">
        {t("common.technicalDetails")}
      </summary>
      <dl className="mt-2 space-y-1 font-mono text-caption leading-relaxed text-ink-4 break-all">
        {children}
      </dl>
    </details>
  );
}

export function TechnicalRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-ink-4/80">{label}</dt>
      <dd className="min-w-0">{value}</dd>
    </div>
  );
}
