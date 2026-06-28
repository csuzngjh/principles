import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import {
  fetchConfigSummary,
  fetchConfigCatalog,
  updateAgentBinding,
  updateDefaultRuntime,
} from "../../api.js";
import type {
  ConfigSummaryData,
  ConfigCatalogData,
  RedactedAgentSummary,
  RedactedRuntimeProfileSummary,
  RedactedFeatureSummary,
  ReadinessStatus,
} from "../../api.js";
import {
  computeOverallReadiness,
  groupAgentsByReadiness,
  groupAgentsByDependency,
  isKnownAgentName,
  redactDiagnosticsForCopy,
} from "../../utils/control-center-helpers.js";
import { enumLabel } from "../../utils/enum-labels.js";
import type { ControlCenterDiagnostics } from "../../utils/control-center-helpers.js";
import { EmpathyObserverCostHint } from "./EmpathyObserverCostHint.js";
import { WorkflowDiagram } from "./WorkflowDiagram.js";
import { AgentGroup } from "./AgentGroup.js";
import { AgentCard, type AgentLocale } from "./AgentCard.js";
import {
  AGENT_GROUPS,
  AGENT_METADATA,
} from "../../utils/agent-metadata.js";

// ── Runtime validators (H section / ERR-001/005/009/013) ─────────────────────

function validateSource(raw: unknown): "defaults" | "user_config" | null {
  if (typeof raw !== "string") return null;
  switch (raw) {
    case "defaults": return "defaults";
    case "user_config": return "user_config";
    default: return null;
  }
}

/** Type guard: is this a non-null object with own properties (not inherited)? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateReadinessStatus(raw: unknown): ReadinessStatus | null {
  if (typeof raw !== "string") return null;
  switch (raw) {
    case "ready": return "ready";
    case "not_ready": return "not_ready";
    case "needs_setup": return "needs_setup";
    case "disabled": return "disabled";
    case "unknown": return "unknown";
    default: return null;
  }
}

function validateRedactedFeatureSummary(
  raw: unknown,
): RedactedFeatureSummary | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "id") ||
    !Object.hasOwn(raw, "category") ||
    !Object.hasOwn(raw, "enabled")
  ) {
    return null;
  }
  const id = raw.id;
  const category = raw.category;
  const enabled = raw.enabled;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof category !== "string" ||
    typeof enabled !== "boolean"
  ) {
    return null;
  }
  return { id, category, enabled };
}

function validateRedactedRuntimeProfileSummary(
  raw: unknown,
): RedactedRuntimeProfileSummary | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "id") ||
    !Object.hasOwn(raw, "type") ||
    !Object.hasOwn(raw, "label") ||
    !Object.hasOwn(raw, "readiness")
  ) {
    return null;
  }
  const id = raw.id;
  const type = raw.type;
  const label = raw.label;
  const readiness = validateReadinessStatus(raw.readiness);
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof type !== "string" ||
    typeof label !== "string" ||
    readiness === null
  ) {
    return null;
  }
  const apiKeyEnv =
    Object.hasOwn(raw, "apiKeyEnv") && typeof raw.apiKeyEnv === "string"
      ? raw.apiKeyEnv
      : undefined;
  // provider/model are optional (set by backend redactPdConfig for both
  // pi-ai and openclaw profiles). Extract so EmpathyObserverCostHint can
  // show the active model without parsing the label string. Aligns with
  // the canonical validator in validators.ts (EP-01: validate fields that
  // actually exist in the target type).
  const provider =
    Object.hasOwn(raw, "provider") && typeof raw.provider === "string"
      ? raw.provider
      : undefined;
  const model =
    Object.hasOwn(raw, "model") && typeof raw.model === "string"
      ? raw.model
      : undefined;
  return { id, type, label, apiKeyEnv, provider, model, readiness };
}

function validateRedactedAgentSummary(
  raw: unknown,
): RedactedAgentSummary | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "name") ||
    !Object.hasOwn(raw, "enabled") ||
    !Object.hasOwn(raw, "runtimeProfileId") ||
    !Object.hasOwn(raw, "runtimeProfileLabel") ||
    !Object.hasOwn(raw, "readiness")
  ) {
    return null;
  }
  const name = raw.name;
  const enabled = raw.enabled;
  const runtimeProfileId = raw.runtimeProfileId;
  const runtimeProfileLabel = raw.runtimeProfileLabel;
  const readiness = validateReadinessStatus(raw.readiness);
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    typeof enabled !== "boolean" ||
    typeof runtimeProfileId !== "string" ||
    typeof runtimeProfileLabel !== "string" ||
    readiness === null
  ) {
    return null;
  }
  return { name, enabled, runtimeProfileId, runtimeProfileLabel, readiness };
}

function validateConfigError(
  raw: unknown,
): { path: string; reason: string; nextAction: string } | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "path") ||
    !Object.hasOwn(raw, "reason") ||
    !Object.hasOwn(raw, "nextAction")
  ) {
    return null;
  }
  const path = raw.path;
  const reason = raw.reason;
  const nextAction = raw.nextAction;
  if (
    typeof path !== "string" ||
    typeof reason !== "string" ||
    typeof nextAction !== "string"
  ) {
    return null;
  }
  return { path, reason, nextAction };
}

function validateConfigSummaryData(
  raw: unknown,
): ConfigSummaryData | null {
  if (!isRecord(raw)) return null;
  // Required fields check (ERR-009: fail loud on missing required fields)
  if (
    !Object.hasOwn(raw, "version") ||
    !Object.hasOwn(raw, "source") ||
    !Object.hasOwn(raw, "features") ||
    !Object.hasOwn(raw, "runtimeProfiles") ||
    !Object.hasOwn(raw, "defaultRuntime") ||
    !Object.hasOwn(raw, "agents") ||
    !Object.hasOwn(raw, "ui") ||
    !Object.hasOwn(raw, "warnings")
  ) {
    return null;
  }

  const version = raw.version;
  const source = raw.source;
  const features = raw.features;
  const runtimeProfiles = raw.runtimeProfiles;
  const defaultRuntime = raw.defaultRuntime;
  const agents = raw.agents;
  const ui = raw.ui;
  const warnings = raw.warnings;

  if (
    typeof version !== "number" ||
    typeof source !== "string" ||
    validateSource(source) === null ||
    !Array.isArray(features) ||
    !Array.isArray(runtimeProfiles) ||
    typeof defaultRuntime !== "string" ||
    !Array.isArray(agents) ||
    !isRecord(ui) ||
    !Array.isArray(warnings)
  ) {
    return null;
  }

  // Validate ui.diagnostics (ERR-009)
  if (
    !Object.hasOwn(ui, "diagnostics") ||
    !isRecord(ui.diagnostics)
  ) {
    return null;
  }
  const uiDiag = ui.diagnostics;
  if (!Object.hasOwn(uiDiag, "mode") || typeof uiDiag.mode !== "string") {
    return null;
  }
  const uiDiagMode: string = uiDiag.mode;

  // Validate features array elements (ERR-005/ERR-007)
  const validatedFeatures: RedactedFeatureSummary[] = [];
  for (const f of features) {
    const validated = validateRedactedFeatureSummary(f);
    if (validated === null) return null;
    validatedFeatures.push(validated);
  }

  // Validate runtime profiles array elements
  const validatedProfiles: RedactedRuntimeProfileSummary[] = [];
  for (const p of runtimeProfiles) {
    const validated = validateRedactedRuntimeProfileSummary(p);
    if (validated === null) return null;
    validatedProfiles.push(validated);
  }

  // Validate agents array elements
  const validatedAgents: RedactedAgentSummary[] = [];
  for (const a of agents) {
    const validated = validateRedactedAgentSummary(a);
    if (validated === null) return null;
    validatedAgents.push(validated);
  }

  // Validate warnings array elements (ERR-005)
  const validatedWarnings: string[] = [];
  for (const w of warnings) {
    if (typeof w !== "string") return null;
    validatedWarnings.push(w);
  }

  // Validate optional errors array
  let validatedErrors:
    | { path: string; reason: string; nextAction: string }[]
    | undefined;
  if (Object.hasOwn(raw, "errors") && raw.errors !== undefined) {
    if (!Array.isArray(raw.errors)) return null;
    validatedErrors = [];
    for (const e of raw.errors) {
      const validated = validateConfigError(e);
      if (validated === null) return null;
      validatedErrors.push(validated);
    }
  }

  const validatedSource = validateSource(source);
  if (validatedSource === null) return null;

  return {
    version,
    source: validatedSource,
    features: validatedFeatures,
    runtimeProfiles: validatedProfiles,
    defaultRuntime,
    agents: validatedAgents,
    ui: {
      diagnostics: {
        mode: uiDiagMode,
      },
    },
    warnings: validatedWarnings,
    errors: validatedErrors,
  };
}

function validateConfigCatalogData(
  raw: unknown,
): ConfigCatalogData | null {
  if (!isRecord(raw)) return null;
  if (!Object.hasOwn(raw, "profiles")) return null;

  const profiles = raw.profiles;
  if (!Array.isArray(profiles)) return null;

  const validatedProfiles: RedactedRuntimeProfileSummary[] = [];
  for (const p of profiles) {
    const validated = validateRedactedRuntimeProfileSummary(p);
    if (validated === null) return null;
    validatedProfiles.push(validated);
  }

  // Validate optional errors array
  let validatedErrors:
    | { path: string; reason: string; nextAction: string }[]
    | undefined;
  if (Object.hasOwn(raw, "errors") && raw.errors !== undefined) {
    if (!Array.isArray(raw.errors)) return null;
    validatedErrors = [];
    for (const e of raw.errors) {
      const validated = validateConfigError(e);
      if (validated === null) return null;
      validatedErrors.push(validated);
    }
  }

  return { profiles: validatedProfiles, errors: validatedErrors };
}

// ── Readiness tag styling ────────────────────────────────────────────────────

function readinessTagClasses(readiness: ReadinessStatus): string {
  const base =
    "inline-flex items-center border border-line rounded-[2px] px-[7px] py-1 font-mono text-[11px] text-ink-3 bg-surface/80 uppercase";
  switch (readiness) {
    case "ready":
      return base;
    case "needs_setup":
      return base.replace("border-line", "border-amber/35").replace("text-ink-3", "text-amber");
    case "not_ready":
      return base.replace("border-line", "border-red/35").replace("text-ink-3", "text-red");
    default:
      return base;
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

/**
 * CompactStatusBar — 紧凑状态条（替代 OverallStatusCard）
 *
 * 取自原型 control-center.html 第 153-168 行。一行展示：
 * 已启用 N/M · 未就绪 N 项 · 核心管道 状态 · [需配置] pill
 *
 * 核心管道状态 = core_trio + code_chain 中已启用代理的就绪情况：
 * - paralyzed: core_trio 任一 disabled 或有 not_ready
 * - degraded: 有 needs_setup
 * - ok: 全 ready
 *
 * rc-2: 用 Object.hasOwn 守卫 agent.name 查 AGENT_METADATA（无 as 绕过）
 */
function CompactStatusBar({
  readiness,
  agents,
}: {
  readiness: ReadinessStatus;
  agents: RedactedAgentSummary[];
}) {
  const { t } = useTranslation();

  const enabledCount = agents.filter((a) => a.enabled).length;
  const totalCount = agents.length;
  const notReadyCount = agents.filter(
    (a) => a.enabled && a.readiness !== "ready",
  ).length;

  // 核心管道状态：core_trio + code_chain 中已启用代理
  // rc-2: 用 isKnownAgentName 类型守卫缩窄，不用 as 绕过
  const coreAgents = agents.filter((a) => {
    if (!isKnownAgentName(a.name)) return false;
    const meta = AGENT_METADATA[a.name];
    return meta.group === "core_trio" || meta.group === "code_chain";
  });

  const enabledCoreAgents = coreAgents.filter((a) => a.enabled);
  const coreTrioAgents = coreAgents.filter((a) => {
    if (!isKnownAgentName(a.name)) return false;
    const meta = AGENT_METADATA[a.name];
    return meta.group === "core_trio";
  });
  const codeChainAgents = coreAgents.filter((a) => {
    if (!isKnownAgentName(a.name)) return false;
    const meta = AGENT_METADATA[a.name];
    return meta.group === "code_chain";
  });
  const coreTrioAnyDisabled = coreTrioAgents.some((a) => !a.enabled);
  const codeChainAnyDisabled = codeChainAgents.some((a) => !a.enabled);
  const coreAnyNotReady = enabledCoreAgents.some(
    (a) => a.readiness === "not_ready",
  );
  const coreAnyNeedsSetup = enabledCoreAgents.some(
    (a) => a.readiness === "needs_setup",
  );

  // 状态优先级（per AGENT_METADATA.impactZh）:
  // - paralyzed: core_trio 任一 disabled 或 enabled 但 not_ready
  //   （core_trio 是入口，关掉任何一个整个管道瘫痪）
  // - degraded: code_chain 任一 disabled（降级运行，非瘫痪）
  //             或 enabled 但 needs_setup
  // - ok: 全 ready
  //
  // needsConfig 标记仅用于 readiness 异常（not_ready / needs_setup），
  // 不用于主动 disabled — 主动 disable 是 owner 的有意决策，不是配置缺失。
  let corePipelineKey: string;
  const needsConfig = coreAnyNotReady || coreAnyNeedsSetup;
  if (coreTrioAnyDisabled || coreAnyNotReady) {
    corePipelineKey = "pages.controlCenter.status.corePipelineParalyzed";
  } else if (codeChainAnyDisabled || coreAnyNeedsSetup) {
    corePipelineKey = "pages.controlCenter.status.corePipelineDegraded";
  } else {
    corePipelineKey = "pages.controlCenter.status.corePipelineOk";
  }

  return (
    <div className="mt-5 px-[16px] py-[11px] bg-surface border border-line-2 rounded-[4px] flex items-center gap-[16px] text-[12.5px] text-ink-3 flex-wrap">
      <div className="flex items-center gap-[6px]">
        <span className="text-ink-4 font-mono text-[11px] uppercase tracking-[0.04em]">
          {t("pages.controlCenter.status.enabled")}
        </span>
        <span className="text-ink font-semibold">
          <span className="font-mono">{enabledCount}</span> /{" "}
          <span className="font-mono">{totalCount}</span>
        </span>
      </div>
      <div className="flex items-center gap-[6px]">
        <span className="text-ink-4 font-mono text-[11px] uppercase tracking-[0.04em]">
          {t("pages.controlCenter.status.notReady")}
        </span>
        <span className="text-ink font-semibold">
          <span className="font-mono">{notReadyCount}</span>
        </span>
      </div>
      <div className="flex items-center gap-[6px]">
        <span className="text-ink-4 font-mono text-[11px] uppercase tracking-[0.04em]">
          {t("pages.controlCenter.status.corePipeline")}
        </span>
        <span className="text-ink font-semibold">{t(corePipelineKey)}</span>
      </div>
      {needsConfig && (
        <span className="ml-auto px-[9px] py-[3px] rounded-[2px] text-[10.5px] font-mono tracking-[0.02em] font-medium border border-amber text-amber bg-amber/10">
          {t("pages.controlCenter.status.needsConfig")}
        </span>
      )}
    </div>
  );
}

function DefaultRuntimeSelector({
  currentDefault,
  profiles,
  onDefaultChange,
  saving,
}: {
  currentDefault: string;
  profiles: RedactedRuntimeProfileSummary[];
  onDefaultChange: (profileId: string) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="bg-panel border border-line rounded-[6px] px-[18px] py-[14px]">
      <p className="text-ink-3 text-[13px] leading-relaxed mb-3">
        {t("pages.controlCenter.defaultRuntimeDescription")}
      </p>
      <select
        value={currentDefault}
        onChange={(e) => {
          onDefaultChange(e.target.value);
        }}
        disabled={saving}
        className="bg-surface border border-line rounded-[3px] px-3 py-[6px] text-[12.5px] text-ink focus:outline-none focus:border-gov disabled:opacity-50 min-w-[200px]"
        aria-label={t("pages.controlCenter.defaultRuntime")}
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} — {enumLabel('readiness', p.readiness, t)}
          </option>
        ))}
      </select>
      {saving && (
        <span className="ml-3 text-ink-3 text-[12px]">
          {t("pages.controlCenter.saving")}
        </span>
      )}
    </div>
  );
}

function AdvancedDiagnostics({
  config,
}: {
  config: ConfigSummaryData;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const diagnostics: ControlCenterDiagnostics = {
    version: config.version,
    source: config.source,
    features: config.features,
    runtimeProfiles: config.runtimeProfiles,
    defaultRuntime: config.defaultRuntime,
    agents: config.agents,
    ui: config.ui,
    warnings: config.warnings,
    errors: config.errors,
  };

  const handleCopy = useCallback(() => {
    const text = redactDiagnosticsForCopy(diagnostics);
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        toast.success(t("pages.controlCenter.copyDiagnostics"));
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        toast.error(t("pages.controlCenter.saveFailed"));
      },
    );
  }, [diagnostics, t]);

  const grouped = groupAgentsByReadiness(diagnostics);

  return (
    <details className="group">
      <summary className="text-ink-3 text-[13px] cursor-pointer hover:text-ink-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2">
        {t("pages.controlCenter.advancedDiagnostics")}
      </summary>

      <div className="mt-4 space-y-5">
        {/* Features */}
        <div>
          <h3 className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-2">
            {t("pages.controlCenter.features")}
          </h3>
          <div className="bg-surface/60 border border-line rounded-[6px] px-3 py-2">
            {config.features.length === 0 ? (
              <span className="text-ink-4 text-[13px]">—</span>
            ) : (
              <div className="space-y-1">
                {config.features.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center gap-2 text-[13px]"
                  >
                    <span className="text-ink-2">{enumLabel('featureId', f.id, t)}</span>
                    <span className="text-ink-4">·</span>
                    <span className="text-ink-3">{enumLabel('featureCategory', f.category, t)}</span>
                    <span className="text-ink-4">·</span>
                    <span
                      className={
                        f.enabled ? "text-ink-2" : "text-ink-4 line-through"
                      }
                    >
                      {f.enabled
                        ? t("pages.controlCenter.on")
                        : t("pages.controlCenter.off")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Runtime Profiles */}
        <div>
          <h3 className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-2">
            {t("pages.controlCenter.runtimeProfiles")}
          </h3>
          <div className="bg-surface/60 border border-line rounded-[6px] px-3 py-2">
            {config.runtimeProfiles.length === 0 ? (
              <span className="text-ink-4 text-[13px]">—</span>
            ) : (
              <div className="space-y-1">
                {config.runtimeProfiles.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-2 text-[13px]"
                  >
                    <span className="text-ink-2">{p.label}</span>
                    <span className="text-ink-4">·</span>
                    <span className="text-ink-3">{p.type}</span>
                    <span className={readinessTagClasses(p.readiness)}>
                      {enumLabel('readiness', p.readiness, t)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Warnings */}
        {config.warnings.length > 0 && (
          <div>
            <h3 className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-2">
              {t("pages.controlCenter.warnings")}
            </h3>
            <div className="bg-surface/60 border border-amber/20 border-l-2 border-l-amber rounded-[6px] px-3 py-2">
              <ul className="space-y-1">
                {config.warnings.map((w, i) => (
                  <li key={i} className="text-ink-2 text-[13px]">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Config Errors */}
        {config.errors && config.errors.length > 0 && (
          <div>
            <h3 className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-2">
              {t("pages.controlCenter.configErrors")}
            </h3>
            <div className="bg-surface/60 border border-red/20 border-l-2 border-l-red rounded-[6px] px-3 py-2">
              <ul className="space-y-2">
                {config.errors.map((e, i) => (
                  <li key={i} className="text-[13px]">
                    <span className="text-ink font-medium">{e.path}</span>
                    <span className="text-ink-4"> — </span>
                    <span className="text-ink-2">{e.reason}</span>
                    <div className="text-ink-3 text-[12px] mt-0.5">
                      → {e.nextAction}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Agent readiness breakdown */}
        <div>
          <h3 className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-2">
            {t("pages.controlCenter.readinessLabel")}
          </h3>
          <div className="bg-surface/60 border border-line rounded-[6px] px-3 py-2 space-y-2">
            {Object.keys(grouped).map((status) => {
              const validatedStatus = validateReadinessStatus(status);
              if (validatedStatus === null) return null;
              const agentsInGroup = grouped[validatedStatus];
              if (agentsInGroup.length === 0) return null;
              return (
                <div key={validatedStatus} className="flex items-center gap-2">
                  <span className={readinessTagClasses(validatedStatus)}>
                    {enumLabel('readiness', validatedStatus, t)}
                  </span>
                  <span className="text-ink-3 text-[13px]">
                    {agentsInGroup.map((a) => a.name).join(", ")}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Copy button */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleCopy}
            className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {copied ? "✓" : t("pages.controlCenter.copyDiagnostics")}
          </button>
          <span className="text-ink-4 text-[12px]">
            {t("pages.controlCenter.redactedNote")}
          </span>
        </div>
      </div>
    </details>
  );
}

// ── Main page component ──────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded" | "error";

export function ControlCenterPage() {
  const { t, i18n } = useTranslation();
  const [configData, setConfigData] = useState<ConfigSummaryData | null>(null);
  const [catalogData, setCatalogData] = useState<ConfigCatalogData | null>(
    null,
  );
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savingAgent, setSavingAgent] = useState<string | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);

  const loadData = useCallback(async () => {
    setLoadingState("loading");
    setErrorMessage(null);

    const [summaryResult, catalogResult] = await Promise.all([
      fetchConfigSummary(),
      fetchConfigCatalog(),
    ]);

    // Validate summary data (H section / ERR-001/005/009)
    if (!summaryResult.success) {
      setLoadingState("error");
      setErrorMessage(summaryResult.error);
      return;
    }
    const validatedSummary = validateConfigSummaryData(summaryResult.data);
    if (validatedSummary === null) {
      setLoadingState("error");
      setErrorMessage("Config summary data has unexpected shape");
      return;
    }
    setConfigData(validatedSummary);

    // Validate catalog data (ERR-002: degradation with reason)
    if (!catalogResult.success) {
      // Non-fatal: catalog is only needed for profile dropdowns
      setCatalogData(null);
    } else {
      const validatedCatalog = validateConfigCatalogData(catalogResult.data);
      setCatalogData(validatedCatalog);
    }

    setLoadingState("loaded");
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleBindingChange = useCallback(
    async (agentName: string, runtimeProfile: string, enabled: boolean) => {
      setSavingAgent(agentName);
      const result = await updateAgentBinding(agentName, runtimeProfile, enabled);
      setSavingAgent(null);

      if (!result.success) {
        toast.error(t("pages.controlCenter.saveFailed"));
        return;
      }

      // Refresh config data after successful update
      await loadData();
    },
    [loadData, t],
  );

  const handleDefaultRuntimeChange = useCallback(
    async (profileId: string) => {
      setSavingDefault(true);
      const result = await updateDefaultRuntime(profileId);
      setSavingDefault(false);

      if (!result.success) {
        toast.error(t("pages.controlCenter.saveFailed"));
        return;
      }

      // Refresh config data after successful update
      await loadData();
    },
    [loadData, t],
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
          {t("pages.controlCenter.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.controlCenter.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.controlCenter.loadError")}</p>
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
  if (configData === null) {
    return (
      <PageShell>
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.controlCenter.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.controlCenter.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.controlCenter.loadError")}</p>
        </div>
      </PageShell>
    );
  }

  const diagnostics: ControlCenterDiagnostics = {
    version: configData.version,
    source: configData.source,
    features: configData.features,
    runtimeProfiles: configData.runtimeProfiles,
    defaultRuntime: configData.defaultRuntime,
    agents: configData.agents,
    ui: configData.ui,
    warnings: configData.warnings,
    errors: configData.errors,
  };

  const overallReadiness = computeOverallReadiness(diagnostics);
  const availableProfiles =
    catalogData?.profiles ?? configData.runtimeProfiles;

  return (
    <PageShell>
      <div className="animate-[pdFadeIn_400ms_ease-out]">
      {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
      <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
        {t("pages.controlCenter.eyebrow")}
      </div>
      <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
        {t("pages.controlCenter.title")}
      </h1>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t("pages.controlCenter.subtitle")}
      </p>

      {/* Section 1: 行为回路图 + 紧凑状态条（替代 OverallStatusCard） */}
      <WorkflowDiagram />
      <CompactStatusBar
        readiness={overallReadiness}
        agents={configData.agents}
      />

      {/* Empathy Observer cost hint — spec 2026-06-27 §4.1
          Gate 1: only mount when empathyObserver is enabled AND localStorage
          has not acked. Gate 2 (inside the component) handles dismiss.
          Agent name is 'empathyObserver' (camelCase, per INTERNAL_AGENT_NAMES);
          'empathy_observer' (snake_case) is the featureId used for display. */}
      {(() => {
        const empathyAgent = configData.agents.find(
          (a) => a.name === "empathyObserver" && a.enabled,
        );
        if (!empathyAgent) return null;
        let acked = false;
        try {
          acked = localStorage.getItem("pd.empathyObserver.costAck") === "true";
        } catch {
          // localStorage unavailable (privacy mode) → not acked → render
        }
        if (acked) return null;
        return (
          <EmpathyObserverCostHint
            agent={empathyAgent}
            profiles={availableProfiles}
          />
        );
      })()}

      {/* Section 2: Internal Agents — 按依赖分组 */}
      <section className="mt-8" aria-labelledby="section-agents">
        <SectionTitle id="section-agents">
          {t("pages.controlCenter.internalAgents")}
        </SectionTitle>
        <p className="text-ink-3 text-[13px] leading-relaxed mb-3">
          {t("pages.controlCenter.internalAgentsDescription")}
        </p>
        {(() => {
          const { groups, unknown } = groupAgentsByDependency(
            configData.agents,
          );
          const locale: AgentLocale = i18n.language.startsWith("en")
            ? "en"
            : "zh-CN";
          return (
            <>
              {AGENT_GROUPS.map((groupMeta) => (
                <AgentGroup
                  key={groupMeta.id}
                  groupMeta={groupMeta}
                  agents={groups[groupMeta.id]}
                  profiles={availableProfiles}
                  onBindingChange={handleBindingChange}
                  saving={savingAgent}
                  locale={locale}
                />
              ))}
              {/* rc-9: 未知代理不静默 */}
              {unknown.length > 0 && (
                <div className="mt-3 px-3 py-2 border border-amber/30 border-l-2 border-l-amber rounded-[4px] bg-amber/10 text-[12.5px] text-ink-3">
                  {t("pages.controlCenter.unknownAgentsWarning", {
                    count: unknown.length,
                    names: unknown.map((a) => a.name).join(", "),
                  })}
                </div>
              )}
            </>
          );
        })()}
      </section>

      {/* Section 3: Default Runtime */}
      <section className="mt-8" aria-labelledby="section-default-runtime">
        <SectionTitle id="section-default-runtime">
          {t("pages.controlCenter.defaultRuntime")}
        </SectionTitle>
        <DefaultRuntimeSelector
          currentDefault={configData.defaultRuntime}
          profiles={availableProfiles}
          onDefaultChange={handleDefaultRuntimeChange}
          saving={savingDefault}
        />
      </section>

      {/* Section 4: Advanced Diagnostics — collapsible, low visual weight */}
      <section className="mt-8" aria-labelledby="section-diagnostics">
        <AdvancedDiagnostics config={configData} />
      </section>

      {/* Footer note */}
      <p className="mt-10 pt-[18px] border-t border-line-2 text-ink-4 text-[12px] leading-[1.6] max-w-[60ch] font-mono">
        {t("pages.controlCenter.footerNote")}
      </p>
      </div>
    </PageShell>
  );
}
