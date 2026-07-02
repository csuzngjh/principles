import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { ShinyText } from "../../components/ui/shiny-text.js";
import { Button } from "../../components/ui/button.js";
import { AlertTriangle, Archive, Trash2, Check, X, RotateCcw } from "lucide-react";
import {
  fetchPrinciples,
  fetchAllActivations,
  fetchGovernanceQueue,
  archivePrinciple,
  unarchivePrinciple,
  disableActivation,
} from "../../api.js";
import {
  validatePrinciplesList,
  validateActivations,
  validateGovernanceQueue,
} from "../../utils/validators.js";
import type {
  PrincipleListItemData,
  ActivationRecordData,
  StagnationSignalData,
} from "../../utils/validators.js";

// ── Debt Item Type ───────────────────────────────────────────────────────────
interface DebtItem {
  id: string; // Principle ID
  text: string;
  triggerPattern: string;
  type: "never_activated" | "stagnant";
  daysSince?: number; // Only for stagnant approvals
  status: string; // 'active' | 'candidate' | 'probation' | etc.
  activeActivationRecords?: ActivationRecordData[]; // List of active activations to disable
}

// ── Debt Card Component (Handles its own J.1 confirmation state) ──────────────
function DebtCard({
  item,
  onArchive,
  onDeactivate,
  isProcessing,
}: {
  item: DebtItem;
  onArchive: (principleId: string) => Promise<void>;
  onDeactivate: (activationId: string, principleId: string) => Promise<void>;
  isProcessing: boolean;
}) {
  const { t } = useTranslation();
  const [confirmAction, setConfirmAction] = useState<"archive" | "deactivate" | null>(null);
  const [selectedActivationId, setSelectedActivationId] = useState<string | null>(null);

  const handleArchiveClick = () => {
    setConfirmAction("archive");
  };

  const handleDeactivateClick = (activationId: string) => {
    setSelectedActivationId(activationId);
    setConfirmAction("deactivate");
  };

  const handleCancel = () => {
    setConfirmAction(null);
    setSelectedActivationId(null);
  };

  const handleConfirm = async () => {
    if (confirmAction === "archive") {
      await onArchive(item.id);
    } else if (confirmAction === "deactivate" && selectedActivationId) {
      await onDeactivate(selectedActivationId, item.id);
    }
    setConfirmAction(null);
    setSelectedActivationId(null);
  };

  // Render natural language reason based on debt type
  const renderReason = () => {
    if (item.type === "never_activated") {
      return (
        <span className="text-ink-2">
          {t("pages.debt.reasonNeverActivated")}
        </span>
      );
    }
    if (item.type === "stagnant") {
      return (
        <span className="text-ink-2">
          {t("pages.debt.reasonStagnant")}
          {item.daysSince !== undefined && (
            <span className="text-amber font-semibold ml-1">
              ({t("pages.debt.daysSinceAgo", { count: item.daysSince })})
            </span>
          )}
        </span>
      );
    }
    return null;
  };

  const isStagnant = item.type === "stagnant";

  return (
    <article
      className="p-5 bg-panel border border-line rounded-[6px] hover:border-line-2 transition-colors relative"
      aria-label={t("pages.debt.principleAriaLabel", { id: item.id })}
    >
      <div className="flex flex-col md:flex-row md:items-start gap-4">
        {/* Left Section: Details */}
        <div className="flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase px-2 py-0.5 bg-line rounded text-ink-3">
              {item.id}
            </span>
            <span
              className={`font-mono text-[11px] uppercase px-2 py-0.5 rounded ${
                isStagnant
                  ? "bg-amber/10 text-amber"
                  : "bg-danger/10 text-danger"
              }`}
            >
              {isStagnant ? t("pages.focus.summaryStagnation") : t("pages.sidebar.debt")}
            </span>
          </div>

          {/* Principle content */}
          <div className="space-y-1">
            <p className="text-ink text-[15px] font-medium leading-relaxed">
              {item.text}
            </p>
            {item.triggerPattern && (
              <p className="text-ink-3 text-[13px] font-mono leading-relaxed">
                {t("principles.detail.triggerLabel", { defaultValue: "Trigger:" })} {item.triggerPattern}
              </p>
            )}
          </div>

          {/* Natural language debt reason */}
          <div className="flex items-start gap-2 pt-1">
            <AlertTriangle className="w-4 h-4 text-amber shrink-0 mt-0.5" aria-hidden="true" />
            <div className="text-[13px] leading-relaxed">
              <span className="font-semibold text-ink-3">{t("pages.debt.suggestedAction")}: </span>
              {renderReason()}
            </div>
          </div>
        </div>

        {/* Right Section: Actions */}
        <div className="flex flex-col gap-2 shrink-0 md:w-48">
          {!confirmAction ? (
            <>
              {/* Archive Action */}
              <button
                onClick={handleArchiveClick}
                disabled={isProcessing}
                className="w-full inline-flex items-center justify-center gap-1.5 border border-line bg-surface text-ink hover:border-line-2 transition-colors rounded-[3px] px-[14px] py-[6px] text-[12.5px] focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                data-testid={`archive-btn-${item.id}`}
              >
                <Archive className="w-4 h-4 text-ink-3" aria-hidden="true" />
                {t("pages.debt.actionArchive")}
              </button>

              {/* Deactivate Channel Actions (if any active activations exist) */}
              {item.activeActivationRecords && item.activeActivationRecords.length > 0 ? (
                item.activeActivationRecords.map((ar) => (
                  <button
                    key={ar.activationId}
                    onClick={() => handleDeactivateClick(ar.activationId)}
                    disabled={isProcessing}
                    className="w-full inline-flex items-center justify-center gap-1.5 border border-danger/20 bg-surface text-danger hover:bg-danger/5 transition-colors rounded-[3px] px-[14px] py-[6px] text-[12.5px] focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                    data-testid={`deactivate-btn-${ar.activationId}`}
                  >
                    <Trash2 className="w-4 h-4 text-danger/80" aria-hidden="true" />
                    {t("pages.debt.actionDeactivate")} ({ar.channel})
                  </button>
                ))
              ) : (
                /* Demote action: disabled placeholder since no API route exists yet */
                <button
                  disabled
                  className="w-full inline-flex items-center justify-center gap-1.5 border border-line bg-surface/50 text-ink-4 cursor-not-allowed rounded-[3px] px-[14px] py-[6px] text-[12.5px]"
                  title={t("pages.debt.demoteTooltip")}
                >
                  {t("pages.debt.actionKeep")}
                </button>
              )}
            </>
          ) : (
            /* J.1 Inline Confirmation Bar */
            <div
              className="flex flex-col gap-2 p-3 bg-surface border border-amber/20 rounded-[4px] w-full"
              role="alert"
              data-testid={`confirm-bar-${item.id}`}
            >
              <p className="text-ink-2 text-[12px] leading-relaxed">
                {confirmAction === "archive"
                  ? t("pages.debt.confirmArchive")
                  : t("pages.debt.confirmDeactivate")}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleConfirm}
                  disabled={isProcessing}
                  className="flex-1 text-[12px] py-1"
                  data-testid={`confirm-btn-${item.id}`}
                >
                  {t("common.confirm")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                  className="flex-1 text-[12px] py-1"
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

// ── Main Page Component ──────────────────────────────────────────────────────
export function DebtPage() {
  const { t } = useTranslation();
  const [loadingState, setLoadingState] = useState<"loading" | "loaded" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [debtItems, setDebtItems] = useState<DebtItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const loadData = useCallback(async () => {
    setLoadingState("loading");
    setErrorMessage(null);

    try {
      const [principlesRes, activationsRes, govQueueRes] = await Promise.all([
        fetchPrinciples("all"),
        fetchAllActivations(),
        fetchGovernanceQueue(),
      ]);

      // Handle raw response validation (EP-01 / EP-03)
      if (!principlesRes.success) {
        setLoadingState("error");
        setErrorMessage(principlesRes.error || "Failed to fetch principles");
        return;
      }
      if (!activationsRes.success) {
        setLoadingState("error");
        setErrorMessage(activationsRes.error || "Failed to fetch activations");
        return;
      }
      if (!govQueueRes.success) {
        setLoadingState("error");
        setErrorMessage(govQueueRes.error || "Failed to fetch governance queue");
        return;
      }

      const validatedPrinciples = validatePrinciplesList(principlesRes.data);
      const validatedActivations = validateActivations(activationsRes.data);
      const validatedGovQueue = validateGovernanceQueue(govQueueRes.data);

      if (!validatedPrinciples || !validatedActivations || !validatedGovQueue) {
        setLoadingState("error");
        setErrorMessage("Data validation failed: unexpected response shape");
        return;
      }

      // Filter and build the debt list (no-complexity heuristics)
      const allPrinciples = validatedPrinciples.principles;
      const allActivations = validatedActivations.activations;
      const stagnationSignals = validatedGovQueue.stagnationSignals;

      const items: DebtItem[] = [];

      // 1. Identify "Never Activated" Principles
      // An active principle with status === 'active' is never activated if it has no active activations.
      const activePrinciples = allPrinciples.filter((p) => p.status === "active");
      for (const p of activePrinciples) {
        const principleActivations = allActivations.filter((a) => a.principleId === p.id);
        const hasActiveActivation = principleActivations.some((a) => a.status === "active");

        if (!hasActiveActivation) {
          // It qualifies as never-activated debt
          items.push({
            id: p.id,
            text: p.text,
            triggerPattern: p.triggerPattern,
            type: "never_activated",
            status: p.status,
            activeActivationRecords: principleActivations.filter((a) => a.status === "active"),
          });
        }
      }

      // 2. Identify "Stagnant" Principle Approvals (stagnant for > 7 days)
      for (const signal of stagnationSignals) {
        // Skip if we already added it (should not overlap, but to be safe)
        if (items.some((item) => item.id === signal.principleId)) {
          continue;
        }

        const p = allPrinciples.find((p) => p.id === signal.principleId);
        if (p) {
          items.push({
            id: p.id,
            text: p.text,
            triggerPattern: p.triggerPattern,
            type: "stagnant",
            daysSince: signal.daysSince,
            status: p.status,
          });
        }
      }

      setDebtItems(items);
      setLoadingState("loaded");
    } catch (e: unknown) {
      setLoadingState("error");
      setErrorMessage(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Archive Action: calls POST /api/principles/:id/archive and triggers J.2 Undo toast
  const handleArchive = async (principleId: string) => {
    setIsProcessing(true);
    const result = await archivePrinciple(principleId);

    if (result.success) {
      // Remove it from the local view immediately
      setDebtItems((prev) => prev.filter((item) => item.id !== principleId));

      // J.2 Undo Toast: 5 seconds countdown action link
      toast.success(t("pages.debt.archiveSuccess"), {
        description: t("pages.activation.disableSuccessDescription", { id: principleId, defaultValue: `Principle ${principleId} archived` }),
        action: {
          label: t("pages.debt.undoAction"),
          onClick: async () => {
            const undoResult = await unarchivePrinciple(principleId);
            if (undoResult.success) {
              toast.success(t("pages.debt.undoSuccess"));
              loadData(); // Reload to restore the principle in list
            } else {
              toast.error(t("pages.debt.undoFailed"));
            }
          },
        },
        duration: 5000,
      });
    } else {
      toast.error(t("pages.debt.archiveFailed"), {
        description: result.error,
        duration: 8000,
      });
    }
    setIsProcessing(false);
  };

  // Deactivate Action: calls POST /api/v1/activations/:id/disable
  const handleDeactivate = async (activationId: string, principleId: string) => {
    setIsProcessing(true);
    const result = await disableActivation(activationId);

    if (result.success) {
      // Update local state by filtering out this deactivated record
      setDebtItems((prev) =>
        prev
          .map((item) => {
            if (item.id !== principleId) return item;
            const updatedActivations = item.activeActivationRecords?.filter(
              (ar) => ar.activationId !== activationId
            );
            return {
              ...item,
              activeActivationRecords: updatedActivations,
            };
          })
      );

      toast.success(t("pages.debt.deactivateSuccess"), {
        description: t("pages.activation.disableSuccessDescription", { id: principleId }),
        duration: 5000,
      });
      loadData(); // reload fresh state
    } else {
      toast.error(t("pages.debt.deactivateFailed"), {
        description: result.error,
        duration: 8000,
      });
    }
    setIsProcessing(false);
  };

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loadingState === "loading") {
    return (
      <PageShell>
        <PageLoading cardCount={3} label={t("common.loading")} />
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with explanation) ────────────────────
  if (loadingState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.debt.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.debt.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.debt.loadError")}</p>
          {errorMessage && (
            <p className="mt-2 text-ink-4 text-[13px] font-mono">{errorMessage}</p>
          )}
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ───────────────────────────────────────────────────────────
  return (
    <PageShell>
      <div className="animate-[pdFadeIn_400ms_ease-out] space-y-6">
        {/* Layer 1: Title & Subtitle */}
        <div>
          <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
            {t("pages.debt.eyebrow")}
          </div>
          <ShinyText
            as="h1"
            className="text-[29px] font-semibold tracking-tight text-ink mb-2"
            duration={4.5}
            brightness={0.5}
            disabled={debtItems.length === 0}
          >
            {t("pages.debt.title")}
          </ShinyText>
          <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed">
            {t("pages.debt.subtitle")}
          </p>
        </div>

        {/* Section List */}
        <section aria-label={t("pages.debt.listAriaLabel")} className="space-y-[14px]">
          {debtItems.length > 0 ? (
            <>
              <SectionTitle id="section-debt-list">
                {t("pages.sidebar.debt")} ({debtItems.length})
              </SectionTitle>
              <div className="space-y-[14px]">
                {debtItems.map((item) => (
                  <DebtCard
                    key={`${item.id}-${item.type}`}
                    item={item}
                    onArchive={handleArchive}
                    onDeactivate={handleDeactivate}
                    isProcessing={isProcessing}
                  />
                ))}
              </div>
            </>
          ) : (
            /* Empty state (F) - Honest and guiding */
            <div
              className="p-8 text-center bg-panel border border-line border-dashed rounded-[6px] space-y-3"
              role="status"
            >
              <p className="text-ink-2 font-medium text-[16px]">
                {t("pages.debt.emptyTitle")}
              </p>
              <p className="text-ink-3 text-[13px] max-w-[500px] mx-auto leading-relaxed">
                {t("pages.debt.emptyDescription")}
              </p>
            </div>
          )}
        </section>
      </div>
    </PageShell>
  );
}
