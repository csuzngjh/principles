import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { fetchCorePrinciples } from "../../api.js";
import type { CorePrincipleData } from "../../api.js";
import { PrinciplesViewNav } from "./PrinciplesViewNav.js";

/**
 * PD Core Principles — read-only reference surface (PRI-641).
 *
 * The 10 builtin axioms (T-01..T-10) are PD's own semantics, served from the
 * canonical registry via GET /api/principles/core. They are not workspace
 * governance targets: no lifecycle, no approvals, no archive, no edit. This
 * page renders exactly id / name / statement / layer, localized with the
 * registry's own bilingual fields.
 */
export function CorePrinciplesPage() {
  const { t, i18n } = useTranslation("pages");
  const [principles, setPrinciples] = useState<CorePrincipleData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCore = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Response shape is runtime-validated in fetchCorePrinciples
      // (validateCorePrinciples); no fallback to hardcoded principles on error.
      const result = await fetchCorePrinciples();
      if (!result.success) {
        setError(result.error ?? t("principles.coreLoadFailed"));
        return;
      }
      setPrinciples(result.data.principles);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("principles.coreLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadCore();
  }, [loadCore]);

  const isZh = (i18n.language ?? "").startsWith("zh");
  const foundational = principles.filter((p) => p.layer === "foundational");
  const operating = principles.filter((p) => p.layer === "operating");

  return (
    <PageShell>
      <SectionTitle>{t("principles.coreSectionTitle")}</SectionTitle>
      <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
        {t("principles.coreTitle")}
      </h1>
      <p className="text-ink-3 text-[14px] leading-relaxed mb-1">
        {t("principles.coreDescription")}
      </p>
      <p className="text-ink-4 text-[12px] font-mono mb-6">
        🔒 {t("principles.coreReadOnly")}
      </p>

      <PrinciplesViewNav view="core" />

      {loading && (
        <div className="grid gap-3" role="status" aria-live="polite" aria-label={t("principles.coreLoading")}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-panel border border-line rounded-[var(--radius-md)] p-4">
              <Skeleton className="h-5 w-[40%] rounded-sm mb-3" />
              <Skeleton className="h-4 w-full rounded-sm mb-2" />
              <Skeleton className="h-4 w-[70%] rounded-sm" />
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="border border-danger/30 rounded-[var(--radius-md)] p-4 mb-4">
          <p className="text-danger text-sm">{t("principles.coreLoadFailed")}</p>
          <p className="text-ink-4 text-[12px] mt-1 font-mono break-all">{error}</p>
          <Button variant="outline" size="sm" onClick={loadCore} className="mt-2">
            {t("principles.coreRetry")}
          </Button>
        </div>
      )}

      {!loading && !error && (
        <>
          <CoreLayerGroup
            label={t("principles.coreLayerFoundational")}
            principles={foundational}
            isZh={isZh}
          />
          <CoreLayerGroup
            label={t("principles.coreLayerOperating")}
            principles={operating}
            isZh={isZh}
          />
        </>
      )}
    </PageShell>
  );
}

function CoreLayerGroup({
  label,
  principles,
  isZh,
}: {
  label: string;
  principles: CorePrincipleData[];
  isZh: boolean;
}) {
  const { t } = useTranslation("pages");
  return (
    <section className="mb-8" aria-label={label}>
      <h2 className="font-mono text-[11px] uppercase tracking-[0.02em] text-ink-3 border-b border-line pb-2 mb-4">
        {label} · {principles.length}
      </h2>
      <div className="grid gap-3 animate-[pdFadeIn_400ms_ease-out]">
        {principles.map((p) => {
          const name = isZh ? p.nameZh : p.name;
          const statement = isZh ? p.statementZh : p.statement;
          return (
            <article
              key={p.id}
              id={p.id}
              className="bg-panel border border-line rounded-[var(--radius-md)] p-4"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="font-mono text-[11px] tracking-[0.02em] border border-line rounded-[2px] px-2 py-0.5 text-ink-3">
                  {p.id}
                </span>
                <span className="font-mono text-[11px] tracking-[0.02em] text-ink-4">
                  {t("principles.coreLayer" + (p.layer === "foundational" ? "Foundational" : "Operating"))}
                </span>
              </div>
              <h3 className="font-semibold text-ink mb-1">{name}</h3>
              <p className="text-ink-3 text-[13px] leading-relaxed">{statement}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
