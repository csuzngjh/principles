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
  applyUpdate,
  applyFullUpdate,
  rollbackUpdate,
} from "../../api.js";
import type {
  UpdateStatusData,
  UpdateHistoryData,
  ApplyUpdateResultData,
} from "../../api.js";
import { validateUpdateStatus, validateUpdateHistory } from "../../utils/validators.js";
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
import { Loader2, RotateCcw, CheckCircle2, XCircle, ArrowRight } from "lucide-react";
import { formatDate } from "../../utils/format-date.js";

// ── Main page component ──────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded" | "error";

export function UpdatePage() {
  const { t, i18n } = useTranslation();
  const [statusData, setStatusData] = useState<UpdateStatusData | null>(null);
  const [historyData, setHistoryData] = useState<UpdateHistoryData | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [checking, setChecking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [historyErrorReason, setHistoryErrorReason] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{
    success: boolean;
    message: string;
    newVersion?: string;
    updatedFiles?: string[];
    fromVersion?: string;
    partialUpdate?: boolean;
    requiresRestart?: boolean;
    reason?: string;
    nextAction?: string;
  } | null>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [showFullUpdateDialog, setShowFullUpdateDialog] = useState(false);
  const [fullUpdating, setFullUpdating] = useState(false);
  const [showRollbackDialog, setShowRollbackDialog] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackResult, setRollbackResult] = useState<{ success: boolean; message: string } | null>(null);

  const loadData = useCallback(async () => {
    setLoadingState("loading");
    setErrorMessage(null);
    setHistoryErrorReason(null);

    const [statusResult, historyResult] = await Promise.all([
      fetchUpdateStatus(),
      fetchUpdateHistory(),
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

  const handleApplyUpdate = useCallback(async () => {
    setShowUpdateDialog(false);
    setUpdating(true);
    setUpdateResult(null);
    const result = await applyUpdate();
    setUpdating(false);
    if (!result.success) {
      setUpdateResult({ success: false, message: result.error ?? 'Unknown error' });
      toast.error(t('pages.update.updateFailed', { message: result.error ?? 'Unknown error' }));
      return;
    }
    const data = result.data as ApplyUpdateResultData;
    if (data.success) {
      setUpdateResult({
        success: true,
        message: data.message,
        newVersion: data.newVersion,
        updatedFiles: data.updatedFiles,
        fromVersion: statusData?.currentVersion,
        partialUpdate: data.partialUpdate,
      });
      toast.success(t('pages.update.updateSuccess', { version: data.newVersion ?? 'latest' }));
      await loadData();
    } else {
      setUpdateResult({ success: false, message: data.message, reason: data.reason, nextAction: data.nextAction });
      toast.error(t('pages.update.updateFailed', { message: data.message }));
    }
  }, [t, loadData]);

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
    if (data.success) {
      setUpdateResult({
        success: true,
        message: data.message,
        newVersion: data.newVersion,
        fromVersion: statusData?.currentVersion,
        requiresRestart: data.requiresRestart,
        partialUpdate: data.partialUpdate,
      });
      toast.success(t('pages.update.fullUpdateSuccess'));
      await loadData();
    } else {
      setUpdateResult({ success: false, message: data.message, reason: data.reason, nextAction: data.nextAction });
      toast.error(t('pages.update.updateFailed', { message: data.message }));
    }
  }, [t, loadData, statusData?.currentVersion]);

  const handleRollback = useCallback(async (backupDir: string) => {
    setShowRollbackDialog(null);
    setRollingBack(true);
    setRollbackResult(null);
    const result = await rollbackUpdate(backupDir);
    setRollingBack(false);
    if (!result.success) {
      setRollbackResult({ success: false, message: result.error ?? 'Unknown error' });
      toast.error(t('pages.update.rollbackFailed', { message: result.error ?? 'Unknown error' }));
      return;
    }
    if (result.data.success) {
      setRollbackResult({ success: true, message: result.data.message });
      toast.success(t('pages.update.rollbackSuccess'));
      await loadData();
    } else {
      setRollbackResult({ success: false, message: result.data.message });
      toast.error(t('pages.update.rollbackFailed', { message: result.data.message }));
    }
  }, [t, loadData]);

  // ── Loading state ────────────────────────────────────────────────────────
  if (loadingState === "loading") {
    return (
      <PageShell>
        <PageLoading cardCount={2} label={t("common.loading")} />
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────────
  if (loadingState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.update.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.update.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.update.loadError")}</p>
          {errorMessage && (
            <p className="mt-2 text-ink-4 text-[13px] font-mono">{errorMessage}</p>
          )}
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ─────────────────────────────────────────────────────────
  const isUpToDate = statusData ? !statusData.hasUpdate : true;

  return (
    <PageShell>
      <div className="animate-[pdFadeIn_400ms_ease-out]">
      {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
      <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
        {t("pages.update.eyebrow")}
      </div>
      <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
        {t("pages.update.title")}
      </h1>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t("pages.update.subtitle")}
      </p>

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
              <span className="text-ink-3 text-[13px]">{t("pages.update.currentVersion")}</span>
              <span className="font-mono text-[13px] text-ink">
                {statusData?.currentVersion ?? "—"}
              </span>
            </div>

            {/* Latest version */}
            <div className="flex items-center justify-between">
              <span className="text-ink-3 text-[13px]">{t("pages.update.latestVersion")}</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[13px] text-ink">
                  {statusData?.latestVersion ?? "—"}
                </span>
                {isUpToDate ? (
                  <span className="inline-flex items-center border border-green/35 text-green rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
                    {t("pages.update.upToDate")}
                  </span>
                ) : (
                  <span className="inline-flex items-center border border-amber/35 text-amber rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
                    {t("pages.update.updateAvailable")}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Error notice when registry check failed but version is still shown */}
          {statusData?.error && (
            <div className="mt-4 pt-3 border-t border-line text-[12px] text-ink-4 font-mono">
              {t("pages.update.checkError")}: {statusData.error}
            </div>
          )}

          {/* Sync-pending notice: a newer plugin is published but the installer
              has not been republished to bundle it. Show it honestly instead of
              offering a version the full update cannot install. */}
          {statusData?.syncPending && (
            <div className="mt-4 p-3 rounded-[4px] border border-amber/30 bg-amber/5">
              <p className="text-[12px] text-amber leading-relaxed">
                {t("pages.update.syncPending", { pluginVersion: statusData.pluginLatestVersion ?? "" })}
              </p>
            </div>
          )}

          {/* Codex host warning — Web UI update only covers the OpenClaw plugin */}
          {statusData?.codexInstalled && (
            <div className="mt-4 p-3 rounded-[4px] border border-amber/30 bg-amber/5">
              <p className="text-[12px] text-amber leading-relaxed">
                {t("pages.update.codexWarning")}
              </p>
            </div>
          )}

          {/* What's new — changelog from GitHub Release */}
          {statusData?.changelog && statusData.hasUpdate && (
            <div className="mt-4 p-4 rounded-[4px] border border-line bg-surface/50">
              <p className="text-[12px] font-mono text-ink-3 uppercase tracking-wide mb-2">
                {t("pages.update.whatsNew")}
              </p>
              <div className="text-[13px] text-ink-2 leading-relaxed max-h-[300px] overflow-y-auto whitespace-pre-wrap">
                {statusData.changelog}
              </div>
            </div>
          )}

          {/* Buttons — one check + one update */}
          <div className="mt-5 pt-4 border-t border-line flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={handleCheckForUpdates}
              disabled={checking || fullUpdating}
              className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
            >
              {checking ? t("pages.update.checking") : t("pages.update.checkForUpdates")}
            </button>
            {!isUpToDate && (
              <button
                type="button"
                onClick={() => setShowFullUpdateDialog(true)}
                disabled={checking || fullUpdating}
                className="bg-gov text-white rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:bg-gov/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
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

          {/* Update result message — enhanced card */}
          {updateResult && (
            <div className={`mt-4 p-4 rounded-[6px] border animate-[pdFadeIn_400ms_ease-out] ${updateResult.success ? 'bg-green/5 border-green/20' : 'bg-red/5 border-red/20'}`}>
              <div className="flex items-start gap-3">
                {/* Status icon with animation */}
                {updateResult.success ? (
                  <CheckCircle2 className="h-6 w-6 text-green shrink-0 mt-0.5 animate-[pdFadeIn_600ms_ease-out]" style={{ transform: 'scale(1)', animationFillMode: 'both' }} />
                ) : (
                  <XCircle className="h-6 w-6 text-red shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  {/* Version comparison (success only) */}
                  {updateResult.success && updateResult.fromVersion && updateResult.newVersion && (
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="font-mono text-[13px] text-ink-3 line-through">{updateResult.fromVersion}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-green" />
                      <span className="font-mono text-[13px] text-green font-medium">{updateResult.newVersion}</span>
                    </div>
                  )}
                  {/* Message */}
                  <p className={`text-[13px] ${updateResult.success ? 'text-green' : 'text-red'}`}>
                    {updateResult.message}
                  </p>
                  {/* File count (success only) */}
                  {updateResult.success && updateResult.updatedFiles && updateResult.updatedFiles.length > 0 && (
                    <p className="mt-1 text-[12px] text-ink-4 font-mono">
                      {t("pages.update.filesUpdated", { count: updateResult.updatedFiles.length })}
                    </p>
                  )}
                  {/* Restart hint (success only) */}
                  {updateResult.success && !updateResult.requiresRestart && (
                    <p className="mt-2 text-[12px] font-mono text-ink-4">{t("pages.update.restartHint")}</p>
                  )}
                  {/* Full update restart prompt (requires console restart) */}
                  {updateResult.success && updateResult.requiresRestart && (
                    <p className="mt-2 p-2 rounded-[3px] bg-amber/5 border border-amber/20 text-[12px] text-amber leading-relaxed">
                      {t("pages.update.fullUpdateRestartPrompt")}
                    </p>
                  )}
                  {/* Partial update hint (success + Codex installed) */}
                  {updateResult.success && updateResult.partialUpdate && (
                    <p className="mt-1 text-[12px] text-amber leading-relaxed">
                      {t("pages.update.partialUpdateHint")}
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
                        onClick={handleApplyUpdate}
                        disabled={updating}
                        className="text-[12px] text-red underline hover:text-red/80 disabled:opacity-50"
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
        <SectionTitle id="section-update-history">
          {t("pages.update.history")}
        </SectionTitle>

        {historyErrorReason ? (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {t("pages.update.loadError")} ({historyErrorReason})
          </div>
        ) : historyData && historyData.updates.length > 0 ? (
          <div className="space-y-[10px]">
            {historyData.updates.map((entry) => (
              <article
                key={entry.id}
                className="bg-panel border border-line rounded-[6px] px-5 py-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center border border-line rounded-[2px] px-[7px] py-1 font-mono text-[11px] text-ink-3 bg-surface/80 uppercase">
                      {t("pages.update.version")}
                    </span>
                    <span className="font-mono text-[13px] text-ink">
                      {entry.fromVersion} → {entry.toVersion}
                    </span>
                    <span className="inline-flex items-center border border-line rounded-[2px] px-[7px] py-1 font-mono text-[11px] text-ink-3 bg-surface/80 uppercase">
                      {t(`pages.update.historyKind.${entry.kind}`)}
                    </span>
                    {!entry.success && entry.kind !== 'refusal' && (
                      <span className="inline-flex items-center border border-red/35 text-red rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
                        {t("pages.update.failed")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-ink-3 text-[13px]">
                      {formatDate(entry.timestamp, i18n.language, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {entry.backupPath && (
                      <button
                        type="button"
                        onClick={() => setShowRollbackDialog(entry.backupPath!)}
                        disabled={rollingBack || updating}
                        className="flex items-center gap-1 border border-line bg-surface text-ink-3 rounded-[3px] px-[8px] py-[4px] text-[11px] hover:text-ink hover:border-line-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title={t("pages.update.rollback")}
                      >
                        <RotateCcw className="h-3 w-3" />
                        {t("pages.update.rollback")}
                      </button>
                    )}
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
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {t("pages.update.noHistory")}
          </div>
        )}
      </section>
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

      {/* Rollback confirmation dialog */}
      <AlertDialog open={showRollbackDialog !== null} onOpenChange={(open) => { if (!open) setShowRollbackDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.update.confirmRollbackTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.update.confirmRollbackDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (showRollbackDialog) handleRollback(showRollbackDialog); }}>
              {t("pages.update.rollback")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rollback result message */}
      {rollbackResult && (
        <div className={`fixed bottom-4 right-4 max-w-md p-3 rounded-[4px] text-[13px] z-50 ${rollbackResult.success ? 'bg-green/10 border border-green/20 text-green' : 'bg-red/10 border border-red/20 text-red'}`}>
          <p>{rollbackResult.message}</p>
          {rollbackResult.success && (
            <p className="mt-1 text-[12px] font-mono opacity-80">{t("pages.update.restartHintAfterRollback")}</p>
          )}
        </div>
      )}
    </PageShell>
  );
}
