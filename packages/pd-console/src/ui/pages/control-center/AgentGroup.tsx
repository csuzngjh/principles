import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils.js";
import {
  AGENT_METADATA,
  type AgentGroupMeta,
} from "../../utils/agent-metadata.js";
import { isKnownAgentName } from "../../utils/control-center-helpers.js";
import type {
  RedactedAgentSummary,
  RedactedRuntimeProfileSummary,
} from "../../api.js";
import { AgentCard, type AgentLocale } from "./AgentCard.js";

/**
 * AgentGroup — 依赖分组容器
 *
 * 渲染 group header（名称 + 标签 + 提示）+ 该组所有 AgentCard。
 * 标签样式按 GroupTag（must/recommend/optional/independent）区分。
 *
 * rc 合规：
 * - rc-2/rc-5: 父组件已用 groupAgentsByDependency 过滤未知代理，本组件用
 *   isKnownAgentName 类型守卫二次校验 agent.name 后取 meta（防御性，不静默）
 * - rc-9: 若 agents 为空数组，渲染 group header 但显示空状态提示
 *
 * 品牌约束：无 translateY / scale hover，无硬编码色值
 */

interface AgentGroupProps {
  groupMeta: AgentGroupMeta;
  agents: RedactedAgentSummary[];
  profiles: RedactedRuntimeProfileSummary[];
  onBindingChange: (
    agentName: string,
    runtimeProfile: string,
    enabled: boolean,
  ) => void;
  saving: string | null;
  locale: AgentLocale;
}

/** gtag 样式按 GroupTag 区分 */
function gtagClasses(tag: AgentGroupMeta["tag"]): string {
  const base =
    "text-[10px] font-mono px-[7px] py-[2px] rounded-[2px] tracking-[0.02em] font-medium border border-transparent";
  switch (tag) {
    case "must":
      return cn(base, "bg-danger/10 text-danger border-danger/22");
    case "recommend":
      return cn(base, "bg-amber/10 text-amber border-amber/22");
    case "optional":
      return cn(base, "bg-paper-2 text-ink-4 border-line-2");
    case "independent":
      return cn(base, "bg-green/10 text-green border-green/22");
    default:
      return base;
  }
}

export function AgentGroup({
  groupMeta,
  agents,
  profiles,
  onBindingChange,
  saving,
  locale,
}: AgentGroupProps) {
  const { t } = useTranslation();
  const isZh = locale === "zh-CN";

  const groupName = isZh ? groupMeta.labelZh : groupMeta.labelEn;
  const groupTagLabel = isZh ? groupMeta.tagLabelZh : groupMeta.tagLabelEn;
  const groupHint = isZh ? groupMeta.hintZh : groupMeta.hintEn;

  // rc-2/rc-5: 先用类型守卫缩窄 agent.name，避免 as 绕过；
  // 空状态判断基于过滤后的 knownAgents，避免"全部未知时仍渲染 group header 但无卡片"
  // 用对象级类型谓词让 TS 在后续 map 中正确缩窄 agent.name（Array.filter 对
  // 子属性的 string 谓词不会传播到元素类型）
  const knownAgents = agents.filter(
    (agent): agent is RedactedAgentSummary & { name: keyof typeof AGENT_METADATA } =>
      isKnownAgentName(agent.name),
  );

  return (
    <div className="mb-[20px]">
      {/* group header */}
      <div className="px-[14px] py-[9px] bg-paper-2 border border-line-2 rounded-[4px] flex items-center gap-[10px] mb-[8px]">
        <span className="text-[12.5px] font-semibold text-ink-2">
          {groupName}
        </span>
        <span className={gtagClasses(groupMeta.tag)}>{groupTagLabel}</span>
        <span className="ml-auto text-[11px] text-ink-4 font-mono leading-[1.4] max-w-[32ch] text-right">
          {groupHint}
        </span>
      </div>

      {/* agent cards */}
      {knownAgents.length === 0 ? (
        // rc-9: 空状态显式提示（不静默）
        <div className="py-2 px-4 text-[12.5px] text-ink-4 italic">
          —
        </div>
      ) : (
        knownAgents.map((agent) => {
          const meta = AGENT_METADATA[agent.name];
          return (
            <AgentCard
              key={agent.name}
              agent={agent}
              meta={meta}
              profiles={profiles}
              onBindingChange={onBindingChange}
              saving={saving}
              locale={locale}
            />
          );
        })
      )}
    </div>
  );
}
