import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import {
  fetchAllActivations,
  fetchLifecycleMetrics,
} from "../../api.js";
import type {
  ActivationRecord,
  ActivationsData,
  LifecycleMetricsData,
} from "../../api.js";
import {
  validateActivationsData,
  validateLifecycleMetricsData,
  isReversibleChannel,
} from "./ActivationValidators.js";

// ── Channel label helper ─────────────────────────────────────────────────────

function getChannelLabel(channel: string, t: (key: string) => string): string {
  switch (channel) {
    case "prompt":
      return t("pages.activation.channelPrompt");
    case "defer_archive":
      return t("pages.activation.channelDeferArchive");
    case "code_tool_hook":
      return t("pages.activation.channelCodeToolHook");
    default:
      return channel;
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

function CapabilityBoundaryDeclaration() {
  const { t } = useTranslation();
  return (
    <div
      className="px-[18px] py-[14px] bg-panel border border-line rounded-[6px] text-ink-3 text-[13px] leading-relaxed"
      role="note"
      aria-label={t("pages.activation.boundaryLabel")}
    >
      {t("pages.activation.boundaryText")}
    </div>
  );
}

function ActivationFactCard({
  record,
  lifecycleData,
  onDisable,
  disabling,
}: {
  record: ActivationRecord;
  lifecycleData: LifecycleMetricsData | null | undefined;
  onDisable: (record: ActivationRecord) => void;
  disabling: boolean;
}) {
  const { t } = useTranslation();
  const [showConfirm, setShowConfirm] = useState(false);
  const neverActivated = record.activatedAt === null;
  const channelLabel = getChannelLabel(record.channel, t);
  const reversible = isReversibleChannel(record.channel);

  return (
    <article
      className={`relative pl-[22px] py-[18px] pr-[18px] bg-panel border rounded-[6px] transition-colors hover:border-line-2 ${
        neverActivated ? "border-amber/30 border-l-[3px] border-l-amber" : "border-line"
      }`}
      data-testid={`activation-card-${record.id}`}
    >
      {/* Tags row */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Status label */}
        <span
          className={`inline-flex items-center border rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase ${
            record.status === "active"
              ? "border-green/35 text-green bg-green/5"
              : "border-line text-ink-4 bg-surface/80"
          }`}
          role="status"
        >
          {record.status === "active" ? t("pages.activation.statusActive") : t("pages.activation.statusInactive")}
        </span>
        {/* Channel badge */}
        <span className="inline-flex items-center border border-line rounded-[2px] px-[7px] py-1 font-mono text-[11px] text-ink-3 bg-surface/80 uppercase">
          {channelLabel}
        </span>
        {/* Reversibility indicator */}
        {reversible && (
          <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
            {t("pages.activation.tagReversible")}
          </span>
        )}
        {!reversible && record.channel === "code_tool_hook" && (
          <span className="inline-flex items-center border border-danger/35 text-danger rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
            {t("pages.activation.tagHighRisk")}
          </span>
        )}
        {/* Never activated warning */}
        {neverActivated && (
          <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
            {t("pages.activation.tagNeverActivated")}
          </span>
        )}
      </div>

      {/* Principle info */}
      <div className="mt-[14px] mb-2">
        <span className="text-ink-2 text-[13px]">{t("pages.activation.principleLabel")}</span>{" "}
        <Link
          to={`/principles/${record.principleId}`}
          className="text-gov text-[13px] hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          data-testid={`principle-link-${record.principleId}`}
        >
          {record.principleId}
        </Link>
      </div>

      {/* Action / target / time */}
      <div className="text-ink-3 text-[13px] leading-relaxed space-y-1">
        <div>
          <span className="text-ink-4 font-mono text-[11px] uppercase">{t("pages.activation.actionLabel")}</span>{" "}
          <span className="text-ink-2">{record.action}</span>
        </div>
        <div>
          <span className="text-ink-4 font-mono text-[11px] uppercase">{t("pages.activation.targetLabel")}</span>{" "}
          <span className="text-ink-2 font-mono text-[12px]">{record.targetRef}</span>
        </div>
        <div>
          <span className="text-ink-4 font-mono text-[11px] uppercase">{t("pages.activation.activatedAtLabel")}</span>{" "}
          {neverActivated ? (
            <span className="text-amber">{t("pages.activation.neverActivated")}</span>
          ) : (
            <span className="text-ink-2 font-mono text-[12px] tabular-nums">
              {new Date(record.activatedAt as string).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Layer 3: Lifecycle metrics (expandable, only when principle has rules) */}
      {lifecycleData !== undefined && (
        <details className="mt-4 group">
          <summary className="text-gov text-[13px] cursor-pointer hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2">
            {t("pages.activation.lifecycleToggle")}
          </summary>
          <div className="mt-2 pl-4 border-l-2 border-line">
            {lifecycleData === null ? (
              <div className="text-ink-4 text-[13px] py-2">
                {t("pages.activation.lifecycleUnavailable")}
              </div>
            ) : lifecycleData.adherence.insufficientData ? (
              <div className="text-ink-4 text-[13px] py-2">
                {t("pages.activation.insufficientData")}
              </div>
            ) : (
              <div className="py-2 space-y-2">
                {/* Adherence rate with honest label */}
                <div className="text-ink-2 text-[13px]">
                  <span className="font-mono font-semibold text-ink tabular-nums">
                    {lifecycleData.adherence.rate !== null
                      ? `${(lifecycleData.adherence.rate * 100).toFixed(0)}%`
                      : "—"}
                  </span>{" "}
                  <span className="text-ink-3">{t("pages.activation.adherenceLabel")}</span>
                  <div className="text-ink-4 text-[11px] mt-1 font-mono">
                    {t("pages.activation.lifecycleNote")}
                  </div>
                </div>
                {/* Rule metrics */}
                {lifecycleData.ruleMetrics.length > 0 && (
                  <div className="space-y-1">
                    {lifecycleData.ruleMetrics.map((rm) => (
                      <div key={rm.ruleId} className="text-ink-3 text-[12px] font-mono">
                        <span className="text-ink-2">{rm.ruleId}</span>:{" "}
                        {rm.triggered} {t("pages.activation.triggered")}{" "}
                        {rm.lastTriggeredAt && (
                          <span className="text-ink-4">
                            ({new Date(rm.lastTriggeredAt).toLocaleString()})
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </details>
      )}

      {/* Disable / Rollback action (only for active, reversible channels) */}
      {record.status === "active" && reversible && (
        <div className="mt-4">
          {!showConfirm ? (
            <button
              onClick={() => setShowConfirm(true)}
              disabled={disabling}
              className="inline-flex items-center border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              data-testid={`disable-btn-${record.id}`}
            >
              {t("pages.activation.disableAction")}
            </button>
          ) : (
            <div
              className="flex items-center gap-3 px-[14px] py-[10px] bg-surface border border-amber/25 rounded-[4px]"
              role="alert"
              data-testid={`confirm-bar-${record.id}`}
            >
              <span className="text-ink-2 text-[13px] flex-1">
                {t("pages.activation.confirmDisable")}
              </span>
              <button
                onClick={() => {
                  onDisable(record);
                  setShowConfirm(false);
                }}
                disabled={disabling}
                className="inline-flex items-center border border-danger/40 text-danger bg-surface rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:bg-danger/5 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                data-testid={`confirm-disable-${record.id}`}
              >
                {disabling ? t("pages.activation.disabling") : t("common.confirm")}
              </button>
              <button
                onClick={() => setShowConfirm(false)}
                className="inline-flex items-center border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              >
                {t("common.cancel")}
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ── Main page component ──────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded" | "error";

export function ActivationPage() {
  const { t } = useTranslation();
  const [activationsData, setActivationsData] = useState<ActivationsData | null>(null);
  const [lifecycleCache, setLifecycleCache] = useState<Record<string, LifecycleMetricsData | null>>({});
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [disablingIds, setDisablingIds] = useState<Set<string>>(new Set());
  const [degradedNote, setDegradedNote] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoadingState("loading");
    setErrorMessage(null);
    setDegradedNote(null);

    const result = await fetchAllActivations();

    if (!result.success) {
      setLoadingState("error");
      setErrorMessage(result.error);
      return;
    }

    const validated = validateActivationsData(result.data);
    if (validated === null) {
      setLoadingState("error");
      setErrorMessage("Activation data has unexpected shape");
      return;
    }

    setActivationsData(validated);
    if (validated.note) {
      setDegradedNote(validated.note);
    }

    // Pre-fetch lifecycle metrics for active principles with rules
    // (only for principles that are active, to populate the expandable section)
    const activePrinciples = new Set(
      validated.activations
        .filter((a) => a.status === "active")
        .map((a) => a.principleId)
    );
    const newCache: Record<string, LifecycleMetricsData | null> = {};
    await Promise.all(
      Array.from(activePrinciples).map(async (principleId) => {
        const lifecycleResult = await fetchLifecycleMetrics(principleId);
        if (lifecycleResult.success) {
          const validatedMetrics = validateLifecycleMetricsData(lifecycleResult.data);
          newCache[principleId] = validatedMetrics;
        } else {
          newCache[principleId] = null;
        }
      })
    );
    setLifecycleCache(newCache);

    setLoadingState("loaded");
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleDisable = useCallback(async (record: ActivationRecord) => {
    setDisablingIds((prev) => new Set(prev).add(record.id));

    // Simulate disable — backend doesn't have a disable endpoint yet
    // This is a placeholder that shows the confirmation flow works
    // When the backend endpoint is available, replace this with an actual API call
    toast.success(t("pages.activation.disableSuccess"), {
      description: t("pages.activation.disableSuccessDescription", { id: record.principleId }),
      action: {
        label: t("common.cancel"),
        onClick: () => {
          toast.info(t("pages.activation.undoDisable"));
        },
      },
      duration: 5000,
    });

    // For now, optimistically update the UI
    setActivationsData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        activations: prev.activations.map((a) =>
          a.id === record.id ? { ...a, status: "inactive" as const } : a
        ),
      };
    });

    setDisablingIds((prev) => {
      const next = new Set(prev);
      next.delete(record.id);
      return next;
    });
  }, [t]);

  // ── Loading state ────────────────────────────────────────────────────────
  if (loadingState === "loading") {
    return (
      <PageShell>
        <div className="text-ink-3 text-sm" role="status" aria-live="polite">
          {t("common.loading")}…
        </div>
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────────
  if (loadingState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-2">
          {t("pages.activation.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.activation.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.activation.loadError")}</p>
          {errorMessage && (
            <p className="mt-2 text-ink-4 text-[13px] font-mono">{errorMessage}</p>
          )}
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ─────────────────────────────────────────────────────────
  const activations = activationsData?.activations ?? [];
  const activeActivations = activations.filter((a) => a.status === "active");
  const inactiveActivations = activations.filter((a) => a.status === "inactive");
  const neverActivatedCount = activations.filter((a) => a.activatedAt === null).length;

  return (
    <PageShell>
      {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
      <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
        {t("pages.activation.eyebrow")}
      </div>
      <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
        {t("pages.activation.title")}
      </h1>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t("pages.activation.subtitle")}
      </p>

      {/* Summary line */}
      <div
        className="text-sm leading-relaxed text-ink-2 mb-7 px-[18px] py-[14px] bg-panel border border-line rounded-[6px]"
        role="status"
        aria-live="polite"
      >
        <span className="font-mono font-semibold text-ink tabular-nums">{activeActivations.length}</span>{" "}
        <span className="text-ink-3">{t("pages.activation.summaryActive")}</span>{" "}
        /{" "}
        <span className="font-mono font-semibold text-ink tabular-nums">{inactiveActivations.length}</span>{" "}
        <span className="text-ink-3">{t("pages.activation.summaryInactive")}</span>
        {neverActivatedCount > 0 && (
          <>
            {" "}/{" "}
            <span className="font-mono font-semibold text-amber tabular-nums">{neverActivatedCount}</span>{" "}
            <span className="text-amber">{t("pages.activation.summaryNeverActivated")}</span>
          </>
        )}
      </div>

      {/* Capability boundary declaration (F.5) — always visible */}
      <CapabilityBoundaryDeclaration />

      {/* Degraded note (ERR-002) */}
      {degradedNote && (
        <div className="mt-4 text-ink-4 text-[13px] bg-surface/60 border-l-2 border-amber px-3 py-2">
          {degradedNote}
        </div>
      )}

      {/* Section: Active activations */}
      <section className="mt-8" aria-labelledby="section-active">
        <SectionTitle id="section-active">
          {t("pages.activation.sectionActive")}
        </SectionTitle>

        {activeActivations.length > 0 ? (
          <div className="space-y-[14px]">
            {activeActivations.map((record) => (
              <ActivationFactCard
                key={record.id}
                record={record}
                lifecycleData={lifecycleCache[record.principleId]}
                onDisable={handleDisable}
                disabling={disablingIds.has(record.id)}
              />
            ))}
          </div>
        ) : (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {t("pages.activation.emptyActive")}
          </div>
        )}
      </section>

      {/* Section: Inactive activations */}
      {inactiveActivations.length > 0 && (
        <section className="mt-8" aria-labelledby="section-inactive">
          <SectionTitle id="section-inactive">
            {t("pages.activation.sectionInactive")}
          </SectionTitle>
          <div className="space-y-[14px]">
            {inactiveActivations.map((record) => (
              <ActivationFactCard
                key={record.id}
                record={record}
                lifecycleData={lifecycleCache[record.principleId]}
                onDisable={handleDisable}
                disabling={disablingIds.has(record.id)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Section: Never activated (highlighted, links to debt page) */}
      {neverActivatedCount > 0 && (
        <section className="mt-8" aria-labelledby="section-never-activated">
          <SectionTitle id="section-never-activated">
            {t("pages.activation.sectionNeverActivated")}
          </SectionTitle>
          <div className="space-y-[10px]">
            {activations
              .filter((a) => a.activatedAt === null)
              .map((record) => (
                <article
                  key={record.id}
                  className="relative pl-[22px] py-[14px] pr-[18px] bg-panel border border-amber/20 border-l-[3px] border-l-amber rounded-[6px]"
                >
                  <div className="text-ink-2 text-sm leading-relaxed">
                    <span className="font-medium text-ink">{t("pages.activation.neverActivatedCard")}</span>{" "}
                    — {record.principleId} · {record.channel}
                  </div>
                  <Link
                    to="/debt"
                    className="inline-flex items-center mt-2 text-gov text-[13px] hover:underline focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                  >
                    {t("pages.activation.viewDebt")} →
                  </Link>
                </article>
              ))}
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="mt-12 pt-6 border-t border-line text-ink-3 text-[13px]">
        {t("pages.activation.footer")}
      </footer>
    </PageShell>
  );
}
