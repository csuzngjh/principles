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
 * PRI-629 / PD_PROMPT_CAPACITY_V1 R-A1 / PRI-1066 / PRI-1137 final review.
 *
 * Three independent responsibilities that used to share one early return:
 *
 * 1. The host picker — the ONLY way to request approvals while the injection
 *    route is unconfirmed (`ApprovalsConsoleModel` answers 422 without a
 *    chosen host). It must be reachable whenever a per-host breakdown exists —
 *    PRI-1137: every host now shares one route, so this covers every
 *    not-yet-confirmed workspace regardless of host declarations.
 * 2. The starvation notice — shown only when a host cannot fit even ONE
 *    principle (`usedChars === 0 && truncated`). `truncated` alone is the
 *    normal rotation state and must never become a standing nag.
 * 3. Final review P1-3: per-host capacity + rotation facts, shown whenever
 *    the workspace binds NO single host — route confirmation no longer gates
 *    them. After the route unification a multi-host workspace is
 *    `confirmed` (one shared route) with no bound host; gating per-host
 *    facts on `unconfirmed` hid exactly the facts the Owner needs. The
 *    headline numbers are then labelled a REFERENCE view (they borrow the
 *    first standard host's budget basis), never a host's actual budget.
 *    A bound single-host workspace keeps the simple page (no panel, no picker).
 */
export function PromptCapacitySection({
  promptInjection,
  promptTargetHost,
  onChangeHost,
}: PromptCapacitySectionProps) {
  const { t } = useTranslation();
  if (promptInjection === undefined) return null;
  const perHost = promptInjection.perHost ?? [];
  const unconfirmed = promptInjection.capacityStatus === "unconfirmed";
  // Final review P1-3.1: route confirmation does NOT decide per-host display —
  // a confirmed route with NO bound host still shows the per-host facts.
  const referenceView = !unconfirmed && promptInjection.hostKind === undefined;
  if (!unconfirmed && !referenceView) return null;
  if (perHost.length === 0) return null;
  const starvedHosts = perHost.filter((entry) => entry.usedChars === 0 && entry.truncated);
  const hostName = (host: PromptInjectionTargetHostName) =>
    host === "openclaw" ? "OpenClaw" : host === "workbuddy" ? "WorkBuddy" : "Codex";
  // Rendered once per context (starved banner details, or the reference panel)
  // — never duplicated on one screen.
  const perHostEntries = (
    <ul className="mt-1 list-disc pl-5">
      {perHost.map((entry) => (
        <li key={entry.hostKind} data-testid={`prompt-capacity-perhost-${entry.hostKind}`}>
          {t("pages.focus.promptCapacityPerHostEntry", {
            host: hostName(entry.hostKind),
            // PRI-1137: one shared renderer for every host, billed as a
            // full directive block.
            billing: t("pages.focus.promptCapacitySharedRoute"),
            used: entry.usedChars,
            // PRI-1017: each host shows ITS OWN budget basis (runtime
            // observation or its own honest fallback) — never the
            // shared headline number.
            budget: entry.budget ?? promptInjection.budget,
            // PRI-1066 / PRI-1137 final review: per-host truncation wording
            // follows THAT host's rotation state (entry.rotation), never the
            // blended headline — a rotating host queues the leftovers for
            // later turns, a FIFO host needs capacity to free up.
            full: entry.truncated
              ? entry.rotation === "rotates"
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
          {/* Final review P1-3.5: each host shows its OWN rotation state. */}
          {entry.rotation !== undefined && (
            <span
              className="block text-ink-3"
              data-testid={`prompt-capacity-perhost-rotation-${entry.hostKind}`}
            >
              {entry.rotation === "rotates"
                ? t("pages.focus.promptCapacityPerHostRotationRotates", {
                    defaultValue: "轮转：支持公平轮转（该宿主持有轮次权威；每轮需轮次记录成功——缺 sessionId、写入失败或轮次不可读时该轮降级 FIFO、窗口不前进，未入窗条目在轮次持续成功时才会轮到）",
                  })
                : t("pages.focus.promptCapacityPerHostRotationFifo", {
                    defaultValue: "轮转：FIFO（该宿主按激活顺序注入，需腾出容量才有空位）",
                  })}
            </span>
          )}
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
  );
  return (
    <>
      {starvedHosts.length > 0 && (
        <div
          className="mb-4 rounded-[3px] border border-amber/40 bg-amber/5 px-3 py-2 text-caption leading-relaxed text-amber"
          data-testid="prompt-capacity-unconfirmed-banner"
        >
          <p data-testid="prompt-capacity-summary">
            {t("pages.focus.promptCapacityStarved", {
              defaultValue: "{{count}} 个宿主当前的注入预算连一条原则都装不下，原则在这些宿主上不会生效。",
              count: starvedHosts.length,
            })}
          </p>
          {unconfirmed ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-ink-2" data-testid="prompt-capacity-details-toggle">
                {t("pages.focus.promptCapacityDetails", { defaultValue: "查看各宿主容量明细" })}
              </summary>
              <p className="mt-1 text-ink-2">
                {t("pages.focus.promptCapacityUnconfirmed", {
                  defaultValue: "当前宿主容量未确认：本工作区适用宿主的容量事实不可用，以下数字未绑定具体宿主。",
                })}
              </p>
              {perHostEntries}
              {promptInjection.nextAction !== undefined && (
                <p className="mt-1 text-ink-2">{promptInjection.nextAction}</p>
              )}
            </details>
          ) : (
            // Reference view + starvation: the per-host facts live in the
            // panel below — never rendered twice on one screen.
            <p className="mt-1 text-ink-2">
              {t("pages.focus.promptCapacitySeePerHostDetails", {
                defaultValue: "逐宿主容量与轮转明细见下方。",
              })}
            </p>
          )}
        </div>
      )}
      {/* Final review P1-3: the per-host panel — shown whenever the banner
          does not already carry the list (unconfirmed+starved renders the
          list inside the banner details). Opt-in information, not a nag:
          the amber banner stays reserved for genuine starvation. */}
      {(!unconfirmed || starvedHosts.length === 0) && (
        <div
          className="mb-4 rounded-[3px] border border-line bg-surface/60 px-3 py-2 text-caption leading-relaxed text-ink-2"
          data-testid="prompt-capacity-perhost-panel"
        >
          <p data-testid="prompt-capacity-reference-note">
            {referenceView
              ? t("pages.focus.promptCapacityReferenceView", {
                  defaultValue:
                    "多宿主工作区未绑定单一宿主：页面上方的汇总数字是参考视图（按第一个标准宿主的预算基座计算），不代表任何单一宿主的实际运行状态；以下是各宿主自己的容量与轮转事实。",
                })
              : t("pages.focus.promptCapacityUnconfirmed", {
                  defaultValue:
                    "当前宿主容量未确认：本工作区适用宿主的容量事实不可用，以下数字未绑定具体宿主。",
                })}
          </p>
          {perHostEntries}
          {unconfirmed && promptInjection.nextAction !== undefined && (
            <p className="mt-1 text-ink-3">{promptInjection.nextAction}</p>
          )}
        </div>
      )}
      {unconfirmed && (
        <div
          className="mb-4 flex flex-wrap items-center gap-2 text-caption text-ink-2"
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
              {t("pages.focus.promptCapacityViewAsHost", { host: hostName(host) })}
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
      )}
    </>
  );
}
