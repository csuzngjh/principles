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
  fetchConfigSummary,
  patchFeatureFlag,
  fetchOwnerIdentity,
  registerOwnerIdentity,
  unregisterOwnerIdentity,
} from "../../api.js";
import type { WorkspaceEntry, OwnerIdentityViewData } from "../../api.js";
import { resetOnboardingState } from "../../utils/onboarding-state.js";

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

  // ADR-0022 (PRI-578): Owner identity registration state
  const [ownerIdentity, setOwnerIdentity] = useState<OwnerIdentityViewData | null>(null);
  const [ownerIdInput, setOwnerIdInput] = useState("");
  const [credentialIdInput, setCredentialIdInput] = useState("");
  const [ownerActionPending, setOwnerActionPending] = useState(false);

  // Workspace state
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [addName, setAddName] = useState("");
  const [addPath, setAddPath] = useState("");

  // PRI-332: Principle output language state
  const [outputLanguage, setOutputLanguage] = useState<"zh-CN" | "en">("zh-CN");

  // spec 2026-06-30 §12.5: new_user_onboarding feature flag toggle state.
  // null = loading/unknown (button disabled); true/false = persisted state.
  const [onboardingFlagEnabled, setOnboardingFlagEnabled] = useState<boolean | null>(null);

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

    // ADR-0022 (PRI-578): Load owner identity status
    const ownerResult = await fetchOwnerIdentity();
    if (ownerResult.success && ownerResult.data) {
      setOwnerIdentity(ownerResult.data);
    }
    // Non-fatal: failures keep the section collapsed to its loading state

    setLoadingState("loaded");
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // spec 2026-06-30 §12.5: load new_user_onboarding flag state from config summary.
  // Non-blocking — failures keep the toggle disabled (null) and surface a toast
  // (rc-9: no silent fallback). The flag list comes from GET /api/v1/config/summary
  // because there is no dedicated GET /features list endpoint.
  const loadOnboardingFlag = useCallback(async () => {
    setOnboardingFlagEnabled(null);
    const result = await fetchConfigSummary();
    if (!result.success || !result.data) {
      toast.error(t("components.onboardingFlag.loadFailed"));
      return;
    }
    const flag = result.data.features.find((f) => f.id === "new_user_onboarding");
    if (!flag) {
      toast.error(t("components.onboardingFlag.loadFailed"));
      return;
    }
    setOnboardingFlagEnabled(flag.enabled);
  }, [t]);

  useEffect(() => { void loadOnboardingFlag(); }, [loadOnboardingFlag]);

  // ── ADR-0022 (PRI-578): owner identity handlers ─────────────────────────

  const handleRegisterOwner = useCallback(async () => {
    if (ownerIdInput.trim().length === 0 || credentialIdInput.trim().length === 0) {
      toast.error(t("pages.settings.ownerIdentity.required"));
      return;
    }
    setOwnerActionPending(true);
    try {
      const result = await registerOwnerIdentity(ownerIdInput.trim(), credentialIdInput.trim());
      if (!result.success) {
        toast.error(t("pages.settings.ownerIdentity.operationFailed"));
        return;
      }
      const refresh = await fetchOwnerIdentity();
      if (refresh.success && refresh.data) setOwnerIdentity(refresh.data);
      setOwnerIdInput("");
      setCredentialIdInput("");
      toast.success(t("pages.settings.ownerIdentity.registered"));
    } finally {
      setOwnerActionPending(false);
    }
  }, [ownerIdInput, credentialIdInput, t]);

  const handleUnregisterOwner = useCallback(async () => {
    setOwnerActionPending(true);
    try {
      const result = await unregisterOwnerIdentity();
      if (!result.success) {
        toast.error(t("pages.settings.ownerIdentity.operationFailed"));
        return;
      }
      const refresh = await fetchOwnerIdentity();
      if (refresh.success && refresh.data) setOwnerIdentity(refresh.data);
      toast.success(t("pages.settings.ownerIdentity.unregistered"));
    } finally {
      setOwnerActionPending(false);
    }
  }, [t]);


  // ── Auth token handlers ────────────────────────────────────────────────

  const handleSaveToken = useCallback(async () => {
    const trimmed = tokenInput.trim();
    if (trimmed.length === 0) return;
    const companion = (window as typeof window & { pdCompanion?: { configureConsoleToken(token: string): Promise<boolean> } }).pdCompanion;
    if (companion !== undefined) await companion.configureConsoleToken(trimmed);
    setToken(trimmed);
    await loadOnboardingFlag();
    toast.success(t("pages.settings.tokenSaved"));
  }, [tokenInput, loadOnboardingFlag, t]);

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

  // ── Onboarding flag toggle handler (spec 2026-06-30 §12.5) ────────────
  // Calls the validated PATCH /api/v1/config/features/new_user_onboarding
  // wrapper (patchFeatureFlag). Response is runtime-validated by validateFeatureFlagUpdate
  // (rc-1/rc-3) before state is updated.
  const handleToggleOnboardingFlag = useCallback(async () => {
    if (onboardingFlagEnabled === null) return;
    const newEnabled = !onboardingFlagEnabled;
    const result = await patchFeatureFlag("new_user_onboarding", newEnabled);
    if (!result.success || !result.data) {
      // rc-9: surface reason via toast instead of silent rollback
      toast.error(t("components.onboardingFlag.toggleFailed"));
      return;
    }
    setOnboardingFlagEnabled(result.data.enabled);
    toast.success(
      t(
        newEnabled
          ? "components.onboardingFlag.enabled"
          : "components.onboardingFlag.disabled",
      ),
    );
  }, [onboardingFlagEnabled, t]);

  // ── Onboarding reset handler ───────────────────────────────────────────
  // Mirror App.tsx currentWorkspaceId derivation (App.tsx default="default",
  // then workspaces[0].name after fetch). Using the same key ensures
  // resetOnboardingState targets the same localStorage entry the onboarding
  // wizard wrote — avoids a silent no-op reset (EP-09 test-reality gap).
  const currentWorkspaceId = workspaces[0]?.name ?? "default";

  const handleResetOnboarding = useCallback(() => {
    const confirmed = window.confirm(
      t("components.onboardingReset.resetConfirm"),
    );
    if (confirmed) {
      if (!resetOnboardingState(currentWorkspaceId)) {
        toast.error(t("components.onboardingReset.resetFailed"));
        return;
      }
      toast.success(t("components.onboardingReset.resetSuccess"));
    }
  }, [currentWorkspaceId, t]);

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

      {/* ADR-0022 (PRI-578): Owner identity */}
      <section className="mb-8" aria-labelledby="section-owner-identity">
        <SectionTitle id="section-owner-identity">
          {t("pages.settings.ownerIdentity.title")}
        </SectionTitle>
        <div className="bg-panel border border-line rounded-[6px] p-5">
          <p className="text-ink-3 text-[13px] leading-relaxed mb-3">
            {t("pages.settings.ownerIdentity.intro")}
          </p>
          {ownerIdentity === null ? (
            <div className="text-ink-4 text-[12px]">{t("pages.settings.ownerIdentity.loading")}</div>
          ) : (
            <>
              {/* Registration = where the identity comes from. Never conflated
                  with governance readiness below (ADR-0022 review). */}
              <div className="flex items-center gap-2 text-[13px] mb-2" data-testid="owner-identity-status">
                <span
                  className={`inline-flex items-center rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase ${
                    ownerIdentity.resolved.source === "none"
                      ? "bg-amber text-ink"
                      : ownerIdentity.resolved.source === "invalid_env"
                        ? "bg-danger text-paper"
                        : "bg-green text-ink"
                  }`}
                  role="status"
                >
                  {ownerIdentity.resolved.source === "none"
                    ? t("pages.settings.ownerIdentity.statusMissing")
                    : ownerIdentity.resolved.source === "invalid_env"
                      ? t("pages.settings.ownerIdentity.statusInvalid")
                      : t("pages.settings.ownerIdentity.statusConfigured")}
                </span>
                <span className="text-ink-3 text-[12px]">
                  {ownerIdentity.resolved.source === "env" && t("pages.settings.ownerIdentity.sourceEnv")}
                  {ownerIdentity.resolved.source === "file" && t("pages.settings.ownerIdentity.sourceFile")}
                  {ownerIdentity.resolved.source === "invalid_env" && t("pages.settings.ownerIdentity.sourceInvalid")}
                  {ownerIdentity.resolved.source === "none" && t("pages.settings.ownerIdentity.sourceNone")}
                </span>
              </div>
              {/* Governance readiness — derived ONLY from the canonical
                  resolveOwnerConfigSnapshot fields delivered by the API. */}
              <div
                className="flex items-center gap-2 text-[13px] mb-2"
                data-testid="owner-governance-readiness"
                data-ready={ownerIdentity.governance.ownerIdentityConfiguration === "configured" && ownerIdentity.governance.authenticationMode === "authenticated" ? "true" : "false"}
              >
                <span
                  className={`inline-flex items-center rounded-[2px] px-[7px] py-1 font-mono text-[11px] uppercase ${
                    ownerIdentity.governance.ownerIdentityConfiguration === "configured" && ownerIdentity.governance.authenticationMode === "authenticated" ? "bg-green text-ink" : "bg-amber text-ink"
                  }`}
                  role="status"
                >
                  {ownerIdentity.governance.ownerIdentityConfiguration === "configured" && ownerIdentity.governance.authenticationMode === "authenticated"
                    ? t("pages.settings.ownerIdentity.governanceReady")
                    : t("pages.settings.ownerIdentity.governanceNotReady")}
                </span>
                {(ownerIdentity.governance.ownerIdentityConfiguration !== "configured" || ownerIdentity.governance.authenticationMode !== "authenticated") && (
                  <span className="text-ink-3 text-[12px]">
                    {ownerIdentity.governance.ownerIdentityConfiguration === "configured" && ownerIdentity.governance.authenticationMode === "no_auth"
                      ? t("pages.settings.ownerIdentity.governanceReasonTokenAuth")
                      : t("pages.settings.ownerIdentity.governanceReasonIdentity")}
                  </span>
                )}
              </div>
              {ownerIdentity.governance.ownerIdentityConfiguration === "configured" &&
                ownerIdentity.governance.authenticationMode === "no_auth" && (
                  <div className="text-ink-4 text-[12px] mb-3" data-testid="owner-governance-next-action">
                    {t("pages.settings.ownerIdentity.governanceNextActionTokenAuth")}
                  </div>
                )}
              {ownerIdentity.resolved.error !== undefined && (
                <div className="text-danger text-[12px] mb-3" data-testid="owner-identity-error">
                  {ownerIdentity.resolved.error}
                </div>
              )}
              {ownerIdentity.resolved.source === "invalid_env" && (
                <div className="text-ink-4 text-[12px] mb-3" data-testid="owner-identity-invalid-env-hint">
                  {t("pages.settings.ownerIdentity.invalidEnvHint")}
                </div>
              )}
              {/* The file record is only meaningful as the EFFECTIVE identity
                  when resolution actually came from the file — never display it
                  as active under an invalid env override. */}
              {ownerIdentity.resolved.source === "file" && ownerIdentity.fileRecord !== null && (
                <div className="text-ink-4 text-[12px] mb-3 font-mono">
                  {t("pages.settings.ownerIdentity.ownerIdLabel")}: {ownerIdentity.fileRecord.ownerId} ·{" "}
                  {t("pages.settings.ownerIdentity.registeredAt")} {ownerIdentity.fileRecord.registeredAt.slice(0, 10)}
                </div>
              )}
              {ownerIdentity.fileError !== undefined && (
                <div className="text-danger text-[12px] mb-3" data-testid="owner-identity-file-error">
                  {ownerIdentity.fileError}
                </div>
              )}
              {ownerIdentity.resolved.source === "env" ? (
                <div className="text-ink-4 text-[12px]">{t("pages.settings.ownerIdentity.envHint")}</div>
              ) : (
                <div className="mt-3">
                  <label htmlFor="owner-id-input" className="block text-sm font-medium text-ink mb-1">
                    {t("pages.settings.ownerIdentity.ownerIdLabel")}
                  </label>
                  <input
                    id="owner-id-input"
                    type="text"
                    value={ownerIdInput}
                    onChange={(e) => setOwnerIdInput(e.target.value)}
                    disabled={ownerActionPending}
                    placeholder="owner-alice"
                    className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov disabled:opacity-50"
                  />
                  <label htmlFor="credential-id-input" className="block text-sm font-medium text-ink mt-3 mb-1">
                    {t("pages.settings.ownerIdentity.credentialIdLabel")}
                  </label>
                  <input
                    id="credential-id-input"
                    type="text"
                    value={credentialIdInput}
                    onChange={(e) => setCredentialIdInput(e.target.value)}
                    disabled={ownerActionPending}
                    placeholder="cred-..."
                    className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov disabled:opacity-50"
                  />
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      type="button"
                      onClick={handleRegisterOwner}
                      disabled={ownerActionPending}
                      className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                    >
                      {t("pages.settings.ownerIdentity.register")}
                    </button>
                    {ownerIdentity.resolved.source === "file" && (
                      <button
                        type="button"
                        onClick={handleUnregisterOwner}
                        disabled={ownerActionPending}
                        className="border border-line text-ink-3 rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-surface transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {t("pages.settings.ownerIdentity.unregister")}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
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
      <section className="mb-8" aria-labelledby="section-workspaces">
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

      {/* Section: Onboarding feature flag toggle (spec 2026-06-30 §12.5) */}
      <section className="mb-8" aria-labelledby="section-onboarding-flag">
        <SectionTitle id="section-onboarding-flag">
          {t("components.onboardingFlag.title")}
        </SectionTitle>

        <div className="bg-panel border border-line rounded-[6px] p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <label
                htmlFor="onboarding-flag-toggle"
                className="block text-sm font-medium text-ink"
              >
                {t("components.onboardingFlag.label")}
              </label>
              <p className="text-ink-3 text-[13px] leading-relaxed mt-1">
                {t("components.onboardingFlag.description")}
              </p>
            </div>
            <button
              id="onboarding-flag-toggle"
              type="button"
              role="switch"
              aria-checked={onboardingFlagEnabled ?? false}
              aria-label={t("components.onboardingFlag.toggleAriaLabel")}
              onClick={handleToggleOnboardingFlag}
              disabled={onboardingFlagEnabled === null}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed",
                onboardingFlagEnabled ? "bg-gov" : "bg-line",
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 transform rounded-full bg-paper transition-transform",
                  onboardingFlagEnabled ? "translate-x-6" : "translate-x-1",
                )}
              />
            </button>
          </div>
        </div>
      </section>

      {/* Section 4: Onboarding reset */}
      <section aria-labelledby="section-onboarding-reset">
        <SectionTitle id="section-onboarding-reset">
          {t("components.onboardingReset.title")}
        </SectionTitle>

        <div className="bg-panel border border-line rounded-[6px] p-5">
          <button
            onClick={handleResetOnboarding}
            className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("components.onboardingReset.resetButton")}
          </button>
        </div>
      </section>
      </div>
    </PageShell>
  );
}
