/**
 * UpdatePage — PD self-update status and history.
 *
 * Contract aligned with backend routes/update.ts:
 * - GET /api/update/check → { hasUpdate, currentVersion, latestVersion, error? }
 * - GET /api/update/history → [{ id, timestamp, fromVersion, toVersion, success }, ...]
 *
 * Privacy boundary: version strings and timestamps only — no session/path data.
 */
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import {
  fetchUpdateStatus,
  fetchUpdateHistory,
  pruneUpdateHistory,
  applyFullUpdate,
  fetchUpdateRecovery,
  fetchUpdateTransaction,
} from "../../api.js";
import type {
  UpdateStatusData,
  UpdateHistoryData,
  UpdateHistoryEntry,
  ApplyUpdateResultData,
  UpdateRecoveryData,
} from "../../api.js";
import { validateUpdateStatus, validateUpdateHistory, validateUpdateHistoryPruneResult, validateUpdateRecovery, validateUpdateTransaction } from "../../utils/validators.js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "../../components/ui/alert-dialog.js";
import { Loader2, CheckCircle2, XCircle, ArrowRight, AlertTriangle } from "lucide-react";
import { formatDate } from "../../utils/format-date.js";

// ── Main page component ──────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded" | "error";

// Owner-facing history display: newest first, at most 5 entries visible until
// expanded. The API returns file order (append order, oldest first) — the page
// owns the display order. The NaN→0 fallback mirrors the server's factTimeMs
// so unparseable stamps sort stably at the oldest position instead of jumping
// around between renders.
const COLLAPSED_HISTORY_LIMIT = 5;

function factTimeMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Display-order contract: newest entry first (exported for the source-free
 * node-env unit test; rendering itself cannot be mounted without jsdom). */
export function sortHistoryDesc(updates: UpdateHistoryEntry[]): UpdateHistoryEntry[] {
  return [...updates].sort((a, b) => factTimeMs(b.timestamp) - factTimeMs(a.timestamp));
}

export function UpdatePage() {
  const { t, i18n } = useTranslation();
  const [statusData, setStatusData] = useState<UpdateStatusData | null>(null);
  const [historyData, setHistoryData] = useState<UpdateHistoryData | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [checking, setChecking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [historyErrorReason, setHistoryErrorReason] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<{
    success: boolean;
    refusal?: boolean;
    message: string;
    newVersion?: string;
    fromVersion?: string;
    requiresRestart?: boolean;
    reason?: string;
    nextAction?: string;
    gatewayNotice?: string;
  } | null>(null);
  const [showFullUpdateDialog, setShowFullUpdateDialog] = useState(false);
  const [fullUpdating, setFullUpdating] = useState(false);
  // Owner history cleanup: dialog + in-flight flag + expanded-list state
  // (reset when a prune shrinks the list back under the collapsed limit).
  const [showCleanupDialog, setShowCleanupDialog] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [recoveryData, setRecoveryData] = useState<UpdateRecoveryData | null>(null);
  // PRI-853 (SPEC §12.1): a running detached update — the page tracks its
  // transaction instead of treating the accepted request as "success".
  const [inProgress, setInProgress] = useState<{ transactionId: string; phase: string | null } | null>(null);

  const loadData = useCallback(async () => {
    setLoadingState("loading");
    setErrorMessage(null);
    setHistoryErrorReason(null);

    const [statusResult, historyResult, recoveryResult] = await Promise.all([
      fetchUpdateStatus(),
      fetchUpdateHistory(),
      fetchUpdateRecovery(),
    ]);

    // Validate status data (H section / ERR-001/005)
    if (!statusResult.success) {
      setLoadingState("error");
      setErrorMessage(statusResult.error);
      return;
    }
    const validatedStatus = validateUpdateStatus(statusResult.data);
    if (validatedStatus === null) {
      setLoadingState("error");
      setErrorMessage("Update status data has unexpected shape");
      return;
    }
    setStatusData(validatedStatus);

    // Validate history data (ERR-002: degradation with reason)
    if (!historyResult.success) {
      setHistoryData(null);
      setHistoryErrorReason(historyResult.error ?? "Update history unavailable");
    } else {
      const validatedHistory = validateUpdateHistory(historyResult.data);
      setHistoryData(validatedHistory);
      if (validatedHistory === null) {
        setHistoryErrorReason("Update history data has unexpected shape");
      }
    }

    // PRI-848 (SPEC §12.1): recovery surface — surface an unfinished update
    // transaction instead of letting the Owner start a duplicate update.
    if (recoveryResult.success) {
      setRecoveryData(validateUpdateRecovery(recoveryResult.data));
    } else {
      setRecoveryData(null);
    }

    setLoadingState("loaded");
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCheckForUpdates = useCallback(async () => {
    setChecking(true);
    const result = await fetchUpdateStatus();
    if (!result.success) {
      toast.error(t("pages.update.checkFailed"));
      setChecking(false);
      return;
    }
    const validated = validateUpdateStatus(result.data);
    if (validated === null) {
      toast.error(t("pages.update.checkFailed"));
      setChecking(false);
      return;
    }
    setStatusData(validated);
    setChecking(false);
  }, [t]);

  const handleApplyFullUpdate = useCallback(async () => {
    setShowFullUpdateDialog(false);
    setFullUpdating(true);
    setUpdateResult(null);
    const result = await applyFullUpdate();
    setFullUpdating(false);
    if (!result.success) {
      setUpdateResult({ success: false, message: result.error ?? 'Unknown error' });
      toast.error(t('pages.update.updateFailed', { message: result.error ?? 'Unknown error' }));
      return;
    }
    const data = result.data as ApplyUpdateResultData;
    if (data.state === 'update_in_progress' && data.transactionId) {
      // PRI-853 (SPEC §12.1): an ACCEPTED request is not a completed update.
      // Track the detached transaction; only its terminal phase ends this flow.
      setInProgress({ transactionId: data.transactionId, phase: null });
      toast.info(t('pages.update.inProgressToast'));
      return;
    }
    if (data.success) {
      setUpdateResult({
        success: true,
        message: data.message,
        newVersion: data.newVersion,
        fromVersion: statusData?.currentVersion,
        requiresRestart: data.requiresRestart,
        gatewayNotice: data.gatewayNotice,
      });
      toast.success(t('pages.update.fullUpdateSuccess'));
      await loadData();
    } else {
      setUpdateResult({
        success: false,
        refusal: data.refusal,
        message: data.message,
        reason: data.reason,
        nextAction: data.nextAction,
        gatewayNotice: data.gatewayNotice,
      });
      toast.error(t('pages.update.updateFailed', { message: data.message }));
    }
  }, [t, loadData, statusData?.currentVersion]);

  // Owner history cleanup: keep the newest COLLAPSED_HISTORY_LIMIT entries,
  // delete the rest. The server reports the row accounting; the toast surfaces
  // the removed count so the destructive outcome is never silent (rc-9).
  const handleCleanupHistory = useCallback(async () => {
    setShowCleanupDialog(false);
    setCleaningUp(true);
    const result = await pruneUpdateHistory(COLLAPSED_HISTORY_LIMIT);
    setCleaningUp(false);
    if (!result.success) {
      toast.error(t("pages.update.cleanupFailed", { message: result.error ?? "Unknown error" }));
      return;
    }
    const data = validateUpdateHistoryPruneResult(result.data);
    if (data === null) {
      toast.error(t("pages.update.cleanupFailed", { message: "Unexpected response shape" }));
      return;
    }
    toast.success(t("pages.update.cleanupSuccess", { count: data.removed }));
    setShowAllHistory(false);
    await loadData();
  }, [t, loadData]);

  // PRI-853: poll the detached update's transaction until a terminal phase.
  useEffect(() => {
    if (!inProgress) return;
    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      if (cancelled) return;
      attempts += 1;
      const result = await fetchUpdateTransaction(inProgress.transactionId);
      if (cancelled) return;
      const tx = result.success ? validateUpdateTransaction(result.data) : null;
      if (tx === null || !tx.exists) {
        if (attempts >= 200) {
          setInProgress(null);
          setUpdateResult({ success: false, message: t('pages.update.inProgressTimeout'), reason: 'transaction_unresolved' });
        }
        return;
      }
      setInProgress({ transactionId: inProgress.transactionId, phase: tx.lastState });
      if (!tx.terminal) return;
      setInProgress(null);
      if (tx.lastState === 'confirmed') {
        setUpdateResult({ success: true, message: t('pages.update.inProgressConfirmed', { version: tx.productVersion ?? '' }), requiresRestart: true });
        toast.success(t('pages.update.fullUpdateSuccess'));
      } else {
        setUpdateResult({ success: false, message: t('pages.update.inProgressEnded', { state: tx.lastState ?? '' }) });
      }
      await loadData();
    };
    const timer = setInterval(tick, 3000);
    void tick();
    return () => { cancelled = true; clearInterval(timer); };
  }, [inProgress?.transactionId, t, loadData]);

  // ── Loading state ────────────────────────────────────────────────────────
  if (loadingState === "loading") {
    return (
      <PageShell width="table">
        <PageLoading
          cardCount={2}
          label={t("common.loading")}
          slowLabel={t("pages.update.slowHint")}
        />
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────────
  if (loadingState === "error") {
    return (
      <PageShell width="table">
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.update.eyebrow")}
        </div>
        <h1 className="text-display font-semibold tracking-tight text-ink mb-2">
          {t("pages.update.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.update.loadError")}</p>
          {errorMessage && (
            <p className="mt-2 text-ink-4 text-body font-mono">{errorMessage}</p>
          )}
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ─────────────────────────────────────────────────────────
  // PRI-848 (SPEC §12.1): explicit state contract. Servers predating the
  // contract fall back to the legacy hasUpdate/error derivation.
  const updateState: 'up_to_date' | 'update_available' | 'update_blocked' | 'check_failed' =
    statusData?.state ??
    (statusData ? (statusData.error ? 'check_failed' : statusData.hasUpdate ? 'update_available' : 'up_to_date') : 'up_to_date');
  const isUpToDate = updateState === 'up_to_date';

  // SPEC §12.1: reason codes localize; an unmapped code falls back to the raw
  // value instead of hiding it.
  const localizedReason = (reason?: string): string | undefined =>
    reason ? (t(`pages.update.reason.${reason}`, { defaultValue: reason }) as string) : undefined;
  const blockedReason = updateState === 'update_blocked' || updateState === 'check_failed'
    ? localizedReason(statusData?.reason)
    : undefined;

  // Display order/visibility (computed per render; the list is small).
  const sortedHistory = historyData ? sortHistoryDesc(historyData.updates) : [];
  const visibleHistory = showAllHistory ? sortedHistory : sortedHistory.slice(0, COLLAPSED_HISTORY_LIMIT);
  const hiddenHistoryCount = Math.max(0, sortedHistory.length - COLLAPSED_HISTORY_LIMIT);

  return (
    <PageShell width="table">
      <div>
      {/* PRI-848 (SPEC §12.1): recovery banner — an unfinished update
          transaction is shown with its phase and next step; the Owner attaches
          to it instead of silently starting a duplicate update. */}
      {recoveryData?.needsRecovery && recoveryData.unfinished.length > 0 && (
        <div className="mb-6 p-4 bg-amber/5 border border-amber/35 rounded-[6px] text-body leading-relaxed text-ink-2" role="alert">
          <p className="font-medium text-amber">{t("pages.update.recoveryBanner")}</p>
          {recoveryData.unfinished.slice(0, 3).map((item) => (
            <p key={item.transactionId} className="mt-1 font-mono text-[12px] text-ink-3">
              {t("pages.update.recoveryItem", {
                id: item.transactionId,
                phase: item.lastState ?? "—",
              })}
            </p>
          ))}
          {recoveryData.nextAction && (
            <p className="mt-2 text-[12px] text-ink-3">{recoveryData.nextAction}</p>
          )}
        </div>
      )}

      {/* PRI-1069/1070 (G1 P0-4): terminal-failed transactions that left the
          physical install inconsistent must be just as visible as unfinished
          ones — a banner only keyed on `unfinished` is how the PRI-1069
          half-restored runtime stayed invisible (review 2026-11-02). */}
      {recoveryData?.needsRecovery && recoveryData.recoveryRequired.length > 0 && (
        <div className="mb-6 p-4 bg-amber/5 border border-amber/35 rounded-[6px] text-body leading-relaxed text-ink-2" role="alert">
          <p className="font-medium text-amber">{t("pages.update.recoveryRequiredBanner")}</p>
          {recoveryData.recoveryRequired.slice(0, 3).map((item) => (
            <p key={item.transactionId} className="mt-1 font-mono text-[12px] text-ink-3">
              {t("pages.update.recoveryRequiredItem", { id: item.transactionId })}
            </p>
          ))}
          {recoveryData.nextAction && (
            <p className="mt-2 text-[12px] text-ink-3">{recoveryData.nextAction}</p>
          )}
        </div>
      )}

      {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
      <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
        {t("pages.update.eyebrow")}
      </div>
      <h1 className="text-display font-semibold tracking-tight text-ink mb-2">
        {t("pages.update.title")}
      </h1>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t("pages.update.subtitle")}
      </p>

      {/* 4K adaptation (DESIGN_BRIEF D20): the extra width becomes a second
          column (status | history) once the container clears the 1312px
          paired-reading threshold — never a longer text line. Below it the
          sections simply stack. */}
      <div className="update-reading-region">
        <div className="update-reading-columns">

      {/* Section 1: Update Status */}
      <section className="mb-8" aria-labelledby="section-update-status">
        <SectionTitle id="section-update-status">
          {t("pages.update.currentVersion")}
        </SectionTitle>

        <div className="bg-panel border border-line rounded-[6px] p-5">
          {/* Version info rows */}
          <div className="space-y-4">
            {/* Current version */}
            <div className="flex items-center justify-between">
              <span className="text-ink-3 text-body">{t("pages.update.currentVersion")}</span>
              <span className="font-mono text-body text-ink">
                {statusData?.currentVersion ?? "—"}
              </span>
            </div>

            {/* Latest version */}
            <div className="flex items-center justify-between">
              <span className="text-ink-3 text-body">{t("pages.update.latestVersion")}</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-body text-ink">
                  {updateState === 'check_failed' ? "—" : (statusData?.latestVersion || "—")}
                </span>
                {updateState === 'check_failed' && (
                  <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-eyebrow uppercase">
                    {t("pages.update.checkFailed")}
                  </span>
                )}
                {updateState === 'update_blocked' && (
                  <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-eyebrow uppercase">
                    {t("pages.update.blockedBadge")}
                  </span>
                )}
                {updateState === 'up_to_date' && (
                  <span className="inline-flex items-center border border-green/35 text-green rounded-[2px] px-[7px] py-1 font-mono text-eyebrow uppercase">
                    {t("pages.update.upToDate")}
                  </span>
                )}
                {updateState === 'update_available' && (
                  <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-eyebrow uppercase">
                    {t("pages.update.updateAvailable")}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* PRI-848: blocked/check-failed detail — localized reason code plus
              the exact next action. Never rendered as "up to date". */}
          {(updateState === 'update_blocked' || updateState === 'check_failed') && (
            <div className="mt-4 pt-3 border-t border-line text-[12px] leading-relaxed">
              {blockedReason && (
                <p className="text-ink-2">{t("pages.update.reasonLabel")}{blockedReason}</p>
              )}
              {statusData?.message && updateState === 'update_blocked' && (
                <p className="mt-1 text-ink-3">{statusData.message}</p>
              )}
              {statusData?.nextAction && (
                <p className="mt-1 text-ink-3 font-mono">{statusData.nextAction}</p>
              )}
            </div>
          )}

          {/* Error notice when registry check failed but version is still shown */}
          {statusData?.error && (
            <div className="mt-4 pt-3 border-t border-line text-[12px] text-ink-4 font-mono">
              {t("pages.update.checkError")}: {statusData.error}
            </div>
          )}

          {/* PRI-853: in-progress panel — the accepted detached transaction is
              the live state; phases stream from the transaction endpoint. */}
          {inProgress && (
            <div className="mt-4 p-4 rounded-[6px] border border-gov/30 bg-surface text-body leading-relaxed" role="status">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-gov" />
                <span className="font-medium text-ink">{t("pages.update.inProgressPanel")}</span>
              </div>
              <p className="mt-1 font-mono text-[12px] text-ink-3">
                {t("pages.update.inProgressPhase", { phase: inProgress.phase ?? "…" })}
              </p>
              <p className="mt-1 font-mono text-[12px] text-ink-4">{inProgress.transactionId}</p>
            </div>
          )}

          {/* Buttons — one check + one update */}
          <div className="mt-5 pt-4 border-t border-line flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={handleCheckForUpdates}
              disabled={checking || fullUpdating || inProgress !== null}
              className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-caption hover:border-line-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
            >
              {checking ? t("pages.update.checking") : t("pages.update.checkForUpdates")}
            </button>
            {!isUpToDate && updateState === 'update_available' && (
              <button
                type="button"
                onClick={() => setShowFullUpdateDialog(true)}
                disabled={checking || fullUpdating || inProgress !== null}
                className="bg-gov text-white rounded-[3px] px-[14px] py-[6px] text-caption hover:bg-gov/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              >
                {fullUpdating ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("pages.update.updating")}
                  </span>
                ) : (
                  t("pages.update.applyUpdate")
                )}
              </button>
            )}
          </div>

          {/* Update result message — enhanced card. PRI-848: a refusal is
              "blocked" (amber), not "failed" (red) — the system is untouched. */}
          {updateResult && (
            <div className={`mt-4 p-4 rounded-[6px] border ${updateResult.success ? 'bg-green/5 border-green/20' : updateResult.refusal ? 'bg-amber/5 border-amber/25' : 'bg-danger/5 border-danger/20'}`}>
              <div className="flex items-start gap-3">
                {/* Status icon with animation */}
                {updateResult.success ? (
                  <CheckCircle2 className="h-6 w-6 text-green shrink-0 mt-0.5" />
                ) : updateResult.refusal ? (
                  <AlertTriangle className="h-6 w-6 text-amber shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="h-6 w-6 text-danger shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  {/* Refusal label — the message is a blocked reason, not a crash */}
                  {updateResult.refusal && (
                    <p className="text-[12px] font-mono uppercase text-amber mb-1">{t("pages.update.blockedBadge")}</p>
                  )}
                  {/* Version comparison (success only) */}
                  {updateResult.success && updateResult.fromVersion && updateResult.newVersion && (
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="font-mono text-body text-ink-3 line-through">{updateResult.fromVersion}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-green" />
                      <span className="font-mono text-body text-green font-medium">{updateResult.newVersion}</span>
                    </div>
                  )}
                  {/* Message */}
                  <p className={`text-body ${updateResult.success ? 'text-green' : updateResult.refusal ? 'text-ink-2' : 'text-danger'}`}>
                    {updateResult.message}
                  </p>
                  {/* Full update restart prompt (requires console restart) */}
                  {updateResult.success && updateResult.requiresRestart && (
                    <p className="mt-2 p-2 rounded-[3px] bg-amber/5 border border-amber/20 text-[12px] text-amber leading-relaxed">
                      {t("pages.update.fullUpdateRestartPrompt")}
                    </p>
                  )}
                  {/* Gateway coordination degraded during the update (PRI-723) —
                      the OpenClaw side needs the Owner's hand, so surface it on
                      both success and failure instead of degrading silently. */}
                  {updateResult.gatewayNotice && (
                    <p className="mt-2 p-2 rounded-[3px] bg-amber/5 border border-amber/20 text-[12px] text-amber leading-relaxed font-mono">
                      {updateResult.gatewayNotice}
                    </p>
                  )}
                  {/* Structured next action for lock errors */}
                  {!updateResult.success && updateResult.nextAction && (
                    <p className="mt-1 text-[12px] text-ink-4 font-mono leading-relaxed">
                      {updateResult.nextAction}
                    </p>
                  )}
                  {/* Network error hint + retry (failure only) */}
                  {!updateResult.success && (
                    <div className="mt-2 flex items-center gap-2">
                      {/network|fetch|timeout|ECONNREFUSED|ENOTFOUND/i.test(updateResult.message) && (
                        <p className="text-[12px] text-ink-4 font-mono">{t("pages.update.networkErrorHint")}</p>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowFullUpdateDialog(true)}
                        disabled={fullUpdating}
                        className="text-[12px] text-danger underline hover:text-danger/80 disabled:opacity-50"
                      >
                        {t("pages.update.retry")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Section 2: Update History */}
      <section aria-labelledby="section-update-history">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle id="section-update-history">
            {t("pages.update.history")}
          </SectionTitle>
          {sortedHistory.length > 0 && (
            <button
              type="button"
              onClick={() => setShowCleanupDialog(true)}
              disabled={sortedHistory.length <= COLLAPSED_HISTORY_LIMIT || cleaningUp}
              className="border border-line bg-surface text-ink-2 rounded-[3px] px-[10px] py-[4px] text-caption hover:border-line-2 hover:text-ink transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 shrink-0"
            >
              {t("pages.update.cleanupHistory")}
            </button>
          )}
        </div>

        {historyErrorReason ? (
          <div className="text-ink-3 text-body leading-relaxed py-3">
            {t("pages.update.loadError")} ({historyErrorReason})
          </div>
        ) : historyData && historyData.updates.length > 0 ? (
          <div className="space-y-[10px]">
            {visibleHistory.map((entry) => (
              <article
                key={entry.id}
                className="bg-panel border border-line rounded-[6px] px-5 py-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center border border-line rounded-[2px] px-[7px] py-1 font-mono text-eyebrow text-ink-3 bg-surface/80 uppercase">
                      {t("pages.update.version")}
                    </span>
                    <span className="font-mono text-body text-ink">
                      {/* Failure entries persist toVersion as the literal
                          "failed" (routes/update.ts) — not a version; show a
                          dash and let the red badge carry the failure signal. */}
                      {entry.fromVersion} → {entry.toVersion === "failed" ? "—" : entry.toVersion}
                    </span>
                    {entry.kind !== "failure" && (
                      <span className="inline-flex items-center border border-line rounded-[2px] px-[7px] py-1 font-mono text-eyebrow text-ink-3 bg-surface/80 uppercase">
                        {t(`pages.update.historyKind.${entry.kind}`)}
                      </span>
                    )}
                    {!entry.success && entry.kind !== 'refusal' && (
                      <span className="inline-flex items-center border border-danger/35 text-danger rounded-[2px] px-[7px] py-1 font-mono text-eyebrow uppercase">
                        {t("pages.update.failed")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-ink-3 text-body">
                      {formatDate(entry.timestamp, i18n.language, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                </div>
                {(entry.reason || entry.nextAction) && (
                  <div className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-3">
                    {entry.reason && <p>{entry.reason}</p>}
                    {entry.nextAction && <p className="mt-1 text-ink-2">{entry.nextAction}</p>}
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="text-ink-3 text-body leading-relaxed py-3">
            {t("pages.update.noHistory")}
          </div>
        )}
        {sortedHistory.length > COLLAPSED_HISTORY_LIMIT && (
          <button
            type="button"
            onClick={() => setShowAllHistory((value) => !value)}
            aria-expanded={showAllHistory}
            data-testid="update-history-toggle"
            className="mt-3 text-caption text-gov underline hover:text-gov/80 focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {showAllHistory
              ? t("pages.update.collapseHistory")
              : t("pages.update.viewRemainingHistory", { count: hiddenHistoryCount })}
          </button>
        )}
      </section>
        </div>
      </div>
      </div>

      {/* Update confirmation dialog */}
      <AlertDialog open={showFullUpdateDialog} onOpenChange={setShowFullUpdateDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.update.confirmFullUpdateTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.update.confirmFullUpdateDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleApplyFullUpdate}>
              {t("pages.update.applyFullUpdate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* History cleanup confirmation — destructive (deletes all but the
          newest 5 entries), so it always asks before mutating. */}
      <AlertDialog open={showCleanupDialog} onOpenChange={setShowCleanupDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.update.confirmCleanupTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.update.confirmCleanupDesc", { count: hiddenHistoryCount, keep: COLLAPSED_HISTORY_LIMIT })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleCleanupHistory} disabled={cleaningUp}>
              {t("pages.update.cleanupHistory")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </PageShell>
  );
}
