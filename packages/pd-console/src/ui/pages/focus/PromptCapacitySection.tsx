import { useTranslation } from "react-i18next";
import type {
  PromptInjectionBudgetStatus,
  PromptInjectionTargetHostName,
} from "../../../shared/prompt-injection-contract.js";

export interface PromptCapacitySectionProps {
  /** `groupedData.promptInjection` — absent means the surface is not rendered. */
  promptInjection: PromptInjectionBudgetStatus | undefined;
  /** Owner-selected target host; `null` means "not chosen yet". */
  promptTargetHost: PromptInjectionTargetHostName | null;
  onChangeHost: (host: PromptInjectionTargetHostName | null) => void;
}

/**
 * PRI-629 / PD_PROMPT_CAPACITY_V1 R-A1 / PRI-1066.
 *
 * Two independent responsibilities that used to share one early return:
 *
 * 1. The host picker — the ONLY way to request approvals while the injection
 *    route is unconfirmed (`ApprovalsConsoleModel` answers 422 without a
 *    chosen host). It must be reachable whenever a per-host breakdown exists,
 *    including the common non-starved `abstraction_layer_v1` OFF state.
 * 2. The starvation notice — shown only when a host cannot fit even ONE
 *    principle (`usedChars === 0 && truncated`). `truncated` alone is the
 *    normal rotation state and must never become a standing nag.
 */
export function PromptCapacitySection({
  promptInjection,
  promptTargetHost,
  onChangeHost,
}: PromptCapacitySectionProps) {
  const { t } = useTranslation();
  if (promptInjection === undefined || promptInjection.capacityStatus !== "unconfirmed") return null;
  const perHost = promptInjection.perHost ?? [];
  if (perHost.length === 0) return null;
  const starvedHosts = perHost.filter((entry) => entry.usedChars === 0 && entry.truncated);
  return (
    <>
      {starvedHosts.length > 0 && (
        <div
          className="mb-4 rounded-[3px] border border-amber/40 bg-amber/5 px-3 py-2 text-[12.5px] leading-relaxed text-amber"
          data-testid="prompt-capacity-unconfirmed-banner"
        >
          <p data-testid="prompt-capacity-summary">
            {t("pages.focus.promptCapacityStarved", {
              defaultValue: "{{count}} 个宿主当前的注入预算连一条原则都装不下，原则在这些宿主上不会生效。",
              count: starvedHosts.length,
            })}
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-ink-2" data-testid="prompt-capacity-details-toggle">
              {t("pages.focus.promptCapacityDetails", { defaultValue: "查看各宿主容量明细" })}
            </summary>
            <p className="mt-1 text-ink-2">
              {t("pages.focus.promptCapacityUnconfirmed", {
                defaultValue: "当前宿主容量未确认：本工作区适用的宿主会走不同的注入路由，以下数字未绑定具体宿主。",
              })}
            </p>
            <ul className="mt-1 list-disc pl-5">
              {perHost.map((entry) => (
                <li key={entry.hostKind} data-testid={`prompt-capacity-perhost-${entry.hostKind}`}>
                  {t("pages.focus.promptCapacityPerHostEntry", {
                    host: entry.hostKind === "openclaw" ? "OpenClaw" : entry.hostKind === "workbuddy" ? "WorkBuddy" : "Codex",
                    billing: entry.route === "shared_render"
                      ? t("pages.focus.promptCapacitySharedRoute")
                      : t("pages.focus.promptCapacityListRoute"),
                    used: entry.usedChars,
                    // PRI-1017: each host shows ITS OWN budget basis (runtime
                    // observation or its own honest fallback) — never the
                    // shared headline number.
                    budget: entry.budget ?? promptInjection.budget,
                    // PRI-1066: `truncated` never means "the budget is full
                    // forever". On the rotating list route the entries that
                    // did not fit are queued for later turns; only the
                    // non-rotating shared render genuinely stops here.
                    full: entry.truncated
                      ? entry.route === "legacy_trim"
                        ? t("pages.focus.promptCapacityPerHostRotating")
                        : t("pages.focus.promptCapacityPerHostFull")
                      : "",
                    observed: entry.budgetObservedAt !== undefined
                      ? t("pages.focus.promptCapacityPerHostObserved", {
                          defaultValue: "（预算来自该宿主最近一次运行时观测，观测于 {{observedAt}}）",
                          observedAt: entry.budgetObservedAt,
                        })
                      // PRI-1020: a declared basis is the Owner's own config
                      // fact — label it as a declaration, never as an
                      // observation.
                      : entry.budgetCapacitySource === "operator_declared"
                        ? t("pages.focus.promptCapacityPerHostDeclared", {
                            defaultValue: "（预算来自工作区配置声明）",
                          })
                        // PRI-1066: a name-only catalog match is a derived
                        // window, not a host observation — say which.
                        : entry.budgetCapacitySource === "pi_catalog_model_id"
                          ? t("pages.focus.promptCapacityPerHostCatalogMatched", {
                              defaultValue: "（预算按模型目录同名一致窗口推算）",
                            })
                          : "",
                  })}
                  {entry.budgetFallbackReason !== undefined && (
                    <span data-testid={`prompt-capacity-perhost-reason-${entry.hostKind}`}>
                      {" · "}
                      {t(`pages.focus.budgetFallbackReason.${entry.budgetFallbackReason}`, {
                        defaultValue: entry.budgetFallbackReason,
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </details>
          {promptInjection.nextAction !== undefined && (
            <p className="mt-1 text-ink-2">{promptInjection.nextAction}</p>
          )}
        </div>
      )}
      <div
        className="mb-4 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2"
        data-testid="prompt-capacity-host-picker"
      >
        <span>{t("pages.focus.promptCapacityPickHint", {
          defaultValue: "按目标宿主查看/审批：",
        })}</span>
        {(["openclaw", "codex", "workbuddy"] as const).map((host) => (
          <button
            key={host}
            type="button"
            onClick={() => onChangeHost(host)}
            data-testid={`prompt-capacity-pick-${host}`}
            className={`inline-flex items-center border rounded-[3px] px-[10px] py-[4px] transition-colors ${
              promptTargetHost === host ? "border-gov bg-gov/10 text-gov" : "border-line hover:border-line-2"
            }`}
          >
            {t("pages.focus.promptCapacityViewAsHost", { host: host === "openclaw" ? "OpenClaw" : host === "workbuddy" ? "WorkBuddy" : "Codex" })}
          </button>
        ))}
        {promptTargetHost !== null && (
          <button
            type="button"
            onClick={() => onChangeHost(null)}
            data-testid="prompt-capacity-pick-clear"
            className="inline-flex items-center border border-line rounded-[3px] px-[10px] py-[4px] hover:border-line-2"
          >
            {t("pages.focus.promptCapacityClearHost", { defaultValue: "清除选择" })}
          </button>
        )}
      </div>
    </>
  );
}
