import { useState, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import type { AgentMeta } from "../../utils/agent-metadata.js";
import { fetchAgentReadiness } from "../../api.js";
import type {
  RedactedAgentSummary,
  RedactedRuntimeProfileSummary,
  ReadinessStatus,
} from "../../api.js";

/**
 * AgentCard — 三层渐进式披露代理卡片 + 核心代理内联确认
 *
 * L1（折叠态）：状态点 + 显示名 + agent.name + 角色一句话 + 开关 + 展开箭头
 * L2（展开态）：详细说明段落 + impact-box + 技术细节 toggle + profile-row
 * L3（嵌套折叠）：技术细节 grid
 *
 * 核心代理（isCore=true）关闭时显示内联确认条（不弹模态）。
 *
 * rc 合规：
 * - rc-1: agent/profiles 由父组件已验证；meta 是静态数据
 * - rc-2: 无 as 绕过
 * - rc-8: 无 JSON 序列化
 *
 * 品牌约束（PRI-CR1 B.4.4）：
 * - 禁止 translateY / scale hover（rotate 仅用于箭头朝向，允许）
 * - 无硬编码十六进制色值
 */

export type AgentLocale = "zh-CN" | "en";

interface AgentCardProps {
  agent: RedactedAgentSummary;
  meta: AgentMeta;
  profiles: RedactedRuntimeProfileSummary[];
  onBindingChange: (
    agentName: string,
    runtimeProfile: string,
    enabled: boolean,
  ) => void;
  saving: string | null;
  locale: AgentLocale;
}

/** 状态点样式：ready / notready / off
 *
 * 接受 readiness + enabled 而非整个 agent 对象，以便 L1 状态点可以使用
 * 动态获取的 readiness（fetchAgentReadiness）替换静态悲观值。
 */
function statusDotClasses(readiness: ReadinessStatus, enabled: boolean): string {
  const base = "w-2 h-2 rounded-full border-2 shrink-0";
  if (!enabled) {
    return cn(base, "border-ink-4 bg-surface opacity-50");
  }
  switch (readiness) {
    case "ready":
      return cn(base, "border-green bg-green");
    case "not_ready":
      return cn(base, "border-amber bg-surface");
    case "needs_setup":
      return cn(base, "border-amber bg-surface");
    default:
      return cn(base, "border-ink-4 bg-surface");
  }
}

/** impact-box 左边框色 */
function impactBorderClass(level: AgentMeta["impactLevel"]): string {
  switch (level) {
    case "danger":
      return "border-l-danger";
    case "green":
      return "border-l-green";
    default:
      return "border-l-amber";
  }
}

/** impact label 色 */
function impactLabelClass(level: AgentMeta["impactLevel"]): string {
  switch (level) {
    case "danger":
      return "text-danger";
    case "green":
      return "text-green";
    default:
      return "text-ink-4";
  }
}

/**
 * 渲染含反引号 code 片段的文本。
 * 输入示例：'`DiagnosticianContextPayload`（pain 信号上下文）'
 * 输出：[<code>DiagnosticianContextPayload</code>, "（pain 信号上下文）"]
 */
function renderTextWithCode(text: string): ReactNode[] {
  const parts = text.split("`");
  const nodes: ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    if (i % 2 === 0) {
      if (part.length > 0) {
        nodes.push(part);
      }
    } else {
      // Odd index = content between backticks = code
      nodes.push(
        <code
          key={`code-${i}`}
          className="font-mono text-[11px] text-ink-2 bg-paper-2 px-[5px] py-[1px] rounded-[2px]"
        >
          {part}
        </code>,
      );
    }
  }
  return nodes;
}

export function AgentCard({
  agent,
  meta,
  profiles,
  onBindingChange,
  saving,
  locale,
}: AgentCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isSaving = saving === agent.name;

  // L2 / L3 / confirm 状态
  const [isOpen, setIsOpen] = useState(false);
  const [showTechDetail, setShowTechDetail] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // 动态 readiness：L2 展开时，若静态 readiness 为 'unknown'（悲观值），
  // 调用 /api/v1/config/readiness/:agentName 获取实时探测结果替换静态值。
  // 仅在 agent.enabled && agent.readiness === 'unknown' 时发起请求。
  const [dynamicReadiness, setDynamicReadiness] = useState<ReadinessStatus | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessFetched, setReadinessFetched] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    if (readinessFetched) return;
    if (!agent.enabled) return;
    if (agent.readiness !== "unknown") return;

    let cancelled = false;
    setReadinessFetched(true);
    setReadinessLoading(true);

    fetchAgentReadiness(agent.name).then((result) => {
      if (cancelled) return;
      setReadinessLoading(false);
      if (result.success && result.data) {
        setDynamicReadiness(result.data.readiness);
      }
      // rc-9: 调用失败时不静默吞错——result.error 已由 request() 提取；
      // 此处 fallback 到静态 agent.readiness（'unknown'），状态点保持 amber。
      // loading 指示器消失即告知用户探测已结束但未获得确定结果。
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, readinessFetched, agent.enabled, agent.readiness, agent.name]);

  // 有效 readiness：静态值为 'unknown' 且已获取动态值时使用动态值；
  // 否则使用静态值（父组件 re-fetch 后若不再是 'unknown' 则自动优先）。
  const effectiveReadiness: ReadinessStatus =
    agent.readiness === "unknown" && dynamicReadiness !== null
      ? dynamicReadiness
      : agent.readiness;

  // locale 决定取 Zh 还是 En 字段
  const isZh = locale === "zh-CN";
  const displayName = isZh ? meta.displayNameZh : meta.displayNameEn;
  const role = isZh ? meta.roleZh : meta.roleEn;
  const detail = isZh ? meta.detailZh : meta.detailEn;
  const impact = isZh ? meta.impactZh : meta.impactEn;
  const techDetail = isZh ? meta.techDetailZh : meta.techDetailEn;
  const mvpNote = isZh ? meta.mvpNoteZh : meta.mvpNoteEn;
  const actionLinkText = isZh ? meta.action?.linkTextZh : meta.action?.linkTextEn;

  // 段落用 \n\n 分隔
  const detailParagraphs = detail.split("\n\n").filter((p) => p.length > 0);

  // 头部点击：toggle isOpen（但点击 toggle 按钮 / confirm-bar / tech-toggle / action-row 不触发）
  const handleHeadClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest("[data-agent-toggle]") ||
      target.closest("[data-confirm-bar]") ||
      target.closest("[data-tech-toggle]") ||
      target.closest("[data-action-row]")
    ) {
      return;
    }
    setIsOpen((prev) => !prev);
  };

  // toggle 按钮点击
  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (agent.enabled) {
      // 当前 on → 要关
      if (meta.isCore) {
        // 核心代理：显示内联确认 + 自动展开
        setConfirming(true);
        setIsOpen(true);
      } else {
        // 非核心代理：直接关
        onBindingChange(agent.name, agent.runtimeProfileId, false);
      }
    } else {
      // 当前 off → 要开
      onBindingChange(agent.name, agent.runtimeProfileId, true);
    }
  };

  // 确认停用
  const handleConfirmOff = (e: React.MouseEvent) => {
    e.stopPropagation();
    onBindingChange(agent.name, agent.runtimeProfileId, false);
    setConfirming(false);
  };

  // 取消确认
  const handleCancelConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(false);
  };

  // tech-toggle 点击
  const handleTechToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowTechDetail((prev) => !prev);
  };

  // profile select 变更
  const handleProfileChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onBindingChange(agent.name, e.target.value, agent.enabled);
  };

  return (
    <div
      data-agent-card={agent.name}
      className={cn(
        "bg-surface border border-line-2 rounded-[4px] mb-[6px] overflow-hidden transition-colors hover:border-line",
        !meta.isCore && "border-dashed",
        !agent.enabled && "opacity-72",
      )}
    >
      {/* ── L1: 头部（始终显示） ── */}
      <div
        className="px-[16px] py-[12px] cursor-pointer flex items-center gap-[12px]"
        onClick={handleHeadClick}
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setIsOpen((prev) => !prev);
          }
        }}
      >
        {/* 状态点 — 使用 effectiveReadiness（动态获取后替换静态悲观值）*/}
        <div className={statusDotClasses(effectiveReadiness, agent.enabled)} aria-hidden="true" />

        {/* 名称 + 角色 */}
        <div className="flex-1 min-w-0">
          <div
            className={cn(
              "text-[14px] font-semibold tracking-[-0.005em] flex items-center gap-[8px]",
              agent.enabled ? "text-ink" : "text-ink-3",
            )}
          >
            <span>{displayName}</span>
            <span className="font-mono text-[11.5px] text-ink-4 font-normal">
              {agent.name}
            </span>
          </div>
          <div className="text-[12.5px] text-ink-3 mt-[2px] leading-[1.5]">
            {role}
          </div>
        </div>

        {/* 开关按钮 */}
        <button
          type="button"
          data-agent-toggle
          onClick={handleToggleClick}
          disabled={isSaving}
          aria-label={
            agent.enabled
              ? t("pages.controlCenter.agentDisabled")
              : t("pages.controlCenter.agentEnabled")
          }
          className={cn(
            "rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium transition-colors disabled:opacity-50",
            agent.enabled
              ? "border border-gov bg-gov text-paper hover:bg-gov-2"
              : "border border-line bg-surface text-ink hover:border-line-2",
          )}
        >
          {isSaving
            ? t("pages.controlCenter.saving")
            : agent.enabled
              ? t("pages.controlCenter.on")
              : t("pages.controlCenter.off")}
        </button>

        {/* 展开箭头（rotate 允许） */}
        <ChevronRight
          className={cn(
            "w-[14px] h-[14px] text-ink-4 transition-transform shrink-0",
            isOpen && "rotate-90",
          )}
          aria-hidden="true"
        />
      </div>

      {/* ── L2: 展开内容（isOpen 控制） ── */}
      {isOpen && (
        <div className="px-[16px] pb-[14px] border-t border-line-2 bg-panel">
          {/* 详细说明段落 */}
          <div className="pt-[14px] text-[13px] text-ink-3 leading-[1.62]">
            {detailParagraphs.map((para, i) => (
              <p key={i} className={i > 0 ? "mt-2" : undefined}>
                {renderTextWithCode(para)}
              </p>
            ))}
          </div>

          {/* MVP note（仅 philosopher/rolloutReviewer 有） */}
          {mvpNote && (
            <div className="mt-3 text-[12px] text-ink-4 font-mono italic">
              {mvpNote}
            </div>
          )}

          {/* impact-box */}
          <div
            className={cn(
              "mt-[12px] px-[12px] py-[10px] border border-line-2 border-l-[2.5px] rounded-[4px] bg-paper-2 text-[12.5px] text-ink-3 leading-[1.55]",
              impactBorderClass(meta.impactLevel),
            )}
          >
            <span
              className={cn(
                "block mb-[3px] text-[10px] font-mono uppercase tracking-[0.08em] font-medium",
                impactLabelClass(meta.impactLevel),
              )}
            >
              {t("pages.controlCenter.impact.label")}
            </span>
            {impact}
          </div>

          {/* action-row（当 meta.action 存在时） */}
          {meta.action && actionLinkText && (
            <div
              data-action-row
              className="mt-[12px] pt-[12px] border-t border-line-2"
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(meta.action!.to);
                }}
                className="flex items-center gap-[6px] text-[12px] text-gov hover:text-gov-2 transition-colors font-medium"
              >
                <span>{actionLinkText}</span>
                <ChevronRight className="w-[12px] h-[12px]" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* L3: 技术细节（嵌套折叠，仅当有 techDetail 内容时显示） */}
          {Object.keys(techDetail).length > 0 && (
            <>
              <div
                data-tech-toggle
                className="mt-[12px] pt-[12px] border-t border-line-2 flex items-center gap-[6px] cursor-pointer text-[11px] text-ink-4 font-mono uppercase tracking-[0.04em] hover:text-ink-2 transition-colors"
                onClick={handleTechToggleClick}
                role="button"
                tabIndex={0}
                aria-expanded={showTechDetail}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowTechDetail((prev) => !prev);
                  }
                }}
              >
                <ChevronRight
                  className={cn(
                    "w-[12px] h-[12px] transition-transform",
                    showTechDetail && "rotate-90",
                  )}
                  aria-hidden="true"
                />
                {t("pages.controlCenter.techDetail")}
              </div>
              {showTechDetail && (
                <div className="mt-2 grid grid-cols-[72px_1fr] gap-x-[14px] gap-y-[6px] text-[12px] leading-[1.55]">
                  {Object.entries(techDetail).map(([k, v]) => (
                    <div key={k} className="contents">
                      <div className="text-ink-4 font-mono text-[10.5px] uppercase tracking-[0.04em] pt-px">
                        {k}
                      </div>
                      <div className="text-ink-3">
                        {renderTextWithCode(v)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* profile-row */}
          <div className="mt-[12px] pt-[12px] border-t border-line-2 flex items-center gap-[10px] text-[12px] flex-wrap">
            <span className="text-ink-4 font-mono text-[10.5px] uppercase tracking-[0.04em]">
              {t("pages.controlCenter.profileLabelShort")}
            </span>
            <select
              value={agent.runtimeProfileId}
              onChange={handleProfileChange}
              disabled={isSaving}
              className="font-mono text-[11px] text-ink-2 bg-surface border border-line-2 rounded-[3px] px-2 py-1 cursor-pointer focus:outline-none focus:border-gov disabled:opacity-50"
              aria-label={t("pages.controlCenter.profileLabel")}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {/* 动态 readiness loading 指示器（仅探测中显示）*/}
            {readinessLoading && (
              <span className="text-[10.5px] text-ink-4 font-mono animate-pulse">
                {t("pages.controlCenter.readinessChecking")}
              </span>
            )}
            {/* "管理 Profiles" 按钮 — 滚动到页面级 RuntimeProfileManager 区段 */}
            <button
              type="button"
              data-manage-profiles
              onClick={(e) => {
                e.stopPropagation();
                const el = document.getElementById("runtime-profile-manager");
                if (el) {
                  el.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              }}
              className="ml-auto text-[11px] text-ink-4 hover:text-ink-2 transition-colors px-[8px] py-[3px] border border-line-2 rounded-[3px] focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              aria-label={t("pages.controlCenter.manageProfiles")}
            >
              {t("pages.controlCenter.manageProfiles")}
            </button>
          </div>

          {/* 内联确认条（仅核心代理 confirming=true 时） */}
          {confirming && (
            <div
              data-confirm-bar
              className="mt-[10px] px-[12px] py-[10px] border border-danger rounded-[4px] bg-danger/10 text-[12px] text-ink-2 leading-[1.55]"
            >
              <div>{impact}</div>
              <div className="mt-2 flex gap-[8px]">
                <button
                  type="button"
                  onClick={handleConfirmOff}
                  className="text-[11.5px] px-[12px] py-[4px] rounded-[3px] border border-transparent bg-danger text-paper font-medium hover:opacity-90 transition-opacity focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                >
                  {t("pages.controlCenter.impact.confirmAck")}
                </button>
                <button
                  type="button"
                  onClick={handleCancelConfirm}
                  className="text-[11.5px] px-[12px] py-[4px] rounded-[3px] border border-line bg-transparent text-ink-3 hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                >
                  {t("pages.controlCenter.impact.confirmCancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
