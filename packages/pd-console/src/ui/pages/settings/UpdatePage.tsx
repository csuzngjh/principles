/**
 * UpdatePage — PD self-update status and history.
 *
 * Contract aligned with backend routes/update.ts:
 * - GET /api/update/check → { hasUpdate, currentVersion, latestVersion, error? }
 * - GET /api/update/history → [{ id, timestamp, fromVersion, toVersion, success }, ...]
 *
 * Privacy boundary: version strings and timestamps only — no session/path data.
 */
import { useState, useEffect, useCallback, useRef } from "react";
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
  UpdateTransactionProgress,
} from "../../api.js";
import { validateUpdateStatus, validateUpdateHistory, validateUpdateHistoryPruneResult, validateUpdateRecovery, validateUpdateTransaction, isProcessId, type UpdateHandoverOwner } from "../../utils/validators.js";
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
import { TechnicalDetails, TechnicalRow } from "../../components/ui/technical-details.js";
import { Loader2, CheckCircle2, XCircle, ArrowRight, AlertTriangle, Check } from "lucide-react";
import { formatDate } from "../../utils/format-date.js";
import { reloadPage } from "../../utils/page-reload.js";
import {
  UPDATE_STAGES,
  describeUpdateProgress,
  formatBytes,
  formatElapsed,
  type TransferSample,
  type UpdateStage,
} from "./update-progress.js";

// ── Main page component ──────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded";

// PRI-853: how often the page asks for the detached update's transaction, and
// how long one such poll may wait for an answer before it is abandoned (the
// next tick simply asks again).
const TRANSACTION_POLL_INTERVAL_MS = 3_000;
const TRANSACTION_POLL_TIMEOUT_MS = 15_000;

// Consecutive polls that could not read the transaction before the page stops
// asking on its own. Ten minutes without one answer means the console is gone
// or the record was never written — it says nothing about how long a healthy
// update may take, which is why this counts failures and not elapsed time.
const TRANSACTION_UNREADABLE_POLL_CEILING = 200;

// After a confirmed update the console process has to become the new release
// before this page can show it. Who does that is the server's `handover`:
// the console itself (it starts a successor and exits), the Companion (it
// relaunches the console it owns), or nobody (a restart by hand). The page
// looks for the process that replaces the one it started on and reloads into
// it; if none comes within the owner's budget, the console still runs the
// previous release and the Owner is told to restart it.
const HANDOVER_POLL_INTERVAL_MS = 1_000;
const HANDOVER_POLL_TIMEOUT_MS = 8_000;
/** The console's own handover takes seconds; its wait for a successor that never answers is bounded well inside this. */
const HANDOVER_POLL_LIMIT = 30;
/** The Companion notices an update on its own 30-second beat, then relaunches the console. */
const COMPANION_HANDOVER_POLL_LIMIT = 90;
/** Nobody switches on their own: only a restart by hand can change the process, so look rarely, and not forever. */
const MANUAL_HANDOVER_POLL_INTERVAL_MS = 3_000;
const MANUAL_HANDOVER_POLL_LIMIT = 100;

// The elapsed clock ticks locally — the transaction itself is asked for at
// its own, slower cadence.
const ELAPSED_TICK_MS = 1_000;

const STAGE_LABEL_KEYS: Readonly<Record<UpdateStage, string>> = {
  download: "pages.update.stage.download",
  verify: "pages.update.stage.verify",
  deploy: "pages.update.stage.deploy",
  finalize: "pages.update.stage.finalize",
};
const STAGE_TITLE_KEYS: Readonly<Record<UpdateStage, string>> = {
  download: "pages.update.stageTitle.download",
  verify: "pages.update.stageTitle.verify",
  deploy: "pages.update.stageTitle.deploy",
  finalize: "pages.update.stageTitle.finalize",
};
const STAGE_HINT_KEYS: Readonly<Record<UpdateStage, string>> = {
  download: "pages.update.stageHint.download",
  verify: "pages.update.stageHint.verify",
  deploy: "pages.update.stageHint.deploy",
  finalize: "pages.update.stageHint.finalize",
};
const HANDOVER_TITLE_KEYS: Readonly<Record<Exclude<UpdateHandoverOwner, "manual">, string>> = {
  console: "pages.update.switchingTitle",
  companion: "pages.update.switchingCompanionTitle",
};
const HANDOVER_HINT_KEYS: Readonly<Record<Exclude<UpdateHandoverOwner, "manual">, string>> = {
  console: "pages.update.switchingHint",
  companion: "pages.update.switchingCompanionHint",
};

/** A running update as the page last read it. */
interface InProgressUpdate {
  readonly transactionId: string;
  readonly lastState: string | null;
  readonly startedAt: string | null;
  readonly lastAt: string | null;
  readonly progress: UpdateTransactionProgress | null;
  /** The console process answering; undefined until a poll reports one. */
  readonly serverPid: number | undefined;
  /** Who will switch that process to the new release; undefined until a poll says. */
  readonly handover: UpdateHandoverOwner | undefined;
  /** Consecutive polls that could not read the transaction. */
  readonly unreadablePolls: number;
  /** The previous download sample; a transfer rate is measured from it. */
  readonly transferFrom: TransferSample | null;
}

/**
 * A confirmed update, waiting for the console process to become the new
 * release. `owner` is `'manual'` when nobody will do it: the page has already
 * asked for a restart and only keeps looking, so a tab follows the Owner's
 * restart instead of staying on the old version.
 */
interface HandoverWait {
  readonly transactionId: string;
  readonly version: string;
  readonly predecessorPid: number | undefined;
  readonly owner: UpdateHandoverOwner;
  readonly pollMs: number;
  readonly limit: number;
}

// SPEC-PD-UIUX-002 §7: a wait that outlives a few seconds without explanation
// reads as "broken". The first-paint skeleton says so through PageLoading; the
// version check now runs beside a readable page, so it says so in place.
const CHECK_SLOW_AFTER_MS = 2_000;

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

/** True once `active` has stayed true for `afterMs`; false the moment it ends. */
function useLastedLongerThan(active: boolean, afterMs: number): boolean {
  const [lastedLong, setLastedLong] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setLastedLong(true), afterMs);
    return () => {
      clearTimeout(timer);
      setLastedLong(false);
    };
  }, [active, afterMs]);
  return active && lastedLong;
}

export function UpdatePage() {
  const { t, i18n } = useTranslation();
  const [statusData, setStatusData] = useState<UpdateStatusData | null>(null);
  const [historyData, setHistoryData] = useState<UpdateHistoryData | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  /** A version check is in flight — on mount, after a change, or by hand. */
  const [checking, setChecking] = useState(false);
  /** Why the last version check failed; shown until a check succeeds. */
  const [statusLoadError, setStatusLoadError] = useState<string | null>(null);
  const checkSlow = useLastedLongerThan(checking, CHECK_SLOW_AFTER_MS);
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
  const [inProgress, setInProgress] = useState<InProgressUpdate | null>(null);
  /** False once polling gave up on its own (nothing readable for too long); the Owner restarts it by hand. */
  const [polling, setPolling] = useState(false);
  /** A confirmed update, waiting for the console process to become the new release (see HandoverWait). */
  const [handoverWait, setHandoverWait] = useState<HandoverWait | null>(null);
  /** The page's clock while an update runs; the elapsed time must move even between polls. */
  const [nowMs, setNowMs] = useState(() => Date.now());
  /** The previous download sample: a rate needs two points in time. */
  const previousTransfer = useRef<TransferSample | null>(null);
  /**
   * The console process that accepted the update — the baseline the release
   * handover is measured from. It comes from the acceptance, not from the first
   * readable poll: by then the successor may already be the one answering.
   */
  const acceptedServerPid = useRef<number | undefined>(undefined);

  // History and recovery are read from local files. They gate only the first
  // paint of the page.
  const loadHistoryAndRecovery = useCallback(async () => {
    setHistoryErrorReason(null);
    const [historyResult, recoveryResult] = await Promise.all([
      fetchUpdateHistory(),
      fetchUpdateRecovery(),
    ]);

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
  }, []);

  // The version check refreshes signed release metadata over the network and
  // can spend the server's whole request budget. It never gates the page:
  // history, recovery and an already-known status stay on screen while it runs,
  // and the check button shows that a check is in progress. Resolves false
  // when the check failed — the caller decides how to say so.
  const refreshStatus = useCallback(async (): Promise<boolean> => {
    setChecking(true);
    const result = await fetchUpdateStatus();
    setChecking(false);
    const validated = result.success ? validateUpdateStatus(result.data) : null;
    if (validated === null) {
      // rc-9: the reason stays available until a check succeeds.
      setStatusLoadError(result.success ? "Update status data has unexpected shape" : result.error);
      return false;
    }
    setStatusLoadError(null);
    setStatusData(validated);
    return true;
  }, []);

  useEffect(() => {
    void loadHistoryAndRecovery().finally(() => setLoadingState("loaded"));
    void refreshStatus();
  }, [loadHistoryAndRecovery, refreshStatus]);

  const handleCheckForUpdates = useCallback(async () => {
    if (!(await refreshStatus())) toast.error(t("pages.update.checkFailed"));
  }, [refreshStatus, t]);

  // Re-read everything after the page's own actions. Unlike the first paint it
  // keeps what is already on screen: the update result the Owner is reading is
  // never replaced by a loading state while data refreshes.
  const loadData = useCallback(async (): Promise<boolean> => {
    const [, statusOk] = await Promise.all([loadHistoryAndRecovery(), refreshStatus()]);
    return statusOk;
  }, [loadHistoryAndRecovery, refreshStatus]);

  // Re-read everything after an update changed the installation. The status on
  // screen described the OLD installation, so it is dropped first: should the
  // re-check then fail, the page says it cannot load the status rather than go
  // on offering the update that was just applied.
  const reloadAfterUpdate = useCallback(async (): Promise<boolean> => {
    setStatusData(null);
    return loadData();
  }, [loadData]);

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
      setHandoverWait(null);
      previousTransfer.current = null;
      // A server that does not name itself leaves the baseline unknown.
      acceptedServerPid.current = isProcessId(data.serverPid) ? data.serverPid : undefined;
      setInProgress({
        transactionId: data.transactionId,
        lastState: null, startedAt: null, lastAt: null, progress: null,
        serverPid: undefined, handover: undefined, unreadablePolls: 0, transferFrom: null,
      });
      setPolling(true);
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
      if (!(await reloadAfterUpdate())) toast.error(t('pages.update.checkFailed'));
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
  }, [t, reloadAfterUpdate, statusData?.currentVersion]);

  // The update is on disk, but the console answering this page is still the
  // release it started as. Say so — and drop the status on screen, which
  // described that older installation.
  const showRestartRequired = useCallback(async (version: string): Promise<void> => {
    setUpdateResult({
      success: true,
      message: t('pages.update.inProgressConfirmed', { version }),
      requiresRestart: true,
    });
    if (!(await reloadAfterUpdate())) toast.error(t("pages.update.checkFailed"));
  }, [t, reloadAfterUpdate]);

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
    if (!(await loadData())) toast.error(t("pages.update.checkFailed"));
  }, [t, loadData]);

  // The page's clock: while an update runs the elapsed time moves every
  // second, which is what tells the Owner a quiet stage is still alive.
  const updateRunning = inProgress !== null;
  useEffect(() => {
    if (!updateRunning) return;
    const timer = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [updateRunning]);

  // PRI-853: poll the detached update's transaction until a terminal phase.
  // The loop is keyed to the transaction id alone: every poll replaces the
  // `inProgress` object, and restarting on each of those would reset its
  // bookkeeping — and poll again the instant an answer arrived.
  const trackedTransactionId = inProgress?.transactionId ?? null;
  useEffect(() => {
    if (trackedTransactionId === null || !polling) return;
    const transactionId = trackedTransactionId;
    let cancelled = false;
    let inFlight = false;
    let unreadablePolls = 0;
    /** The console process this update was accepted by — the one a handover replaces. */
    let predecessorPid: number | undefined = acceptedServerPid.current;
    const tick = async () => {
      // One poll at a time. A tick that finds its predecessor still waiting is
      // skipped, so a slow or stalled server can never stack requests behind
      // each other and starve everything else the page asks for.
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const result = await fetchUpdateTransaction(transactionId, TRANSACTION_POLL_TIMEOUT_MS);
        if (cancelled) return;
        const tx = result.success ? validateUpdateTransaction(result.data) : null;
        if (tx === null || !tx.exists) {
          // Unreadable. The usual cause is the console restarting (connection
          // refused for a moment); a long run of these is a console that is
          // gone. Neither is a verdict on the update, so the page keeps what
          // it last knew and only says that it lost contact.
          unreadablePolls += 1;
          if (unreadablePolls >= TRANSACTION_UNREADABLE_POLL_CEILING) {
            setPolling(false);
            return;
          }
          const lostContactPolls = unreadablePolls;
          setInProgress((current) => (current === null || current.transactionId !== transactionId
            ? current
            : { ...current, unreadablePolls: lostContactPolls }));
          return;
        }
        unreadablePolls = 0;
        predecessorPid ??= tx.serverPid;
        // A rate needs two samples in time: this poll against the previous one.
        const received = tx.progress?.bytesReceived;
        const previousSample = previousTransfer.current;
        const transferFrom = received !== undefined && previousSample !== null && previousSample.bytes !== received
          ? previousSample
          : null;
        previousTransfer.current = received === undefined ? null : { atMs: Date.now(), bytes: received };
        setInProgress({
          transactionId,
          lastState: tx.lastState,
          startedAt: tx.startedAt ?? null,
          lastAt: tx.lastAt ?? null,
          progress: tx.progress ?? null,
          serverPid: tx.serverPid,
          handover: tx.handover,
          unreadablePolls: 0,
          transferFrom,
        });
        if (!tx.terminal) return;
        setPolling(false);
        setInProgress(null);
        if (tx.lastState === 'confirmed') {
          toast.success(t('pages.update.fullUpdateSuccess'));
          const version = tx.productVersion ?? '';
          // A server that does not say (`handover` absent) is not waited for.
          const owner = tx.handover ?? 'manual';
          // The answering process is not the one that accepted: the handover
          // already happened while this page could not read the transaction.
          // This page is still the old version's — go to the new one now.
          if (owner !== 'manual' && tx.serverPid !== undefined && tx.serverPid !== predecessorPid) {
            reloadPage();
            return;
          }
          setHandoverWait(owner === 'manual'
            ? { transactionId, version, predecessorPid, owner, pollMs: MANUAL_HANDOVER_POLL_INTERVAL_MS, limit: MANUAL_HANDOVER_POLL_LIMIT }
            : {
                transactionId, version, predecessorPid, owner,
                pollMs: HANDOVER_POLL_INTERVAL_MS,
                limit: owner === 'companion' ? COMPANION_HANDOVER_POLL_LIMIT : HANDOVER_POLL_LIMIT,
              });
          if (owner === 'manual') await showRestartRequired(version);
          return;
        }
        setUpdateResult({ success: false, message: t('pages.update.inProgressEnded', { state: tx.lastState ?? '' }) });
        if (!(await reloadAfterUpdate())) toast.error(t("pages.update.checkFailed"));
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void tick(), TRANSACTION_POLL_INTERVAL_MS);
    void tick();
    return () => { cancelled = true; clearInterval(timer); };
  }, [trackedTransactionId, polling, t, reloadAfterUpdate, showRestartRequired]);

  // Release handover: the confirmed update replaces the console process under
  // this page with one on the new release. Reload the moment a different
  // process answers for the same transaction — that is the new version, on
  // the same URL. If none comes within the owner's budget (see HandoverWait),
  // the console still runs the previous version and restarting it is the
  // Owner's to do; the page says so instead of waiting forever.
  const handoverTarget = handoverWait;
  useEffect(() => {
    if (!handoverTarget) return;
    const { transactionId, version, predecessorPid, owner, pollMs, limit } = handoverTarget;
    let cancelled = false;
    let inFlight = false;
    let polls = 0;
    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        polls += 1;
        if (polls > limit) {
          cancelled = true;
          clearInterval(timer);
          setHandoverWait(null);
          // When nobody was going to switch, the restart was asked for up front — nothing new to say.
          if (owner !== 'manual') await showRestartRequired(version);
          return;
        }
        // A failed request is expected here: the predecessor has stopped
        // accepting and the successor is still booting. Just look again.
        const result = await fetchUpdateTransaction(transactionId, HANDOVER_POLL_TIMEOUT_MS);
        if (cancelled) return;
        const tx = result.success ? validateUpdateTransaction(result.data) : null;
        if (tx !== null && tx.exists && tx.serverPid !== undefined && tx.serverPid !== predecessorPid) {
          cancelled = true;
          reloadPage();
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void tick(), pollMs);
    void tick();
    return () => { cancelled = true; clearInterval(timer); };
  }, [handoverTarget, showRestartRequired]);

  // ── Loading state ────────────────────────────────────────────────────────
  // First paint only: history and recovery are local reads. The version check
  // runs beside it and reports inside the status card (ERR-002: a check that
  // fails degrades with its reason, it never blanks the page).
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

  // What the in-flight panel says. Everything the Owner reads here comes from
  // the journal state, the installer's progress observation and the clock —
  // never from the raw state names.
  const running = inProgress;
  const progressView = running
    ? describeUpdateProgress({
        lastState: running.lastState,
        startedAt: running.startedAt,
        lastAt: running.lastAt,
        progress: running.progress,
        nowMs,
        transferFrom: running.transferFrom,
      })
    : null;
  const progressDetail: string | null = (() => {
    if (progressView === null || progressView.stage === null) return null;
    // Contact lost on the last poll: that is the news, ahead of any figure.
    if (running !== null && running.unreadablePolls > 0) return t("pages.update.reconnecting");
    const { bytes } = progressView;
    if (bytes === null) return t(STAGE_HINT_KEYS[progressView.stage]);
    const parts = [t("pages.update.downloadReceived", {
      received: formatBytes(bytes.received),
      total: formatBytes(bytes.total),
    })];
    if (bytes.perSecond !== null) parts.push(t("pages.update.downloadRate", { rate: formatBytes(bytes.perSecond) }));
    if (bytes.remainingMs !== null) parts.push(t("pages.update.downloadRemaining", { time: formatElapsed(bytes.remainingMs) }));
    return parts.join(" · ");
  })();
  // The handover panel is shown only while someone is really switching the
  // console; a restart by hand is already on screen as the result card.
  const handoverPanel = handoverWait !== null && handoverWait.owner !== 'manual'
    ? { ...handoverWait, owner: handoverWait.owner }
    : null;
  // "This page switches on its own" is a promise only the server's `handover` can keep.
  const backgroundNote = running?.handover === 'manual'
    ? t("pages.update.backgroundNoteRestart")
    : t("pages.update.backgroundNote");

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
                {/* No badge while the first check is still running: "no answer
                    yet" is not "up to date". */}
                {statusData !== null && updateState === 'up_to_date' && (
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

          {/* No version status at all yet and the check failed: say so where the
              status would be, with its reason. History and recovery below stay
              readable, and the check button retries. */}
          {statusData === null && statusLoadError !== null && (
            <div className="mt-4 pt-3 border-t border-line">
              <p className="text-ink-2 text-sm">{t("pages.update.loadError")}</p>
              <p className="mt-1 text-ink-4 text-body font-mono">{statusLoadError}</p>
            </div>
          )}

          {/* The check is taking a while: say what is being checked, where the
              Owner is looking for its answer. */}
          {checkSlow && (
            <p className="mt-4 text-body leading-relaxed text-ink-3" data-testid="update-check-slow">
              {t("pages.update.slowHint")}
            </p>
          )}

          {/* Update in flight: what is happening, how long it has taken, and
              that nobody has to sit here for it. The journal's own state names
              and the installer's step stay with the other technical facts,
              collapsed — they never set the tone of the reading path. */}
          {handoverPanel && (
            <div className="mt-4 p-4 rounded-[6px] border border-gov/30 bg-surface text-body leading-relaxed" role="status" data-testid="update-switching" data-handover={handoverPanel.owner}>
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-gov" />
                <span className="font-medium text-ink">{t(HANDOVER_TITLE_KEYS[handoverPanel.owner])}</span>
              </div>
              <p className="mt-2 text-[12px] text-ink-3">{t(HANDOVER_HINT_KEYS[handoverPanel.owner])}</p>
            </div>
          )}

          {inProgress && !handoverPanel && (
            <div className="mt-4 p-4 rounded-[6px] border border-gov/30 bg-surface text-body leading-relaxed" data-testid="update-progress-panel">
              {!polling ? (
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 mt-[3px] shrink-0 text-amber" />
                    <p className="text-ink-2" aria-live="polite" data-testid="update-progress-unavailable">{t("pages.update.inProgressTimeout")}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPolling(true)}
                    className="shrink-0 text-[12px] text-gov underline hover:text-gov/80 focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                  >
                    {t("pages.update.retryProgress")}
                  </button>
                </div>
              ) : progressView === null || progressView.stage === null ? (
                <>
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-gov" />
                    <span className="font-medium text-ink">{t("pages.update.inProgressPanel")}</span>
                  </div>
                  <p className="mt-2 text-[12px] text-ink-3" aria-live="polite">{t("pages.update.progressPending")}</p>
                  <p className="mt-3 text-[12px] text-ink-4">{backgroundNote}</p>
                </>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2" aria-live="polite">
                      <Loader2 className="h-4 w-4 animate-spin text-gov" />
                      <span className="font-medium text-ink" data-testid="update-progress-stage">{t(STAGE_TITLE_KEYS[progressView.stage])}</span>
                    </div>
                    <span className="font-mono text-[12px] text-ink-4 tabular-nums whitespace-nowrap" data-testid="update-progress-elapsed">
                      {t("pages.update.elapsed", { time: formatElapsed(progressView.elapsedMs) })}
                    </span>
                  </div>

                  <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" data-testid="update-progress-stages">
                    {UPDATE_STAGES.map((stage, index) => {
                      const position = index < progressView.stageIndex ? 'done' : index === progressView.stageIndex ? 'current' : 'todo';
                      return (
                        <li key={stage} className="flex items-center gap-2" data-stage={stage} data-position={position}>
                          <span className={`inline-flex h-4 w-4 items-center justify-center ${position === 'done' ? 'text-green' : position === 'current' ? 'text-gov' : 'text-ink-4/60'}`}>
                            {position === 'done'
                              ? <Check className="h-3.5 w-3.5" />
                              : position === 'current'
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                          </span>
                          <span className={position === 'current' ? 'font-medium text-ink' : position === 'done' ? 'text-ink-3' : 'text-ink-4'}>
                            {t(STAGE_LABEL_KEYS[stage])}
                          </span>
                          {index < UPDATE_STAGES.length - 1 && <span aria-hidden="true" className="h-px w-4 bg-line" />}
                        </li>
                      );
                    })}
                  </ol>

                  {progressView.percent !== null ? (
                    <div className="mt-3 flex items-center gap-3">
                      <div
                        className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progressView.percent}
                        aria-label={t(STAGE_TITLE_KEYS[progressView.stage])}
                      >
                        <div className="h-full rounded-full bg-gov transition-[width] duration-500" style={{ width: `${progressView.percent}%` }} />
                      </div>
                      <span className="font-mono text-[12px] text-ink-3 tabular-nums" data-testid="update-progress-percent">{progressView.percent}%</span>
                    </div>
                  ) : (
                    <div className="mt-3 h-1.5 bg-muted rounded-full overflow-hidden" aria-hidden="true">
                      <div className="h-full w-1/3 rounded-full bg-gov/60 animate-pulse" />
                    </div>
                  )}

                  {progressDetail !== null && (
                    <p className="mt-2 text-[12px] text-ink-3 tabular-nums" data-testid="update-progress-detail">{progressDetail}</p>
                  )}

                  <p className="mt-3 text-[12px] text-ink-4">{backgroundNote}</p>

                  <TechnicalDetails>
                    <TechnicalRow label={t("pages.update.stepLabel")} value={progressView.step ?? "—"} />
                    <TechnicalRow label="transaction" value={inProgress.transactionId} />
                  </TechnicalDetails>
                </>
              )}
            </div>
          )}

          {/* Buttons — one check + one update */}
          <div className="mt-5 pt-4 border-t border-line flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={handleCheckForUpdates}
              disabled={checking || fullUpdating || inProgress !== null || handoverPanel !== null}
              className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-caption hover:border-line-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
            >
              {checking ? t("pages.update.checking") : t("pages.update.checkForUpdates")}
            </button>
            {!isUpToDate && updateState === 'update_available' && (
              <button
                type="button"
                onClick={() => setShowFullUpdateDialog(true)}
                disabled={checking || fullUpdating || inProgress !== null || handoverPanel !== null}
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
