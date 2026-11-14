import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "../../../lib/utils.js";
import {
  createRuntimeProfile,
  updateRuntimeProfile,
  deleteRuntimeProfile,
  saveProviderCredential,
  deleteProviderCredential,
  fetchProviderCredentialStatus,
  testProviderConnection,
} from "../../api.js";
import type {
  ConnectionProbe,
  CredentialStatus,
  ProviderPreset,
  RedactedRuntimeProfileSummary,
} from "../../api.js";
import {
  CUSTOM_PROVIDER_ID,
  apiFormatLabel,
  deriveProfileId,
  providerDisplayName,
  providerMonogram,
  suggestedEnvName,
} from "./provider-presets.js";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface ProviderProfileFormProps {
  mode: "create" | "edit";
  /** Provider id chosen in the picker, or CUSTOM_PROVIDER_ID. */
  presetId: string;
  initial?: RedactedRuntimeProfileSummary;
  presets: ProviderPreset[];
  existingIds: string[];
  /** Persisted successfully; parent refreshes the sidebar but keeps the form open. */
  onPersisted: () => void;
  /** Delete succeeded or the user left the form. */
  onClose: () => void;
  onDeleted: () => void;
  onBackToPicker: () => void;
}

const inputClass =
  "bg-surface border border-line-2 rounded-[3px] px-[10px] py-[6px] text-caption text-ink focus:outline-none focus:border-gov disabled:opacity-50 disabled:cursor-not-allowed w-full";
const labelClass =
  "block font-mono text-caption uppercase tracking-[0.04em] text-ink-4 mb-[4px]";
const hintClass = "mt-[3px] text-caption text-ink-4 leading-[1.4]";

function probeTone(kind: ConnectionProbe["kind"]): string {
  switch (kind) {
    case "ok":
      return "border-green/35 bg-green/10";
    case "missing_credential":
    case "network":
      return "border-amber/35 bg-amber/10";
    default:
      return "border-danger/35 bg-danger/10";
  }
}

export function ProviderProfileForm({
  mode,
  presetId,
  initial,
  presets,
  existingIds,
  onPersisted,
  onClose,
  onDeleted,
  onBackToPicker,
}: ProviderProfileFormProps) {
  const { t } = useTranslation();

  // The bootstrap profile ships with provider="" (defaults, needs_setup). Treat
  // it as "no choice yet" so the picker's provider preselection still applies
  // and the profile can be completed by PATCH instead of being forced into the
  // custom-endpoint path.
  const rawInitialProvider = initial?.provider;
  const initialProvider =
    rawInitialProvider !== undefined && rawInitialProvider !== ""
      ? rawInitialProvider
      : presetId === CUSTOM_PROVIDER_ID
        ? ""
        : presetId;
  const initialPreset = presets.find((preset) => preset.id === initialProvider);
  const [providerId, setProviderId] = useState(initialPreset?.id ?? CUSTOM_PROVIDER_ID);
  const [customProvider, setCustomProvider] = useState(initialPreset ? "" : initialProvider);
  const [customBaseUrl, setCustomBaseUrl] = useState(initial?.baseUrl ?? "");
  const [model, setModel] = useState(
    initial?.model !== undefined && initial.model !== ""
      ? initial.model
      : (initialPreset?.models[0]?.id ?? ""),
  );
  const rawInitialModel = initial?.model;
  const hasInitialModel = rawInitialModel !== undefined && rawInitialModel !== "";
  const initialModelInPreset =
    initialPreset !== undefined &&
    hasInitialModel &&
    initialPreset.models.some((item) => item.id === rawInitialModel);
  const [manualModelEnabled, setManualModelEnabled] = useState(
    initialPreset === undefined || (hasInitialModel && !initialModelInPreset),
  );
  const [manualModel, setManualModel] = useState(
    initialPreset === undefined || (hasInitialModel && !initialModelInPreset)
      ? (rawInitialModel ?? "")
      : "",
  );
  const [apiKeyEnv, setApiKeyEnv] = useState(
    initial?.apiKeyEnv !== undefined && initial.apiKeyEnv !== ""
      ? initial.apiKeyEnv
      : suggestedEnvName(initialProvider),
  );
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [profileId, setProfileId] = useState(
    initial?.id ?? deriveProfileId(initialProvider === "" ? "custom" : initialProvider, existingIds),
  );
  const [persistedId, setPersistedId] = useState<string | null>(mode === "edit" ? (initial?.id ?? null) : null);
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [credentialLoading, setCredentialLoading] = useState(false);
  const [probe, setProbe] = useState<ConnectionProbe | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = providerId === CUSTOM_PROVIDER_ID ? undefined : presets.find((item) => item.id === providerId);
  const isCustom = preset === undefined;
  const selectedModel = preset?.models.find((item) => item.id === model);
  const catalogBaseUrl = preset?.baseUrl ?? "";
  const effectiveProvider = isCustom ? customProvider.trim() : providerId;
  const effectiveModel = manualModelEnabled ? manualModel.trim() : (selectedModel?.id ?? model);
  // The runtime treats a custom baseUrl as OpenAI-compatible (resolveModel), so
  // the format is a derived fact, not a user choice. Showing an editable select
  // here would promise a protocol switch the config cannot carry.
  const effectiveApiFormat = isCustom
    ? "openai-completions"
    : (selectedModel?.api ?? preset?.api ?? "");

  const credentialRequestRef = useRef(0);
  const refreshCredential = useCallback(async (envName: string) => {
    const generation = credentialRequestRef.current + 1;
    credentialRequestRef.current = generation;
    if (!ENV_NAME_PATTERN.test(envName)) {
      setCredential(null);
      return;
    }
    setCredentialLoading(true);
    const result = await fetchProviderCredentialStatus(envName);
    // A later request (or a save/remove response) wins; stale responses must
    // not overwrite the status the user is currently looking at.
    if (generation !== credentialRequestRef.current) return;
    setCredentialLoading(false);
    setCredential(result.success ? result.data : null);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshCredential(apiKeyEnv);
    }, 300);
    return () => clearTimeout(timer);
  }, [apiKeyEnv, refreshCredential]);

  const handleModelChange = (nextModel: string) => {
    setModel(nextModel);
  };

  const handleCustomProviderChange = (value: string) => {
    setCustomProvider(value);
    if (persistedId === null) {
      const slug = value.trim() === "" ? "custom" : value;
      setProfileId(deriveProfileId(slug, existingIds));
    }
  };

  const validate = (): string | null => {
    if (persistedId === null && profileId.trim() === "") {
      return t("pages.controlCenter.profiles.validationIdRequired");
    }
    if (effectiveProvider === "") {
      return t("pages.controlCenter.profiles.validationProviderRequired");
    }
    if (effectiveModel === "") {
      return t("pages.controlCenter.profiles.validationModelRequired");
    }
    if (!ENV_NAME_PATTERN.test(apiKeyEnv.trim())) {
      return t("pages.controlCenter.profiles.validationApiKeyEnvRequired");
    }
    if (isCustom && customBaseUrl.trim() === "") {
      return t("pages.controlCenter.profiles.validationBaseUrlRequired");
    }
    if (isCustom || customBaseUrl.trim() !== "") {
      try {
        const parsed = new URL(customBaseUrl.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return t("pages.controlCenter.profiles.validationBaseUrlRequired");
        }
      } catch {
        return t("pages.controlCenter.profiles.validationBaseUrlRequired");
      }
    }
    return null;
  };

  const persistProfile = async (): Promise<boolean> => {
    const envName = apiKeyEnv.trim();
    // Custom endpoints require a URL; preset providers may still carry an
    // advanced override. Empty always means "clear the override".
    const desiredBaseUrl = customBaseUrl.trim();
    if (persistedId === null) {
      const result = await createRuntimeProfile(profileId.trim(), {
        type: "pi-ai",
        provider: effectiveProvider,
        model: effectiveModel,
        apiKeyEnv: envName,
        ...(desiredBaseUrl !== "" ? { baseUrl: desiredBaseUrl } : {}),
      });
      if (!result.success) {
        setError(result.error);
        return false;
      }
      setPersistedId(profileId.trim());
    } else {
      const result = await updateRuntimeProfile(persistedId, {
        provider: effectiveProvider,
        model: effectiveModel,
        apiKeyEnv: envName,
        // Empty string deliberately clears a stale custom endpoint when the
        // profile now uses a catalog provider (the advanced hint says so).
        baseUrl: desiredBaseUrl,
      });
      if (!result.success) {
        setError(result.error);
        return false;
      }
    }
    return true;
  };

  const handleSave = async (thenTest: boolean) => {
    const validationError = validate();
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    setError(null);
    setProbe(null);
    setSaving(true);
    const persisted = await persistProfile();
    if (!persisted) {
      setSaving(false);
      toast.error(t("pages.controlCenter.profiles.operationFailed"));
      return;
    }

    if (apiKey.trim() !== "") {
      const saved = await saveProviderCredential(apiKeyEnv.trim(), apiKey);
      if (!saved.success) {
        setSaving(false);
        setError(
          t("pages.controlCenter.profiles.credentialSaveFailed", { reason: saved.error }),
        );
        toast.error(t("pages.controlCenter.profiles.operationFailed"));
        return;
      }
      setApiKey("");
      setShowKey(false);
      credentialRequestRef.current += 1;
      setCredentialLoading(false);
      setCredential(saved.data);
    } else {
      void refreshCredential(apiKeyEnv.trim());
    }

    setSaving(false);
    setError(null);
    toast.success(t("pages.controlCenter.profiles.updateSuccess"));
    onPersisted();

    if (thenTest) {
      // The key was just persisted, so the "type a saved key first" guard no
      // longer applies — and the closure still holds the pre-save value.
      await runProbe({ requireSavedKey: false });
    }
  };

  const runProbe = async (options: { requireSavedKey?: boolean } = {}) => {
    const { requireSavedKey = true } = options;
    if (requireSavedKey && apiKey.trim() !== "") {
      setError(t("pages.controlCenter.profiles.testRequiresSavedKey"));
      return;
    }
    setError(null);
    setTesting(true);
    const result = await testProviderConnection({
      provider: effectiveProvider,
      model: effectiveModel,
      apiKeyEnv: apiKeyEnv.trim(),
      ...(customBaseUrl.trim() !== "" ? { baseUrl: customBaseUrl.trim() } : {}),
    });
    setTesting(false);
    if (!result.success) {
      setProbe(null);
      setError(result.error);
      return;
    }
    setProbe(result.data);
  };

  const handleDelete = async () => {
    if (persistedId === null) return;
    setDeleting(true);
    const result = await deleteRuntimeProfile(persistedId);
    setDeleting(false);
    if (!result.success) {
      setError(result.error);
      toast.error(t("pages.controlCenter.profiles.operationFailed"));
      return;
    }
    toast.success(t("pages.controlCenter.profiles.deleteSuccess"));
    onDeleted();
  };

  const handleRemoveKey = async () => {
    const removed = await deleteProviderCredential(apiKeyEnv.trim());
    if (!removed.success) {
      setError(removed.error);
      return;
    }
    credentialRequestRef.current += 1;
    setCredentialLoading(false);
    setCredential(removed.data);
    toast.success(t("pages.controlCenter.profiles.credentialRemoved"));
  };

  const providerLabel = isCustom ? customProvider.trim() || t("pages.controlCenter.profiles.customProvider") : providerDisplayName(providerId);
  const credentialConfigured = credential?.configured === true;
  const credentialFromEnv = credential?.source === "env";
  const credentialFromFile = credential?.source === "file";
  const permissionBestEffort = credential?.filePermissions === "best_effort";

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void handleSave(false);
      }}
      className="bg-panel border border-line rounded-[6px] px-[16px] py-[16px]"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-[10px] min-w-0">
          <span
            aria-hidden="true"
            className="shrink-0 w-[34px] h-[34px] rounded-[4px] bg-paper-2 border border-line-2 text-ink-2 font-mono text-[12px] flex items-center justify-center"
          >
            {isCustom ? "+" : providerMonogram(providerId)}
          </span>
          <div className="min-w-0">
            <h4 className="text-body font-semibold text-ink truncate">{providerLabel}</h4>
            <p className="text-caption text-ink-4">
              {mode === "create" && persistedId === null
                ? t("pages.controlCenter.profiles.formTitleCreate")
                : t("pages.controlCenter.profiles.formTitleEdit", { id: persistedId ?? profileId })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-[8px] shrink-0">
          {mode === "create" && persistedId === null && (
            <button
              type="button"
              onClick={onBackToPicker}
              className="text-caption px-[10px] py-[4px] rounded-[3px] border border-line bg-surface text-ink-3 hover:border-line-2 hover:text-ink transition-colors"
            >
              {t("pages.controlCenter.profiles.changeProvider")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-caption text-ink-4 hover:text-ink-2 transition-colors"
          >
            {t("pages.controlCenter.profiles.closeButton")}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-[16px] gap-y-[12px]">
        {/* Endpoint — catalog value is shown, never typed on the main path. */}
        <div>
          <span className={labelClass}>{t("pages.controlCenter.profiles.fieldBaseUrl")}</span>
          {isCustom ? (
            <input
              type="text"
              value={customBaseUrl}
              onChange={(event) => setCustomBaseUrl(event.target.value)}
              disabled={saving || testing}
              placeholder="https://api.example.com/v1"
              className={inputClass}
              autoComplete="off"
              spellCheck={false}
            />
          ) : (
            <div className="bg-paper-2 border border-line-2 rounded-[3px] px-[10px] py-[6px] text-caption text-ink-3 font-mono break-all">
              {catalogBaseUrl}
            </div>
          )}
          <p className={hintClass}>
            {isCustom
              ? t("pages.controlCenter.profiles.customBaseUrlHint")
              : t("pages.controlCenter.profiles.baseUrlFromCatalog")}
          </p>
        </div>

        {/* API format — derived, never editable: profiles carry no protocol field. */}
        <div>
          <span className={labelClass}>{t("pages.controlCenter.profiles.fieldApiFormat")}</span>
          <div className="bg-paper-2 border border-line-2 rounded-[3px] px-[10px] py-[6px] text-caption text-ink-3 font-mono">
            {apiFormatLabel(effectiveApiFormat)}
          </div>
          <p className={hintClass}>{t("pages.controlCenter.profiles.apiFormatHint")}</p>
        </div>

        {/* Model */}
        <div>
          <label className={labelClass} htmlFor="rpf-model">
            {t("pages.controlCenter.profiles.fieldModel")}
          </label>
          {manualModelEnabled ? (
            <input
              id="rpf-model"
              type="text"
              value={manualModel}
              onChange={(event) => setManualModel(event.target.value)}
              disabled={saving || testing}
              placeholder={t("pages.controlCenter.profiles.fieldModelPlaceholder")}
              className={cn(inputClass, "font-mono")}
              autoComplete="off"
              spellCheck={false}
            />
          ) : (
            <select
              id="rpf-model"
              value={selectedModel?.id ?? model}
              onChange={(event) => handleModelChange(event.target.value)}
              disabled={saving || testing}
              className={cn(inputClass, "font-mono")}
            >
              {(preset?.models ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.id})
                </option>
              ))}
            </select>
          )}
          <p className={hintClass}>{t("pages.controlCenter.profiles.modelHint")}</p>
        </div>

        {/* API key */}
        <div>
          <label className={labelClass} htmlFor="rpf-api-key">
            {t("pages.controlCenter.profiles.fieldApiKey")}
          </label>
          <div className="relative">
            <input
              id="rpf-api-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={saving || testing}
              placeholder={
                credentialFromEnv
                  ? t("pages.controlCenter.profiles.fieldApiKeyPlaceholderEnv")
                  : credentialFromFile
                    ? t("pages.controlCenter.profiles.fieldApiKeyPlaceholderSaved")
                    : t("pages.controlCenter.profiles.fieldApiKeyPlaceholder")
              }
              className={cn(inputClass, "font-mono pr-[64px]")}
              autoComplete="new-password"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowKey((value) => !value)}
              className="absolute right-[4px] top-[50%] -translate-y-1/2 text-caption text-ink-4 hover:text-ink-2 px-[6px] py-[2px]"
            >
              {showKey
                ? t("pages.controlCenter.profiles.hideKey")
                : t("pages.controlCenter.profiles.showKey")}
            </button>
          </div>
          <p className={hintClass}>{t("pages.controlCenter.profiles.apiKeyHint")}</p>
          <div className="mt-[4px] flex items-center gap-[8px] min-h-[18px]">
            <span
              className={cn(
                "w-2 h-2 rounded-full border-2 shrink-0",
                credentialConfigured ? "border-green bg-green" : "border-amber bg-surface",
              )}
              aria-hidden="true"
            />
            <span className="text-caption text-ink-4">
              {credentialLoading
                ? t("pages.controlCenter.profiles.credentialChecking")
                : credentialFromEnv
                  ? t("pages.controlCenter.profiles.credentialFromEnv", { name: apiKeyEnv })
                  : credentialFromFile
                    ? t("pages.controlCenter.profiles.credentialSaved", {
                        mask: credential?.last4 ?? "••••",
                      })
                    : t("pages.controlCenter.profiles.credentialMissing")}
            </span>
            {credentialFromFile && (
              <button
                type="button"
                onClick={() => void handleRemoveKey()}
                className="text-caption text-ink-4 hover:text-danger transition-colors"
              >
                {t("pages.controlCenter.profiles.credentialRemove")}
              </button>
            )}
          </div>
          {(credentialFromEnv || permissionBestEffort) && (
            <p className={hintClass}>
              {credentialFromEnv
                ? t("pages.controlCenter.profiles.credentialEnvWins")
                : t("pages.controlCenter.profiles.credentialPermissionBestEffort")}
            </p>
          )}
        </div>
      </div>

      {/* Advanced — deliberately folded: the main path never shows a URL input. */}
      <div className="mt-4 border-t border-line-2 pt-3">
        <button
          type="button"
          onClick={() => setShowAdvanced((value) => !value)}
          className="text-caption text-ink-4 hover:text-ink-2 transition-colors"
        >
          {showAdvanced
            ? t("pages.controlCenter.profiles.hideAdvanced")
            : t("pages.controlCenter.profiles.showAdvanced")}
        </button>
        {showAdvanced && (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-[16px] gap-y-[12px]">
            <div>
              <label className={labelClass} htmlFor="rpf-id">
                {t("pages.controlCenter.profiles.fieldId")}
              </label>
              <input
                id="rpf-id"
                type="text"
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
                disabled={persistedId !== null || saving}
                placeholder={t("pages.controlCenter.profiles.fieldIdPlaceholder")}
                className={cn(inputClass, "font-mono")}
                autoComplete="off"
                spellCheck={false}
              />
              <p className={hintClass}>{t("pages.controlCenter.profiles.fieldIdHint")}</p>
            </div>
            <div>
              <label className={labelClass} htmlFor="rpf-apikeyenv">
                {t("pages.controlCenter.profiles.fieldApiKeyEnv")}
              </label>
              <input
                id="rpf-apikeyenv"
                type="text"
                value={apiKeyEnv}
                onChange={(event) => setApiKeyEnv(event.target.value)}
                disabled={saving || testing}
                placeholder="DEEPSEEK_API_KEY"
                className={cn(inputClass, "font-mono")}
                autoComplete="off"
                spellCheck={false}
              />
              <p className={hintClass}>{t("pages.controlCenter.profiles.fieldApiKeyEnvHint")}</p>
            </div>
            {isCustom && (
              <div>
                <label className={labelClass} htmlFor="rpf-provider">
                  {t("pages.controlCenter.profiles.fieldProvider")}
                </label>
                <input
                  id="rpf-provider"
                  type="text"
                  value={customProvider}
                  onChange={(event) => handleCustomProviderChange(event.target.value)}
                  disabled={saving || testing}
                  placeholder={t("pages.controlCenter.profiles.fieldProviderPlaceholder")}
                  className={cn(inputClass, "font-mono")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
            {!isCustom && (
              <div>
                <span className={labelClass}>
                  {t("pages.controlCenter.profiles.fieldBaseUrlOverride")}
                </span>
                <input
                  type="text"
                  value={customBaseUrl}
                  onChange={(event) => setCustomBaseUrl(event.target.value)}
                  disabled={saving || testing}
                  placeholder={t("pages.controlCenter.profiles.fieldBaseUrlOverridePlaceholder")}
                  className={cn(inputClass, "font-mono")}
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className={hintClass}>
                  {t("pages.controlCenter.profiles.fieldBaseUrlOverrideHint")}
                </p>
              </div>
            )}
            <div className="sm:col-span-2">
              <label className="inline-flex items-center gap-[6px] text-caption text-ink-3">
                <input
                  type="checkbox"
                  checked={manualModelEnabled}
                  onChange={(event) => setManualModelEnabled(event.target.checked)}
                  disabled={saving || testing}
                />
                {t("pages.controlCenter.profiles.manualModelToggle")}
              </label>
              <p className={hintClass}>{t("pages.controlCenter.profiles.manualModelHint")}</p>
            </div>
          </div>
        )}
      </div>

      {error !== null && (
        <div className="mt-3 px-[12px] py-[8px] border border-danger/35 rounded-[4px] bg-danger/10 text-[12px] text-danger font-mono">
          {error}
        </div>
      )}

      {probe !== null && (
        <div className={cn("mt-3 px-[12px] py-[8px] border rounded-[4px]", probeTone(probe.kind))}>
          <div className="text-[12px] text-ink font-medium">
            {t(`pages.controlCenter.profiles.probeKind.${probe.kind}`)}
            {probe.httpStatus !== undefined ? ` · HTTP ${String(probe.httpStatus)}` : ""}
            {` · ${String(probe.latencyMs)}ms`}
          </div>
          <div className="mt-[3px] text-[12px] text-ink-3 font-mono break-words">{probe.message}</div>
          {probe.nextAction !== undefined && (
            <div className="mt-[3px] text-caption text-ink-4">{probe.nextAction}</div>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-[8px]">
        <button
          type="submit"
          disabled={saving || testing}
          className="border border-gov bg-gov text-paper rounded-[3px] px-[16px] py-[6px] text-caption font-medium hover:bg-gov-2 transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          {saving
            ? t("pages.controlCenter.profiles.saving")
            : t("pages.controlCenter.profiles.saveButton")}
        </button>
        <button
          type="button"
          onClick={() => void handleSave(true)}
          disabled={saving || testing}
          className="border border-line bg-surface text-ink rounded-[3px] px-[16px] py-[6px] text-caption font-medium hover:border-line-2 transition-colors disabled:opacity-50"
        >
          {saving && !testing
            ? t("pages.controlCenter.profiles.saving")
            : t("pages.controlCenter.profiles.saveAndTest")}
        </button>
        <button
          type="button"
          onClick={() => void runProbe()}
          disabled={saving || testing}
          className="border border-line bg-surface text-ink-3 rounded-[3px] px-[16px] py-[6px] text-caption font-medium hover:border-line-2 hover:text-ink transition-colors disabled:opacity-50"
        >
          {testing ? t("pages.controlCenter.profiles.testing") : t("pages.controlCenter.profiles.testConnection")}
        </button>
      </div>

      {persistedId !== null && (
        <div className="mt-3 border-t border-line-2 pt-3">
          {deleteConfirm ? (
            <div className="px-[12px] py-[10px] border border-danger rounded-[4px] bg-danger/10 text-[12px] text-ink-2 leading-[1.55]">
              <div className="font-medium">
                {t("pages.controlCenter.profiles.deleteConfirmMessage", { id: persistedId })}
              </div>
              <div className="mt-2 flex gap-[8px]">
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={deleting}
                  className="text-caption px-[12px] py-[4px] rounded-[3px] border border-transparent bg-danger text-paper font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {deleting
                    ? t("pages.controlCenter.profiles.deleting")
                    : t("pages.controlCenter.profiles.deleteConfirmAck")}
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(false)}
                  disabled={deleting}
                  className="text-caption px-[12px] py-[4px] rounded-[3px] border border-line bg-transparent text-ink-3 hover:border-line-2 transition-colors disabled:opacity-50"
                >
                  {t("pages.controlCenter.profiles.deleteConfirmCancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setDeleteConfirm(true)}
              className="text-caption text-ink-4 hover:text-danger transition-colors"
            >
              {t("pages.controlCenter.profiles.deleteButton")}
            </button>
          )}
        </div>
      )}
    </form>
  );
}
