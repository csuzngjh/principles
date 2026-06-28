import { useTranslation } from "react-i18next";
import { ChevronRight, RefreshCw } from "lucide-react";

/**
 * WorkflowDiagram — PD 行为回路 4 阶段图
 *
 * 纯展示组件，所有文本来自 i18n。Phase 03（Owner 审批）用虚线边框 +
 * gov 色调高亮，强调"人在治理中心"（品牌 Principle 3）。
 *
 * 视觉规格取自 design-prototype/control-center.html 第 115-151 行。
 *
 * rc 合规：
 * - rc-1: 纯展示组件，消费 i18n 字符串（已受控），无 untrusted 数据
 * - rc-8: 无 JSON 序列化路径
 *
 * 品牌约束（PRI-CR1 B.4.4）：
 * - 禁止 translateY / scale hover 效果（仅 rotate 允许用于箭头朝向）
 * - 无硬编码十六进制色值，全用 token
 */
export function WorkflowDiagram() {
  const { t } = useTranslation();

  const phases = [
    {
      num: "01",
      nameKey: "pages.controlCenter.workflow.phase01",
      descKey: "pages.controlCenter.workflow.phase01Desc",
      isHuman: false,
    },
    {
      num: "02",
      nameKey: "pages.controlCenter.workflow.phase02",
      descKey: "pages.controlCenter.workflow.phase02Desc",
      isHuman: false,
    },
    {
      num: "03",
      nameKey: "pages.controlCenter.workflow.phase03",
      descKey: "pages.controlCenter.workflow.phase03Desc",
      isHuman: true,
    },
    {
      num: "04",
      nameKey: "pages.controlCenter.workflow.phase04",
      descKey: "pages.controlCenter.workflow.phase04Desc",
      isHuman: false,
    },
  ] as const;

  return (
    <div className="mt-8 bg-surface border border-line-2 rounded-[8px] px-[22px] py-[18px]">
      {/* 标题行：mono eyebrow + 分隔线 */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-[11px] font-mono uppercase tracking-[0.1em] text-ink-4 font-medium">
          {t("pages.controlCenter.workflow.title")}
        </span>
        <span className="text-[11px] font-mono uppercase tracking-[0.1em] text-ink-4">
          {t("pages.controlCenter.workflow.subtitle")}
        </span>
        <span className="flex-1 h-px bg-line-2" aria-hidden="true" />
      </div>

      {/* 4 phase + 3 箭头 grid */}
      <div className="grid grid-cols-[1fr_24px_1fr_24px_1fr_24px_1fr] items-stretch">
        {phases.map((phase, idx) => (
          <div key={phase.num} className="contents">
            <div
              className={
                phase.isHuman
                  ? "px-[10px] py-[12px] text-center flex flex-col gap-[5px] justify-center border border-dashed border-gov bg-gov/10 rounded-[4px]"
                  : "px-[10px] py-[12px] text-center flex flex-col gap-[5px] justify-center bg-paper-2 border border-line-2 rounded-[4px]"
              }
            >
              <div className="text-[10px] font-mono text-ink-4 tracking-[0.06em]">
                {phase.num}
              </div>
              <div
                className={
                  phase.isHuman
                    ? "text-[14px] font-semibold text-gov tracking-[-0.005em]"
                    : "text-[14px] font-semibold text-ink tracking-[-0.005em]"
                }
              >
                {t(phase.nameKey)}
              </div>
              <div
                className={
                  phase.isHuman
                    ? "text-[11.5px] text-gov-2 italic leading-[1.45] whitespace-pre-line"
                    : "text-[11.5px] text-ink-3 leading-[1.45] whitespace-pre-line"
                }
              >
                {t(phase.descKey)}
              </div>
            </div>
            {/* 箭头（最后一个 phase 后无箭头） */}
            {idx < phases.length - 1 && (
              <div className="flex items-center justify-center text-ink-4 font-mono">
                <ChevronRight className="w-[18px] h-[18px]" aria-hidden="true" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* loop hint */}
      <div className="mt-[14px] pt-[12px] border-t border-line-2 flex items-center gap-[10px] text-[11.5px] text-ink-4 font-mono leading-[1.5]">
        <RefreshCw
          className="w-[14px] h-[14px] text-gov shrink-0"
          aria-hidden="true"
        />
        <span>{t("pages.controlCenter.workflow.loopHint")}</span>
      </div>
    </div>
  );
}
