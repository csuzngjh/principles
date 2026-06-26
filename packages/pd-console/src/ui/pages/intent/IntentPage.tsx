import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { fetchIntentSummary, fetchIntentDecisionSummary } from "../../api.js";
import type { IntentSummaryData, IntentDocWarningData, IntentDecisionSummaryData } from "../../api.js";

// ── Page state ────────────────────────────────────────────────────────────────

type PageState = "loading" | "loaded" | "error";

// ── Sub-components ────────────────────────────────────────────────────────────

function FlagStatusBadge({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  // SPEC §22.1.1: Intent Page must show intent_engineering flag status.
  // Badge has a text label, not color-only (SPEC §23.14.10).
  const label = enabled
    ? t("pages.intent.flagStatus.enabled")
    : t("pages.intent.flagStatus.disabled");
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[3px] text-[11px] font-mono border ${
        enabled
          ? "border-emerald/40 text-emerald bg-emerald/5"
          : "border-line text-ink-3 bg-surface"
      }`}
      role="status"
      aria-label={t("pages.intent.flagStatus.ariaLabel")}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${enabled ? "bg-emerald" : "bg-ink-4"}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

function EditEntry({ filePath }: { filePath: string }) {
  const { t } = useTranslation();
  // SPEC §22.1.1 line 1402: Intent Page must show "edit INTENT.md 入口".
  // INTENT.md is Owner-owned; PD never auto-modifies it. This entry only
  // surfaces the file path so the Owner can edit it in their own editor.
  return (
    <div className="bg-panel border border-line rounded-[6px] p-4">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
        {t("pages.intent.editEntry.title")}
      </h3>
      <p className="text-ink-3 text-[13px] leading-relaxed mb-2">
        {t("pages.intent.editEntry.description")}
      </p>
      <div className="flex items-center gap-2">
        <code className="text-[12px] text-ink-2 bg-surface border border-line rounded-[3px] px-2 py-1 break-all">
          {filePath}
        </code>
        <button
          type="button"
          onClick={() => {
            // Copy to clipboard — Owner pastes into their editor.
            void navigator.clipboard?.writeText(filePath);
          }}
          className="shrink-0 border border-line bg-surface text-ink-2 rounded-[3px] px-2 py-1 text-[11px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          aria-label={t("pages.intent.editEntry.copyAriaLabel")}
        >
          {t("pages.intent.editEntry.copy")}
        </button>
      </div>
    </div>
  );
}

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
  // SPEC: warnings are rendered as governance hints via i18n code key,
  // not raw server-side English message text (P2 i18n fix).
  const labelKey = `pages.intent.warnings.${warning.code}`;
  return (
    <li className="flex items-start gap-2 text-ink-2 text-[13px]">
      <span className="text-amber shrink-0 mt-0.5" aria-hidden="true">!</span>
      <span>
        <span className="font-medium">{t(labelKey)}</span>
        {warning.section && (
          <span className="text-ink-3 font-mono ml-2">[{warning.section}]</span>
        )}
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

// ── Decision Summary Section (SPEC §22.1.1) ──────────────────────────────────
// Lightweight audit summary derived from IntentDecisionRecord. NOT a dashboard.
// Only aggregate counts per ownerAction + lastDecisionAt are shown.
// SPEC forbids displaying metrics that cannot be traced back to IntentDecisionRecord.

type DecisionSummaryState = "loading" | "loaded" | "error";

// Static mapping from ownerAction enum value to its i18n label key.
// Avoids dynamic string construction so i18n extraction tools can find keys.
const DECISION_COUNT_LABEL_KEYS: ReadonlyArray<{
  action: keyof IntentDecisionSummaryData["counts"];
  labelKey: string;
}> = [
  { action: "confirm_drift", labelKey: "pages.intent.decisions.countConfirmDrift" },
  { action: "revise_intent", labelKey: "pages.intent.decisions.countReviseIntent" },
  { action: "observe", labelKey: "pages.intent.decisions.countObserve" },
  { action: "dismiss", labelKey: "pages.intent.decisions.countDismiss" },
  { action: "promote_to_principle", labelKey: "pages.intent.decisions.countPromoteToPrinciple" },
  { action: "promote_to_rulehost", labelKey: "pages.intent.decisions.countPromoteToRulehost" },
];

function DecisionSummarySection() {
  const { t } = useTranslation();
  const [state, setState] = useState<DecisionSummaryState>("loading");
  const [summary, setSummary] = useState<IntentDecisionSummaryData | null>(null);

  const loadSummary = useCallback(async () => {
    setState("loading");
    const result = await fetchIntentDecisionSummary();
    if (!result.success) {
      // ERR-002: graceful degradation with reason; section collapses to a single line.
      setState("error");
      return;
    }
    setSummary(result.data);
    setState("loaded");
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  return (
    <section className="mt-8" aria-labelledby="section-decisions">
      <SectionTitle id="section-decisions">
        {t("pages.intent.decisions.sectionTitle")}
      </SectionTitle>
      <p className="text-ink-3 text-[13px] leading-relaxed mb-3">
        {t("pages.intent.decisions.sectionSubtitle")}
      </p>
      {state === "loading" && (
        <div className="bg-panel border border-line rounded-[6px] p-4 text-ink-3 text-[13px]">
          {t("common.loading")}
        </div>
      )}
      {state === "error" && (
        <div className="bg-panel border border-line rounded-[6px] p-4 text-ink-3 text-[13px]">
          {t("pages.intent.decisions.loadError")}
        </div>
      )}
      {state === "loaded" && summary && (
        <div className="bg-panel border border-line rounded-[6px] p-4">
          {/* Counts per ownerAction — SPEC §22.1.1: zero counts are still rendered (audit clarity). */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
            {DECISION_COUNT_LABEL_KEYS.map(({ action, labelKey }) => {
              const count = summary.counts[action];
              return (
                <div key={action} className="flex items-baseline gap-2">
                  <dt className="text-ink-3 text-[12px]">{t(labelKey)}</dt>
                  <dd className="text-ink font-mono text-[13px]">{count}</dd>
                </div>
              );
            })}
          </dl>
          {/* lastDecisionAt — null means "no decisions recorded yet" */}
          <div className="mt-4 pt-3 border-t border-line">
            {summary.lastDecisionAt === null ? (
              <p className="text-ink-4 text-[12px]">{t("pages.intent.decisions.noDecisions")}</p>
            ) : (
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                  {t("pages.intent.decisions.lastDecisionAtLabel")}
                </span>
                <span className="text-ink-2 text-[12px] font-mono break-all">{summary.lastDecisionAt}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
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
        {/* Layer 1: Conclusion — eyebrow + title + subtitle + flag badge */}
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.intent.eyebrow")}
        </div>
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-[29px] font-semibold tracking-tight text-ink">
            {t("pages.intent.title")}
          </h1>
          {summary && (
            <FlagStatusBadge enabled={summary.flagEnabled} />
          )}
        </div>
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
                {t("pages.intent.meta.title")}
              </SectionTitle>
              <div className="bg-panel border border-line rounded-[6px] p-4 space-y-2">
                {summary.lastEditedAt && (
                  <MetaRow label={t("pages.intent.meta.lastEditedAt")} value={summary.lastEditedAt} />
                )}
                {summary.contentHash && (
                  <MetaRow label={t("pages.intent.meta.contentHash")} value={summary.contentHash} />
                )}
                {summary.path && (
                  <MetaRow label={t("pages.intent.meta.path")} value={summary.path} />
                )}
              </div>
            </section>

            {/* Edit entry — SPEC §22.1.1 line 1402 */}
            {summary.path && (
              <section className="mt-8" aria-labelledby="section-edit">
                <SectionTitle id="section-edit">
                  {t("pages.intent.editEntry.heading")}
                </SectionTitle>
                <EditEntry filePath={summary.path} />
              </section>
            )}
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

        {/* Decision Summary — SPEC §22.1.1: bottom section, shown when flag is on.
            Decisions are persisted independently of INTENT.md state, so this
            section appears regardless of whether INTENT.md was found/OK. */}
        {summary && summary.flagEnabled && (
          <DecisionSummarySection />
        )}
      </div>
    </PageShell>
  );
}