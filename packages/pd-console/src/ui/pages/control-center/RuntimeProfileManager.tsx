import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "../../../lib/utils.js";
import { enumLabel } from "../../utils/enum-labels.js";
import {
  createRuntimeProfile,
  updateRuntimeProfile,
  deleteRuntimeProfile,
} from "../../api.js";
import type {
  RedactedRuntimeProfileSummary,
  ReadinessStatus,
} from "../../api.js";

/**
 * RuntimeProfileManager — runtime profile CRUD UI.
 *
 * Renders a table of all runtime profiles with Create / Edit / Delete actions.
 * The form is an inline panel (not a modal) to match the subtle, restrained
 * aesthetic of AgentCard. Delete uses an inline confirmation bar.
 *
 * rc 合规:
 * - rc-1: profiles 已由父组件 (ControlCenterPage) 用 validateRuntimeProfileSummary
 *   验证；本组件不再重新解析。
 * - rc-2: 无 as 绕过 — 表单 state 用强类型 ProfileFormState，API 响应用
 *   validateRuntimeProfileMutation 校验。
 * - rc-3: 必填字段 (id / pi-ai 的 provider/model/apiKeyEnv) 缺失时 fail loud，
 *   显示内联校验错误，不发请求。
 * - rc-9: API 失败时通过 toast + 内联错误消息展示原因，不静默。
 *
 * 品牌约束 (PRI-CR1 B.4.4):
 * - 无 translateY / scale hover，无硬编码色值
 * - 状态点色板与 AgentCard 一致 (ready=green, needs_setup/not_ready/unknown=amber,
 *   disabled=ink-4)
 */

interface RuntimeProfileManagerProps {
  profiles: RedactedRuntimeProfileSummary[];
  /** ID of the profile currently set as defaultRuntime (cannot be deleted). */
  defaultRuntimeId: string;
  /** Called after a successful create/update/delete so the parent re-fetches. */
  onMutated: () => void;
}

type FormMode = "closed" | "create" | "edit";

type ProfileType = "openclaw" | "pi-ai";

interface ProfileFormState {
  id: string;
  type: ProfileType;
  provider: string;
  model: string;
  apiKeyEnv: string;
  baseUrl: string;
  source: string;
}

const EMPTY_FORM: ProfileFormState = {
  id: "",
  type: "openclaw",
  provider: "",
  model: "",
  apiKeyEnv: "",
  baseUrl: "",
  source: "",
};

/** 状态点样式：与 AgentCard 一致 (ready=green, needs_setup/not_ready/unknown=amber, disabled=ink-4) */
function readinessDotClasses(readiness: ReadinessStatus): string {
  const base = "w-2 h-2 rounded-full border-2 shrink-0";
  switch (readiness) {
    case "ready":
      return cn(base, "border-green bg-green");
    case "needs_setup":
    case "not_ready":
    case "unknown":
      return cn(base, "border-amber bg-surface");
    case "disabled":
      return cn(base, "border-ink-4 bg-surface opacity-50");
    default:
      return cn(base, "border-ink-4 bg-surface");
  }
}

/**
 * Build the profile object for a create request.
 * Only includes fields relevant to the chosen type; omits empty optionals.
 */
function buildCreateProfile(form: ProfileFormState): Record<string, unknown> {
  const profile: Record<string, unknown> = { type: form.type };
  if (form.type === "pi-ai") {
    profile.provider = form.provider.trim();
    profile.model = form.model.trim();
    profile.apiKeyEnv = form.apiKeyEnv.trim();
    if (form.baseUrl.trim() !== "") {
      profile.baseUrl = form.baseUrl.trim();
    }
  } else {
    if (form.source.trim() !== "") profile.source = form.source.trim();
    if (form.provider.trim() !== "") profile.provider = form.provider.trim();
    if (form.model.trim() !== "") profile.model = form.model.trim();
  }
  return profile;
}

/**
 * Build the patch object for an update request.
 * Sends `type` (server allows same-type no-op, rejects type change) plus all
 * non-empty type-relevant fields. Empty optionals are omitted so existing
 * values are preserved (merge-patch semantics on the server).
 */
function buildUpdatePatch(form: ProfileFormState): Record<string, unknown> {
  const patch: Record<string, unknown> = { type: form.type };
  if (form.type === "pi-ai") {
    if (form.provider.trim() !== "") patch.provider = form.provider.trim();
    if (form.model.trim() !== "") patch.model = form.model.trim();
    if (form.apiKeyEnv.trim() !== "") patch.apiKeyEnv = form.apiKeyEnv.trim();
    if (form.baseUrl.trim() !== "") patch.baseUrl = form.baseUrl.trim();
  } else {
    if (form.source.trim() !== "") patch.source = form.source.trim();
    if (form.provider.trim() !== "") patch.provider = form.provider.trim();
    if (form.model.trim() !== "") patch.model = form.model.trim();
  }
  return patch;
}

/** Pre-fill form from an existing profile summary (edit mode). */
function formFromProfile(p: RedactedRuntimeProfileSummary): ProfileFormState {
  // type is validated to be a known ProfileType by the caller before invoking;
  // here we guard defensively without `as`.
  const type: ProfileType = p.type === "pi-ai" ? "pi-ai" : "openclaw";
  return {
    id: p.id,
    type,
    provider: p.provider ?? "",
    model: p.model ?? "",
    apiKeyEnv: p.apiKeyEnv ?? "",
    baseUrl: "",
    source: "",
  };
}

export function RuntimeProfileManager({
  profiles,
  defaultRuntimeId,
  onMutated,
}: RuntimeProfileManagerProps) {
  const { t } = useTranslation();

  const [mode, setMode] = useState<FormMode>("closed");
  const [form, setForm] = useState<ProfileFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setMode("create");
  };

  const openEdit = (p: RedactedRuntimeProfileSummary) => {
    setForm(formFromProfile(p));
    setFormError(null);
    setMode("edit");
  };

  const closeForm = () => {
    setMode("closed");
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const handleFieldChange = <K extends keyof ProfileFormState>(
    key: K,
    value: ProfileFormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  /** Validate the form; returns an error message key suffix or null if valid. */
  function validate(): string | null {
    if (mode === "create" && form.id.trim() === "") {
      return t("pages.controlCenter.profiles.validationIdRequired");
    }
    if (form.type === "pi-ai") {
      if (form.provider.trim() === "") {
        return t("pages.controlCenter.profiles.validationProviderRequired");
      }
      if (form.model.trim() === "") {
        return t("pages.controlCenter.profiles.validationModelRequired");
      }
      if (form.apiKeyEnv.trim() === "") {
        return t("pages.controlCenter.profiles.validationApiKeyEnvRequired");
      }
    }
    return null;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError !== null) {
      setFormError(validationError);
      return;
    }
    setFormError(null);
    setSubmitting(true);

    if (mode === "create") {
      const result = await createRuntimeProfile(
        form.id.trim(),
        buildCreateProfile(form),
      );
      setSubmitting(false);
      if (!result.success) {
        // rc-9: surface server error (e.g. "already exists", "validation failed")
        setFormError(result.error);
        toast.error(t("pages.controlCenter.profiles.operationFailed"));
        return;
      }
      toast.success(t("pages.controlCenter.profiles.createSuccess"));
      closeForm();
      onMutated();
      return;
    }

    // edit mode
    const result = await updateRuntimeProfile(
      form.id,
      buildUpdatePatch(form),
    );
    setSubmitting(false);
    if (!result.success) {
      setFormError(result.error);
      toast.error(t("pages.controlCenter.profiles.operationFailed"));
      return;
    }
    toast.success(t("pages.controlCenter.profiles.updateSuccess"));
    closeForm();
    onMutated();
  };

  const handleDeleteConfirm = async () => {
    if (deleteTarget === null) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await deleteRuntimeProfile(deleteTarget);
    setDeleting(false);
    if (!result.success) {
      // rc-9: surface reason (e.g. "referenced by agents: diagnostician")
      setDeleteError(result.error);
      toast.error(t("pages.controlCenter.profiles.operationFailed"));
      return;
    }
    toast.success(t("pages.controlCenter.profiles.deleteSuccess"));
    setDeleteTarget(null);
    setDeleteError(null);
    onMutated();
  };

  const handleDeleteCancel = () => {
    setDeleteTarget(null);
    setDeleteError(null);
  };

  const inputClass =
    "bg-surface border border-line-2 rounded-[3px] px-[10px] py-[6px] text-[12.5px] text-ink focus:outline-none focus:border-gov disabled:opacity-50 disabled:cursor-not-allowed w-full";
  const labelClass =
    "block font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-4 mb-[4px]";
  const hintClass = "mt-[3px] text-[11px] text-ink-4 leading-[1.4]";

  return (
    <div id="runtime-profile-manager" className="scroll-mt-4">
      {/* Header row: title + create button */}
      <div className="flex items-center justify-between gap-[12px] mb-3">
        <p className="text-ink-3 text-[13px] leading-relaxed">
          {t("pages.controlCenter.profiles.sectionDescription")}
        </p>
        {mode === "closed" && (
          <button
            type="button"
            onClick={openCreate}
            className="shrink-0 border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("pages.controlCenter.profiles.createButton")}
          </button>
        )}
      </div>

      {/* Inline form panel (create / edit) */}
      {mode !== "closed" && (
        <form
          onSubmit={handleSubmit}
          className="mb-[10px] bg-panel border border-line rounded-[6px] px-[16px] py-[14px]"
        >
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-[13px] font-semibold text-ink">
              {mode === "create"
                ? t("pages.controlCenter.profiles.formTitleCreate")
                : t("pages.controlCenter.profiles.formTitleEdit", {
                    id: form.id,
                  })}
            </h4>
            <button
              type="button"
              onClick={closeForm}
              className="text-[12px] text-ink-4 hover:text-ink-2 transition-colors"
            >
              {t("pages.controlCenter.profiles.cancelButton")}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-[14px] gap-y-[12px]">
            {/* ID — editable only in create mode */}
            <div>
              <label className={labelClass} htmlFor="rpf-id">
                {t("pages.controlCenter.profiles.fieldId")}
              </label>
              <input
                id="rpf-id"
                type="text"
                value={form.id}
                onChange={(e) => handleFieldChange("id", e.target.value)}
                disabled={mode === "edit" || submitting}
                placeholder={t("pages.controlCenter.profiles.fieldIdPlaceholder")}
                className={inputClass}
                autoComplete="off"
                spellCheck={false}
              />
              <p className={hintClass}>
                {t("pages.controlCenter.profiles.fieldIdHint")}
              </p>
            </div>

            {/* Type */}
            <div>
              <label className={labelClass} htmlFor="rpf-type">
                {t("pages.controlCenter.profiles.fieldType")}
              </label>
              <select
                id="rpf-type"
                value={form.type}
                onChange={(e) => {
                  // rc-2: no `as` bypass — narrow via runtime check.
                  // The select only emits "openclaw" | "pi-ai", but we guard
                  // defensively so the value is provably ProfileType.
                  const v = e.target.value;
                  const typed: ProfileType = v === "pi-ai" ? "pi-ai" : "openclaw";
                  handleFieldChange("type", typed);
                }}
                disabled={mode === "edit" || submitting}
                className={inputClass}
              >
                <option value="openclaw">
                  {t("pages.controlCenter.profiles.typeOpenclaw")}
                </option>
                <option value="pi-ai">
                  {t("pages.controlCenter.profiles.typePiAi")}
                </option>
              </select>
              {mode === "edit" && (
                <p className={hintClass}>
                  {t("pages.controlCenter.profiles.fieldIdHint")}
                </p>
              )}
            </div>

            {/* pi-ai fields */}
            {form.type === "pi-ai" && (
              <>
                <div>
                  <label className={labelClass} htmlFor="rpf-provider">
                    {t("pages.controlCenter.profiles.fieldProvider")}
                  </label>
                  <input
                    id="rpf-provider"
                    type="text"
                    value={form.provider}
                    onChange={(e) =>
                      handleFieldChange("provider", e.target.value)
                    }
                    disabled={submitting}
                    placeholder={t(
                      "pages.controlCenter.profiles.fieldProviderPlaceholder",
                    )}
                    className={inputClass}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="rpf-model">
                    {t("pages.controlCenter.profiles.fieldModel")}
                  </label>
                  <input
                    id="rpf-model"
                    type="text"
                    value={form.model}
                    onChange={(e) => handleFieldChange("model", e.target.value)}
                    disabled={submitting}
                    placeholder={t(
                      "pages.controlCenter.profiles.fieldModelPlaceholder",
                    )}
                    className={inputClass}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="rpf-apikeyenv">
                    {t("pages.controlCenter.profiles.fieldApiKeyEnv")}
                  </label>
                  <input
                    id="rpf-apikeyenv"
                    type="text"
                    value={form.apiKeyEnv}
                    onChange={(e) =>
                      handleFieldChange("apiKeyEnv", e.target.value)
                    }
                    disabled={submitting}
                    placeholder={t(
                      "pages.controlCenter.profiles.fieldApiKeyEnvPlaceholder",
                    )}
                    className={cn(inputClass, "font-mono")}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className={hintClass}>
                    {t("pages.controlCenter.profiles.fieldApiKeyEnvHint")}
                  </p>
                </div>
                <div>
                  <label className={labelClass} htmlFor="rpf-baseurl">
                    {t("pages.controlCenter.profiles.fieldBaseUrl")}
                  </label>
                  <input
                    id="rpf-baseurl"
                    type="text"
                    value={form.baseUrl}
                    onChange={(e) =>
                      handleFieldChange("baseUrl", e.target.value)
                    }
                    disabled={submitting}
                    placeholder={t(
                      "pages.controlCenter.profiles.fieldBaseUrlPlaceholder",
                    )}
                    className={inputClass}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </>
            )}

            {/* openclaw fields */}
            {form.type === "openclaw" && (
              <>
                <div>
                  <label className={labelClass} htmlFor="rpf-source">
                    {t("pages.controlCenter.profiles.fieldSource")}
                  </label>
                  <input
                    id="rpf-source"
                    type="text"
                    value={form.source}
                    onChange={(e) =>
                      handleFieldChange("source", e.target.value)
                    }
                    disabled={submitting}
                    placeholder={t(
                      "pages.controlCenter.profiles.fieldSourcePlaceholder",
                    )}
                    className={inputClass}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="rpf-provider-oc">
                    {t("pages.controlCenter.profiles.fieldProvider")}
                  </label>
                  <input
                    id="rpf-provider-oc"
                    type="text"
                    value={form.provider}
                    onChange={(e) =>
                      handleFieldChange("provider", e.target.value)
                    }
                    disabled={submitting}
                    placeholder={t(
                      "pages.controlCenter.profiles.fieldProviderPlaceholder",
                    )}
                    className={inputClass}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="rpf-model-oc">
                    {t("pages.controlCenter.profiles.fieldModel")}
                  </label>
                  <input
                    id="rpf-model-oc"
                    type="text"
                    value={form.model}
                    onChange={(e) => handleFieldChange("model", e.target.value)}
                    disabled={submitting}
                    placeholder={t(
                      "pages.controlCenter.profiles.fieldModelPlaceholder",
                    )}
                    className={inputClass}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </>
            )}
          </div>

          {/* Inline validation / server error */}
          {formError !== null && (
            <div className="mt-3 px-[12px] py-[8px] border border-red/35 rounded-[4px] bg-red/10 text-[12px] text-red font-mono">
              {formError}
            </div>
          )}

          {/* Form actions */}
          <div className="mt-3 flex items-center gap-[8px]">
            <button
              type="submit"
              disabled={submitting}
              className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
            >
              {submitting
                ? mode === "create"
                  ? t("pages.controlCenter.profiles.creating")
                  : t("pages.controlCenter.profiles.saving")
                : t("pages.controlCenter.profiles.saveButton")}
            </button>
            <button
              type="button"
              onClick={closeForm}
              disabled={submitting}
              className="border border-line bg-surface text-ink-3 rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:border-line-2 hover:text-ink transition-colors disabled:opacity-50"
            >
              {t("pages.controlCenter.profiles.cancelButton")}
            </button>
          </div>
        </form>
      )}

      {/* Profile table */}
      {profiles.length === 0 ? (
        <div className="bg-surface border border-line-2 rounded-[4px] px-[16px] py-[14px] text-[12.5px] text-ink-4 italic">
          {t("pages.controlCenter.profiles.empty")}
        </div>
      ) : (
        <div className="bg-surface border border-line-2 rounded-[4px] overflow-hidden">
          {/* Header row */}
          <div className="grid grid-cols-[12px_1fr_84px_1fr_1fr_1fr_auto] gap-[10px] items-center px-[16px] py-[9px] bg-paper-2 border-b border-line-2 font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-4">
            <span />
            <span>{t("pages.controlCenter.profiles.columnId")}</span>
            <span>{t("pages.controlCenter.profiles.columnType")}</span>
            <span>{t("pages.controlCenter.profiles.columnProvider")}</span>
            <span>{t("pages.controlCenter.profiles.columnModel")}</span>
            <span>{t("pages.controlCenter.profiles.columnApiKeyEnv")}</span>
            <span className="text-right">
              {t("pages.controlCenter.profiles.columnActions")}
            </span>
          </div>

          {/* Body rows */}
          {profiles.map((p) => {
            const isDefault = p.id === defaultRuntimeId;
            const isDeleteTarget = deleteTarget === p.id;
            return (
              <div
                key={p.id}
                className="border-b border-line-2 last:border-b-0"
              >
                <div className="grid grid-cols-[12px_1fr_84px_1fr_1fr_1fr_auto] gap-[10px] items-center px-[16px] py-[10px] text-[12.5px]">
                  {/* readiness dot */}
                  <div
                    className={readinessDotClasses(p.readiness)}
                    aria-label={enumLabel("readiness", p.readiness, t)}
                    title={enumLabel("readiness", p.readiness, t)}
                  />
                  {/* id */}
                  <div className="min-w-0 flex items-center gap-[6px]">
                    <span className="font-mono text-[12px] text-ink truncate">
                      {p.id}
                    </span>
                    {isDefault && (
                      <span className="shrink-0 text-[9.5px] font-mono px-[5px] py-[1px] rounded-[2px] bg-gov/10 text-gov border border-gov/22 tracking-[0.02em]">
                        default
                      </span>
                    )}
                  </div>
                  {/* type */}
                  <span className="font-mono text-[11.5px] text-ink-3">
                    {p.type}
                  </span>
                  {/* provider */}
                  <span className="text-ink-3 truncate">
                    {p.provider ?? "—"}
                  </span>
                  {/* model */}
                  <span className="text-ink-3 truncate">
                    {p.model ?? "—"}
                  </span>
                  {/* apiKeyEnv */}
                  <span className="font-mono text-[11.5px] text-ink-3 truncate">
                    {p.apiKeyEnv ?? "—"}
                  </span>
                  {/* actions */}
                  <div className="flex items-center justify-end gap-[6px]">
                    <button
                      type="button"
                      onClick={() => openEdit(p)}
                      disabled={mode !== "closed" || deleting}
                      className="text-[11.5px] px-[10px] py-[4px] rounded-[3px] border border-line bg-surface text-ink-3 hover:border-line-2 hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {t("pages.controlCenter.profiles.editButton")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteTarget(p.id);
                        setDeleteError(null);
                      }}
                      disabled={
                        mode !== "closed" ||
                        deleting ||
                        deleteTarget !== null
                      }
                      className="text-[11.5px] px-[10px] py-[4px] rounded-[3px] border border-line bg-surface text-ink-3 hover:border-red/40 hover:text-red transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {t("pages.controlCenter.profiles.deleteButton")}
                    </button>
                  </div>
                </div>

                {/* Inline delete confirmation bar */}
                {isDeleteTarget && (
                  <div className="px-[16px] pb-[12px]">
                    <div className="px-[12px] py-[10px] border border-danger rounded-[4px] bg-danger/10 text-[12px] text-ink-2 leading-[1.55]">
                      <div className="font-medium">
                        {t("pages.controlCenter.profiles.deleteConfirmMessage", {
                          id: p.id,
                        })}
                      </div>
                      {isDefault && (
                        <div className="mt-1 text-ink-3">
                          {t("pages.controlCenter.profiles.sectionDescription")}
                        </div>
                      )}
                      {deleteError !== null && (
                        <div className="mt-2 font-mono text-[11.5px] text-red">
                          {deleteError}
                        </div>
                      )}
                      <div className="mt-2 flex gap-[8px]">
                        <button
                          type="button"
                          onClick={handleDeleteConfirm}
                          disabled={deleting}
                          className="text-[11.5px] px-[12px] py-[4px] rounded-[3px] border border-transparent bg-danger text-paper font-medium hover:opacity-90 transition-opacity disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                        >
                          {deleting
                            ? t("pages.controlCenter.profiles.deleting")
                            : t("pages.controlCenter.profiles.deleteConfirmAck")}
                        </button>
                        <button
                          type="button"
                          onClick={handleDeleteCancel}
                          disabled={deleting}
                          className="text-[11.5px] px-[12px] py-[4px] rounded-[3px] border border-line bg-transparent text-ink-3 hover:border-line-2 transition-colors disabled:opacity-50"
                        >
                          {t("pages.controlCenter.profiles.deleteConfirmCancel")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
