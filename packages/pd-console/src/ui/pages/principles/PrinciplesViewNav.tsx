import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

/**
 * PRI-641: internal navigation inside the Principles section — Workspace
 * Principles vs the read-only PD Core Principles reference surface. The
 * sidebar keeps a single "Principles" entry; this is the only extra nav.
 */
export function PrinciplesViewNav({ view }: { view: "workspace" | "core" }) {
  const { t } = useTranslation("pages");
  const base =
    "font-mono text-[11px] uppercase tracking-[0.02em] border rounded-[2px] px-2 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov ";
  const active = "bg-gov text-paper border-gov";
  const inactive = "bg-surface text-ink-3 border-line hover:border-line-2";
  return (
    <div className="flex gap-1 mb-6" role="group" aria-label={t("principles.viewNavLabel")}>
      <Link
        to="/principles"
        className={base + (view === "workspace" ? active : inactive)}
        aria-current={view === "workspace" ? "page" : undefined}
      >
        {t("principles.tabWorkspace")}
      </Link>
      <Link
        to="/principles/core"
        className={base + (view === "core" ? active : inactive)}
        aria-current={view === "core" ? "page" : undefined}
      >
        {t("principles.tabCore")}
      </Link>
    </div>
  );
}
