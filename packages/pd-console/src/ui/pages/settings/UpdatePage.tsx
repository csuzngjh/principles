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
import { SectionTitle } from "../../components/layout/section-title.js";
import {
  fetchUpdateStatus,
  fetchUpdateHistory,
} from "../../api.js";
import type {
  UpdateStatusData,
  UpdateHistoryEntry,
  UpdateHistoryData,
} from "../../api.js";

// ── Runtime validators (H section / ERR-001/005/009/013) ─────────────────────

/** Type guard: is this a non-null object with own properties (not inherited)? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateUpdateStatusData(raw: unknown): UpdateStatusData | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "currentVersion") ||
    !Object.hasOwn(raw, "latestVersion") ||
    !Object.hasOwn(raw, "hasUpdate")
  ) {
    return null;
  }
  const currentVersion = raw.currentVersion;
  const latestVersion = raw.latestVersion;
  const hasUpdate = raw.hasUpdate;
  if (
    typeof currentVersion !== "string" ||
    typeof latestVersion !== "string" ||
    typeof hasUpdate !== "boolean"
  ) {
    return null;
  }
  const result: UpdateStatusData = { currentVersion, latestVersion, hasUpdate };
  if (Object.hasOwn(raw, "error") && typeof raw.error === "string") {
    result.error = raw.error;
  }
  return result;
}

export function validateUpdateHistoryEntry(raw: unknown): UpdateHistoryEntry | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "id") ||
    !Object.hasOwn(raw, "timestamp") ||
    !Object.hasOwn(raw, "fromVersion") ||
    !Object.hasOwn(raw, "toVersion") ||
    !Object.hasOwn(raw, "success")
  ) {
    return null;
  }
  const { id, timestamp, fromVersion, toVersion, success } = raw;
  if (
    typeof id !== "string" ||
    typeof timestamp !== "string" ||
    typeof fromVersion !== "string" ||
    typeof toVersion !== "string" ||
    typeof success !== "boolean"
  ) {
    return null;
  }
  return { id, timestamp, fromVersion, toVersion, success };
}

export function validateUpdateHistoryData(raw: unknown): UpdateHistoryData | null {
  // Backend returns a bare array; accept both shapes.
  if (Array.isArray(raw)) {
    const validatedEntries: UpdateHistoryEntry[] = [];
    for (const entry of raw) {
      const validated = validateUpdateHistoryEntry(entry);
      if (validated === null) return null;
      validatedEntries.push(validated);
    }
    return { updates: validatedEntries };
  }
  if (!isRecord(raw) || !Object.hasOwn(raw, "updates") || !Array.isArray(raw.updates)) {
    return null;
  }
  const validatedEntries: UpdateHistoryEntry[] = [];
  for (const entry of raw.updates) {
    const validated = validateUpdateHistoryEntry(entry);
    if (validated === null) return null;
    validatedEntries.push(validated);
  }
  return { updates: validatedEntries };
}

// ── Helper: format ISO date string to locale-aware display ────────────────────

function formatDate(isoString: string, locale: string): string {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    return date.toLocaleDateString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

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

  const locale = i18n.language === "zh-CN" ? "zh-CN" : "en-US";

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
    const validatedStatus = validateUpdateStatusData(statusResult.data);
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
      const validatedHistory = validateUpdateHistoryData(historyResult.data);
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
    const validated = validateUpdateStatusData(result.data);
    if (validated === null) {
      toast.error(t("pages.update.checkFailed"));
      setChecking(false);
      return;
    }
    setStatusData(validated);
    setChecking(false);
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

          {/* Check button — secondary style (tool page, lower visual weight) */}
          <div className="mt-5 pt-4 border-t border-line">
            <button
              type="button"
              onClick={handleCheckForUpdates}
              disabled={checking}
              className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
            >
              {checking ? t("pages.update.checking") : t("pages.update.checkForUpdates")}
            </button>
          </div>
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
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center border border-line rounded-[2px] px-[7px] py-1 font-mono text-[11px] text-ink-3 bg-surface/80 uppercase">
                      {t("pages.update.version")}
                    </span>
                    <span className="font-mono text-[13px] text-ink">
                      {entry.fromVersion} → {entry.toVersion}
                    </span>
                    {!entry.success && (
                      <span className="inline-flex items-center border border-red/35 text-red rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase">
                        {t("pages.update.failed")}
                      </span>
                    )}
                  </div>
                  <span className="text-ink-3 text-[13px]">
                    {formatDate(entry.timestamp, locale)}
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3">
            {t("pages.update.noHistory")}
          </div>
        )}
      </section>
    </PageShell>
  );
}
