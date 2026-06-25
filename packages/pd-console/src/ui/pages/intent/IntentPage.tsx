import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { fetchIntentSummary } from "../../api.js";
import type { IntentSummaryData, IntentDocWarningData } from "../../api.js";

// ── Page state ────────────────────────────────────────────────────────────────

type PageState = "loading" | "loaded" | "error";

// ── Sub-components ────────────────────────────────────────────────────────────

function FlagDisabledBanner() {
  const { t } = useTranslation();
  return (
    <div className="bg-panel border border-line rounded-[6px] p-5">
      <h2 className="text-ink text-[15px] font-semibold mb-2">
        {t("pages.intent.flagDisabled.title")}
      </h2>
      <p className="text-ink-3 text-[13px] leading-relaxed mb-3">
        {t("pages.intent.flagDisabled.description")}
      </p>
      <div className="font-mono text-[12px] text-ink-2 bg-surface border border-line rounded-[3px] px-3 py-2">
        {t("pages.intent.flagDisabled.nextAction")}
      </div>
    </div>
  );
}

function NotFoundBanner() {
  const { t } = useTranslation();
  return (
    <div className="bg-panel border border-line rounded-[6px] p-5">
      <h2 className="text-ink text-[15px] font-semibold mb-2">
        {t("pages.intent.notFound.title")}
      </h2>
      <p className="text-ink-3 text-[13px] leading-relaxed mb-3">
        {t("pages.intent.notFound.description")}
      </p>
      <div className="font-mono text-[12px] text-ink-2 bg-surface border border-line rounded-[3px] px-3 py-2">
        {t("pages.intent.notFound.nextAction")}
      </div>
    </div>
  );
}

function OversizedBanner() {
  const { t } = useTranslation();
  return (
    <div className="bg-panel border border-amber/30 rounded-[6px] p-5">
      <h2 className="text-ink text-[15px] font-semibold mb-2">
        {t("pages.intent.oversized.title")}
      </h2>
      <p className="text-ink-3 text-[13px] leading-relaxed mb-3">
        {t("pages.intent.oversized.description")}
      </p>
      <div className="font-mono text-[12px] text-ink-2 bg-surface border border-line rounded-[3px] px-3 py-2">
        {t("pages.intent.oversized.nextAction")}
      </div>
    </div>
  );
}

function WarningItem({ warning }: { warning: IntentDocWarningData }) {
  const { t } = useTranslation();
  return (
    <li className="flex items-start gap-2 text-ink-2 text-[13px]">
      <span className="text-amber shrink-0 mt-0.5" aria-hidden="true">!</span>
      <span>
        <span className="font-medium">{t(`pages.intent.warnings.${warning.code}`)}</span>
        {warning.section && (
          <span className="text-ink-3 font-mono ml-2">[{warning.section}]</span>
        )}
        <span className="text-ink-3 ml-2">{warning.message}</span>
      </span>
    </li>
  );
}

function SectionContent({ label, content }: { label: string; content: string | undefined }) {
  if (content === undefined || content.trim() === "") return null;
  return (
    <div>
      <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-1.5">
        {label}
      </h3>
      <p className="text-ink-2 text-[13px] leading-relaxed whitespace-pre-wrap">{content}</p>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 w-32 shrink-0">
        {label}
      </span>
      <span className="text-ink-2 text-[12px] font-mono break-all">{value}</span>
    </div>
  );
}

// ── Main page component ──────────────────────────────────────────────────────

export function IntentPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<IntentSummaryData | null>(null);
  const [pageState, setPageState] = useState<PageState>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setPageState("loading");
    setErrorMsg(null);
    const result = await fetchIntentSummary();
    if (!result.success) {
      // ERR-002: graceful degradation with reason
      setErrorMsg(result.error ?? t("pages.intent.loadError"));
      setPageState("error");
      return;
    }
    // result.data is already validated by validateIntentSummary in the API layer
    setData(result.data);
    setPageState("loaded");
  }, [t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Loading state ────────────────────────────────────────────────────────
  if (pageState === "loading") {
    return (
      <PageShell>
        <PageLoading cardCount={3} label={t("common.loading")} />
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────────
  if (pageState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.intent.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.intent.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.intent.loadError")}</p>
          {errorMsg && (
            <p className="mt-2 text-ink-4 text-[13px] font-mono">{errorMsg}</p>
          )}
        </div>
        <div className="mt-4">
          <button
            type="button"
            onClick={loadData}
            className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("common.refresh")}
          </button>
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ─────────────────────────────────────────────────────────
  const summary = data;

  return (
    <PageShell>
      <div className="animate-[pdFadeIn_400ms_ease-out]">
        {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.intent.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.intent.title")}
        </h1>
        <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
          {t("pages.intent.subtitle")}
        </p>

        {/* Flag-disabled short-circuit */}
        {summary && !summary.flagEnabled && (
          <FlagDisabledBanner />
        )}

        {/* Flag-on but file not found */}
        {summary && summary.flagEnabled && !summary.found && summary.reason === "not_found" && (
          <NotFoundBanner />
        )}

        {/* Flag-on but oversized */}
        {summary && summary.flagEnabled && summary.found && summary.reason === "oversized" && (
          <OversizedBanner />
        )}

        {/* Flag-on and valid — show sections */}
        {summary && summary.flagEnabled && summary.ok && summary.sections && (
          <>
            {/* Sections */}
            <section aria-labelledby="section-content">
              <SectionTitle id="section-content">
                {t("pages.intent.title")}
              </SectionTitle>
              <div className="bg-panel border border-line rounded-[6px] p-5 space-y-5">
                <SectionContent label={t("pages.intent.sections.why")} content={summary.sections.why} />
                <SectionContent label={t("pages.intent.sections.desiredOutcome")} content={summary.sections.desiredOutcome} />
                <SectionContent label={t("pages.intent.sections.nonNegotiables")} content={summary.sections.nonNegotiables} />
                <SectionContent label={t("pages.intent.sections.stopEscalation")} content={summary.sections.stopEscalation} />
                <SectionContent label={t("pages.intent.sections.currentStrategicFocus")} content={summary.sections.currentStrategicFocus} />
              </div>
            </section>

            {/* Health warnings */}
            <section className="mt-8" aria-labelledby="section-warnings">
              <SectionTitle id="section-warnings">
                {t("pages.intent.warnings.title")}
              </SectionTitle>
              {summary.warnings.length === 0 ? (
                <p className="text-ink-3 text-[13px] leading-relaxed">
                  {t("pages.intent.warnings.empty")}
                </p>
              ) : (
                <ul className="bg-panel border border-line rounded-[6px] p-4 space-y-2">
                  {summary.warnings.map((w, i) => (
                    <WarningItem key={i} warning={w} />
                  ))}
                </ul>
              )}
            </section>

            {/* Meta */}
            <section className="mt-8" aria-labelledby="section-meta">
              <SectionTitle id="section-meta">
                {t("pages.intent.meta.lastEditedAt")}
              </SectionTitle>
              <div className="bg-panel border border-line rounded-[6px] p-4 space-y-2">
                {summary.lastEditedAt && (
                  <MetaRow label={t("pages.intent.meta.lastEditedAt")} value={summary.lastEditedAt} />
                )}
                {summary.contentHash && (
                  <MetaRow label={t("pages.intent.meta.contentHash")} value={summary.contentHash} />
                )}
                {summary.path && (
                  <MetaRow label="Path" value={summary.path} />
                )}
              </div>
            </section>
          </>
        )}

        {/* Flag-on but other error (read_error / parse_error) */}
        {summary && summary.flagEnabled && !summary.ok && summary.reason && summary.reason !== "not_found" && summary.reason !== "oversized" && (
          <div className="bg-panel border border-red-200 rounded-[6px] p-5">
            <h2 className="text-ink text-[15px] font-semibold mb-2">
              {t("pages.intent.loadError")}
            </h2>
            <p className="text-ink-3 text-[13px] leading-relaxed mb-3 font-mono">
              {summary.reason}
            </p>
            {summary.nextAction && (
              <p className="text-ink-2 text-[13px] leading-relaxed">
                {summary.nextAction}
              </p>
            )}
          </div>
        )}
      </div>
    </PageShell>
  );
}