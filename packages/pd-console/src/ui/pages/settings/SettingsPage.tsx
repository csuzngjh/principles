import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useNotifications } from "../../components/notifications/useNotifications.js";
import { cn } from "../../../lib/utils.js";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import {
  getToken,
  setToken,
  fetchWorkspaces,
  addWorkspace,
  removeWorkspace,
  syncWorkspace,
  fetchOutputLanguage,
  updateOutputLanguage,
} from "../../api.js";
import type { WorkspaceEntry } from "../../api.js";

// ── Runtime validators (H section / ERR-001/005/009/013) ─────────────────────

/** Type guard: is this a non-null object with own properties (not inherited)? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateWorkspaceEntry(raw: unknown): WorkspaceEntry | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "name") ||
    !Object.hasOwn(raw, "path") ||
    !Object.hasOwn(raw, "lastSync")
  ) {
    return null;
  }
  const name = raw.name;
  const path = raw.path;
  const lastSync = raw.lastSync;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    typeof path !== "string" ||
    path.length === 0
  ) {
    return null;
  }
  if (lastSync !== null && typeof lastSync !== "string") {
    return null;
  }
  // Validate optional config field
  let config: WorkspaceEntry["config"] = null;
  if (Object.hasOwn(raw, "config") && raw.config !== null) {
    if (!isRecord(raw.config)) return null;
    const cfg = raw.config;
    if (
      !Object.hasOwn(cfg, "workspaceName") ||
      !Object.hasOwn(cfg, "enabled") ||
      !Object.hasOwn(cfg, "syncEnabled")
    ) {
      return null;
    }
    if (
      typeof cfg.workspaceName !== "string" ||
      typeof cfg.enabled !== "boolean" ||
      typeof cfg.syncEnabled !== "boolean"
    ) {
      return null;
    }
    const displayName =
      Object.hasOwn(cfg, "displayName") && typeof cfg.displayName === "string"
        ? cfg.displayName
        : null;
    config = {
      workspaceName: cfg.workspaceName,
      enabled: cfg.enabled,
      displayName,
      syncEnabled: cfg.syncEnabled,
    };
  }
  return { name, path, lastSync, config };
}

export function validateWorkspaceArray(raw: unknown): WorkspaceEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: WorkspaceEntry[] = [];
  for (const item of raw) {
    const validated = validateWorkspaceEntry(item);
    if (validated === null) return null; // ERR-009: fail loud on invalid element
    entries.push(validated);
  }
  return entries;
}

// ── Inline confirm state ─────────────────────────────────────────────────────

interface ConfirmState {
  workspaceName: string;
}

// ── Main page component ──────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded" | "error";

export function SettingsPage() {
  const { t } = useTranslation();
  const { soundEnabled, setSoundEnabled } = useNotifications();
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Auth token state
  const [tokenInput, setTokenInput] = useState("");

  // Workspace state
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [addName, setAddName] = useState("");
  const [addPath, setAddPath] = useState("");

  // PRI-332: Principle output language state
  const [outputLanguage, setOutputLanguage] = useState<"zh-CN" | "en">("zh-CN");

  // Inline confirm for remove (J.1 pattern)
  const [confirmRemove, setConfirmRemove] = useState<ConfirmState | null>(null);

  // ── Load data on mount ──────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoadingState("loading");
    setErrorMessage(null);

    // Load current token
    const storedToken = getToken();
    setTokenInput(storedToken ?? "");

    // Load workspaces
    const result = await fetchWorkspaces();
    if (!result.success) {
      setLoadingState("error");
      setErrorMessage(result.error ?? "Unknown error");
      return;
    }

    const validated = validateWorkspaceArray(result.data);
    if (validated === null) {
      setLoadingState("error");
      setErrorMessage("Workspace data has unexpected shape");
      return;
    }

    setWorkspaces(validated);

    // PRI-332: Load output language preference
    const langResult = await fetchOutputLanguage();
    if (langResult.success && langResult.data) {
      const lang = langResult.data.outputLanguage;
      if (lang === "zh-CN" || lang === "en") {
        setOutputLanguage(lang);
      }
    }
    // Non-fatal: if language load fails, keep default zh-CN

    setLoadingState("loaded");
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Auth token handlers ────────────────────────────────────────────────

  const handleSaveToken = useCallback(() => {
    const trimmed = tokenInput.trim();
    if (trimmed.length === 0) return;
    setToken(trimmed);
    toast.success(t("pages.settings.tokenSaved"));
  }, [tokenInput, t]);

  // ── Workspace handlers ─────────────────────────────────────────────────

  const handleAddWorkspace = useCallback(async () => {
    const name = addName.trim();
    const path = addPath.trim();
    if (name.length === 0 || path.length === 0) return;

    const result = await addWorkspace(name, path);
    if (!result.success) {
      toast.error(result.error ?? "Failed to add workspace");
      return;
    }

    // Validate the returned entry before adding to state
    const validated = validateWorkspaceEntry(result.data);
    if (validated === null) {
      // ERR-002: degrade with reason — still reload from server
      toast.success(t("pages.settings.workspaceAdded"));
      await loadData();
      return;
    }

    setWorkspaces((prev) => [...prev, validated]);
    setAddName("");
    setAddPath("");
    toast.success(t("pages.settings.workspaceAdded"));
  }, [addName, addPath, t, loadData]);

  const handleRemoveWorkspace = useCallback(
    async (name: string) => {
      const result = await removeWorkspace(name);
      if (!result.success) {
        toast.error(result.error ?? "Failed to remove workspace");
        setConfirmRemove(null);
        return;
      }

      setWorkspaces((prev) => prev.filter((w) => w.name !== name));
      setConfirmRemove(null);
      toast.success(t("pages.settings.workspaceRemoved"));
    },
    [t],
  );

  const handleSyncWorkspace = useCallback(
    async (name: string) => {
      const result = await syncWorkspace(name);
      if (!result.success) {
        toast.error(result.error ?? "Failed to sync workspace");
        return;
      }

      // Reload to get fresh lastSync timestamps
      await loadData();
      toast.success(t("pages.settings.syncWorkspace"));
    },
    [loadData, t],
  );

  // ── PRI-332: Output language handler ────────────────────────────────

  const handleOutputLanguageChange = useCallback(
    async (newLang: string) => {
      if (newLang !== 'zh-CN' && newLang !== 'en') return;
      const result = await updateOutputLanguage(newLang);
      if (!result.success) {
        toast.error(result.error ?? t("pages.settings.languageLoadError"));
        return;
      }
      // Re-read to confirm persisted state
      if (result.data && (result.data.outputLanguage === "zh-CN" || result.data.outputLanguage === "en")) {
        setOutputLanguage(result.data.outputLanguage);
      }
      toast.success(t("pages.settings.languageSaved"));
    },
    [t],
  );

  // ── Loading state ────────────────────────────────────────────────────────

  if (loadingState === "loading") {
    return (
      <PageShell>
        <PageLoading cardCount={3} label={t("common.loading")} />
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────────

  if (loadingState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.settings.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.settings.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.settings.loadError")}</p>
          {errorMessage && (
            <p className="mt-2 text-ink-4 text-[13px] font-mono">
              {errorMessage}
            </p>
          )}
        </div>
      </PageShell>
    );
  }

  // ── Loaded state ─────────────────────────────────────────────────────────

  return (
    <PageShell>
      <div className="animate-[pdFadeIn_400ms_ease-out]">
      {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
      <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
        {t("pages.settings.eyebrow")}
      </div>
      <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
        {t("pages.settings.title")}
      </h1>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t("pages.settings.subtitle")}
      </p>

      {/* Section 1: Authentication */}
      <section className="mb-8" aria-labelledby="section-auth">
        <SectionTitle id="section-auth">
          {t("pages.settings.auth")}
        </SectionTitle>

        <div className="bg-panel border border-line rounded-[6px] p-5">
          <label
            htmlFor="bearer-token-input"
            className="block text-sm font-medium text-ink mb-2"
          >
            {t("pages.settings.bearerToken")}
          </label>
          <input
            id="bearer-token-input"
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={t("pages.settings.enterAccessToken")}
            className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov"
          />
          <div className="flex items-center justify-between mt-3">
            <button
              onClick={handleSaveToken}
              disabled={tokenInput.trim().length === 0}
              className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
            >
              {t("common.save")}
            </button>
            <span className="text-ink-4 text-[12px]">
              {t("pages.settings.tokenSessionOnly")}
            </span>
          </div>
        </div>
      </section>

      {/* Section 2: PRI-332 Principle Language */}
      <section className="mb-8" aria-labelledby="section-principle-language">
        <SectionTitle id="section-principle-language">
          {t("pages.settings.principleLanguage")}
        </SectionTitle>

        <div className="bg-panel border border-line rounded-[6px] p-5">
          <p className="text-ink-3 text-[13px] leading-relaxed mb-3">
            {t("pages.settings.principleLanguageDescription")}
          </p>
          <div className="flex items-center gap-3">
            <label htmlFor="output-language-select" className="text-sm font-medium text-ink">
              {t("pages.settings.principleLanguage")}:
            </label>
            <select
              id="output-language-select"
              value={outputLanguage}
              onChange={(e) => handleOutputLanguageChange(e.target.value)}
              className="border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov"
            >
              <option value="zh-CN">{t("pages.settings.languageZhCN")}</option>
              <option value="en">{t("pages.settings.languageEn")}</option>
            </select>
          </div>
        </div>
      </section>

      {/* Section: Sound alerts */}
      <section className="mb-8" aria-labelledby="section-sound-alerts">
        <SectionTitle id="section-sound-alerts">
          {t("pages.settings.notifications")}
        </SectionTitle>

        <div className="bg-panel border border-line rounded-[6px] p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <label
                htmlFor="sound-alerts-toggle"
                className="block text-sm font-medium text-ink"
              >
                {t("pages.settings.soundAlerts")}
              </label>
              <p className="text-ink-3 text-[13px] leading-relaxed mt-1">
                {t("pages.settings.soundAlertsDescription")}
              </p>
            </div>
            <button
              id="sound-alerts-toggle"
              type="button"
              role="switch"
              aria-checked={soundEnabled}
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={cn(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2",
                soundEnabled ? "bg-gov" : "bg-line"
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 transform rounded-full bg-paper transition-transform",
                  soundEnabled ? "translate-x-6" : "translate-x-1"
                )}
              />
            </button>
          </div>
        </div>
      </section>

      {/* Section 3: Workspaces */}
      <section aria-labelledby="section-workspaces">
        <SectionTitle id="section-workspaces">
          {t("pages.settings.workspace")}
        </SectionTitle>

        {/* Workspace list */}
        {workspaces.length > 0 ? (
          <div className="space-y-[10px] mb-5">
            {workspaces.map((ws) => (
              <article
                key={ws.name}
                className="bg-panel border border-line rounded-[6px] p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-ink text-sm">
                      {ws.name}
                    </div>
                    <div className="text-ink-3 text-[13px] mt-1 font-mono break-all">
                      {ws.path}
                    </div>
                    <div className="text-ink-4 text-[12px] mt-1">
                      {t("pages.settings.lastSync")}:{" "}
                      {ws.lastSync ?? "—"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Inline confirm for remove (J.1 pattern) */}
                    {confirmRemove?.workspaceName === ws.name ? (
                      <>
                        <span className="text-ink-2 text-[12px]">
                          {t("pages.settings.confirmDeleteDescription", {
                            name: ws.name,
                          })}
                        </span>
                        <button
                          onClick={() => handleRemoveWorkspace(ws.name)}
                          className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                        >
                          {t("common.confirm")}
                        </button>
                        <button
                          onClick={() => setConfirmRemove(null)}
                          className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                        >
                          {t("common.cancel")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => handleSyncWorkspace(ws.name)}
                          className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                        >
                          {t("pages.settings.syncWorkspace")}
                        </button>
                        <button
                          onClick={() =>
                            setConfirmRemove({ workspaceName: ws.name })
                          }
                          className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                        >
                          {t("pages.settings.removeWorkspace")}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="text-ink-3 text-[13px] leading-relaxed py-3 mb-5">
            —
          </div>
        )}

        {/* Add workspace form */}
        <div className="bg-panel border border-line rounded-[6px] p-5">
          <div className="flex items-end gap-3">
            <div className="flex-1 min-w-0">
              <label
                htmlFor="add-workspace-name"
                className="block text-sm font-medium text-ink mb-2"
              >
                {t("pages.settings.name")}
              </label>
              <input
                id="add-workspace-name"
                type="text"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder={t("pages.settings.addNamePlaceholder")}
                className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov"
              />
            </div>
            <div className="flex-1 min-w-0">
              <label
                htmlFor="add-workspace-path"
                className="block text-sm font-medium text-ink mb-2"
              >
                {t("pages.settings.path")}
              </label>
              <input
                id="add-workspace-path"
                type="text"
                value={addPath}
                onChange={(e) => setAddPath(e.target.value)}
                placeholder={t("pages.settings.addPathPlaceholder")}
                className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov"
              />
            </div>
            <button
              onClick={handleAddWorkspace}
              disabled={addName.trim().length === 0 || addPath.trim().length === 0}
              className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0 focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
            >
              {t("pages.settings.addWorkspace")}
            </button>
          </div>
        </div>
      </section>
      </div>
    </PageShell>
  );
}
