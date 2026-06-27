import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  RedactedAgentSummary,
  RedactedRuntimeProfileSummary,
} from "../../api.js";
import { enumLabel } from "../../utils/enum-labels.js";

/**
 * EmpathyObserverCostHint — spec 2026-06-27 §4
 *
 * A克制、可关闭的提示条，告知 Owner：启用 empathyObserver 后会有持续的
 * LLM 调用与 token 成本，以及当前使用的 provider/model。
 *
 * 双层 gate（spec §4.1）：
 * - Gate 1（父组件 ControlCenterPage）：仅当 empathyObserver 已启用且
 *   localStorage 未 ack 时才挂载本组件。
 * - Gate 2（本组件）：维护 visible 内部状态，承载"知道了"dismiss 行为。
 *
 * 该组件不修改后端任何代码、不修改 prompt.ts、不修改 resolveEmpathyObserver。
 * 纯前端 localStorage 控制，清掉就重新出现，fail-open（隐私模式仍可见）。
 *
 * ERR entries (spec §8):
 * - ERR-001/ERR-005: 消费 ControlCenterPage 已经过 type guard 的数据，无 untrusted 原始数据
 * - ERR-009/ERR-010: provider/model 取不到时用 '—' 显式降级
 * - ERR-013: localStorage 读取与写入用 try/catch 包裹
 */
interface EmpathyObserverCostHintProps {
  /** empathyObserver agent row (already validated by parent) */
  agent: RedactedAgentSummary;
  /** runtime profiles — used to resolve provider/model */
  profiles: RedactedRuntimeProfileSummary[];
}

const COST_ACK_KEY = "pd.empathyObserver.costAck";

export function EmpathyObserverCostHint({
  agent,
  profiles,
}: EmpathyObserverCostHintProps) {
  const { t } = useTranslation();

  // Gate 2: dismiss 后不再渲染。localStorage ack 时初始即隐藏。
  const [visible, setVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COST_ACK_KEY) !== "true";
    } catch {
      // 隐私模式 / localStorage 不可用 → fail-open：默认可见
      return true;
    }
  });

  if (!visible) return null;

  // Resolve provider/model from the agent's runtime profile.
  // agent.runtimeProfileId is always present (validated by parent).
  const profile = profiles.find((p) => p.id === agent.runtimeProfileId);
  const provider = profile?.provider ?? "—";
  const model = profile?.model ?? "—";

  const handleAck = () => {
    try {
      localStorage.setItem(COST_ACK_KEY, "true");
    } catch {
      // 隐私模式等：写入失败不影响 dismiss 体验，下次仍会出现（fail-open）
    }
    setVisible(false);
  };

  return (
    <div className="bg-surface/60 border border-amber/20 border-l-2 border-l-amber rounded-[6px] px-3 py-2 mt-4">
      <p className="text-ink-2 text-[14px] leading-relaxed">
        {t("pages.controlCenter.empathyCostHint.body", {
          provider,
          model,
        })}
      </p>
      <p className="text-ink-3 text-[12px] mt-1 leading-relaxed">
        {t("pages.controlCenter.empathyCostHint.muted")}
      </p>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={handleAck}
          className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          aria-label={t("pages.controlCenter.empathyCostHint.ack")}
        >
          {t("pages.controlCenter.empathyCostHint.ack")}
        </button>
      </div>
      {/* agent name exposed for screen readers via visually-hidden span */}
      <span className="sr-only">
        {enumLabel("featureId", "empathy_observer", t)}
      </span>
    </div>
  );
}
