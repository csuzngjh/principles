import type { ReactNode } from "react";
import type { TaskItem, TaskEvidence } from "../../types.js";
import { userFacingText } from "../i18n.js";
import { EvidencePanel } from "./EvidencePanel.js";
import { SHADOW_CARD, CARD_HEADER, EXPAND_ARROW, COLLAPSED_WRAPPER, EXPANDED_WRAPPER, OVERFLOW_HIDDEN, BUTTON_APPROVE, BUTTON_REJECT, BUTTON_CLEANUP } from "../styles/constants.js";

interface TaskCardProps {
  task: TaskItem;
  expanded: boolean;
  evidence: TaskEvidence | null;
  evidenceLoading: boolean;
  onToggleExpand: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  onCleanup?: () => void;
  undoState?: "approve" | "reject" | null;
  undoTimer: number | null;
  onUndo?: () => void;
}

const STATUS_BADGE: React.CSSProperties = {
  display: "inline-block",
  padding: "4px 12px",
  borderRadius: "4px",
  fontSize: "13px",
  fontWeight: 500,
};

const ACTION_ROW: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  alignItems: "center",
  marginTop: "12px",
};

const UNDO_BUTTON: React.CSSProperties = {
  border: "1px solid #1677ff",
  borderRadius: "6px",
  padding: "4px 12px",
  fontSize: "12px",
  cursor: "pointer",
  fontWeight: 500,
  backgroundColor: "#ffffff",
  color: "#1677ff",
};

export function TaskCard({ task, expanded, evidence, evidenceLoading, onToggleExpand, onApprove, onReject, onCleanup, undoState, undoTimer, onUndo }: TaskCardProps) {
  return (
    <div style={SHADOW_CARD}>
      <div style={CARD_HEADER} onClick={onToggleExpand}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "4px" }}>
            {userFacingText(task.title)}
          </div>
          <div style={{ fontSize: "13px", color: "#666", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {userFacingText(task.sourceSummary)}
          </div>
        </div>
        <span style={{ ...EXPAND_ARROW, transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>
          &#x25B6;
        </span>
      </div>
      <div style={expanded ? EXPANDED_WRAPPER : COLLAPSED_WRAPPER}>
        <div style={OVERFLOW_HIDDEN}>
          <EvidencePanel evidence={evidence} loading={evidenceLoading} />
          {expanded && (
            <div style={ACTION_ROW}>
              {undoState ? (
                <>
                  <span style={{ ...STATUS_BADGE, backgroundColor: undoState === "approve" ? "#f6ffed" : "#fff2f0", color: undoState === "approve" ? "#52c41a" : "#ff4d4f" }}>
                    {undoState === "approve" ? "已确认" : "已拒绝"}
                  </span>
                  {onUndo && undoTimer !== null && (
                    <button style={UNDO_BUTTON} onClick={(e) => { e.stopPropagation(); onUndo(); }}>
                      撤销 ({undoTimer}秒)
                    </button>
                  )}
                </>
              ) : (
                <>
                  {task.kind === "approval" && onApprove && <button style={BUTTON_APPROVE} onClick={(e) => { e.stopPropagation(); onApprove(); }}>确认</button>}
                  {task.kind === "approval" && onReject && <button style={BUTTON_REJECT} onClick={(e) => { e.stopPropagation(); onReject(); }}>拒绝</button>}
                  {task.kind === "cleanup" && onCleanup && <button style={BUTTON_CLEANUP} onClick={(e) => { e.stopPropagation(); onCleanup(); }}>清理</button>}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
