import type { TaskEvidence } from "../../types.js";
import { userFacingText, LOCALE } from "../i18n.js";

interface EvidencePanelProps {
  evidence: TaskEvidence | null;
  loading: boolean;
}

const SECTION_STYLE: React.CSSProperties = {
  marginBottom: "12px",
};

const HIGHLIGHT_BOX: React.CSSProperties = {
  backgroundColor: "#e6f7ff",
  border: "1px solid #91d5ff",
  borderRadius: "4px",
  padding: "10px 12px",
  fontSize: "13px",
  lineHeight: "1.6",
};

const WARNING_BOX: React.CSSProperties = {
  backgroundColor: "#fffbe6",
  border: "1px solid #ffe58f",
  borderRadius: "4px",
  padding: "10px 12px",
  fontSize: "13px",
  lineHeight: "1.6",
};

const SECTION_LABEL: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  color: "#666",
  marginBottom: "4px",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const EVIDENCE_ITEM: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  padding: "6px 0",
  borderBottom: "1px solid #f5f5f5",
  fontSize: "12px",
  color: "#666",
};

const TIMESTAMP: React.CSSProperties = {
  color: "#999",
  minWidth: "80px",
  fontSize: "11px",
};

export function EvidencePanel({ evidence, loading }: EvidencePanelProps) {
  if (loading) {
    return <div style={{ padding: "12px 0", textAlign: "center", color: "#999", fontSize: "13px" }}>加载中...</div>;
  }
  if (!evidence) return null;

  return (
    <div style={{ padding: "12px 0" }}>
      <div style={SECTION_STYLE}>
        <div style={SECTION_LABEL}>摘要</div>
        <div style={HIGHLIGHT_BOX}>{userFacingText(evidence.summary)}</div>
      </div>
      <div style={SECTION_STYLE}>
        <div style={SECTION_LABEL}>原因分析</div>
        <div style={{ fontSize: "13px", lineHeight: "1.6", color: "#333" }}>{userFacingText(evidence.why)}</div>
      </div>
      <div style={SECTION_STYLE}>
        <div style={SECTION_LABEL}>影响评估</div>
        <div style={WARNING_BOX}>{userFacingText(evidence.whatHappensIf)}</div>
      </div>
      {evidence.evidence.length > 0 && (
        <div style={SECTION_STYLE}>
          <div style={SECTION_LABEL}>证据</div>
          {evidence.evidence.map((item, i) => (
            <div key={`${item.timestamp}-${item.operation}-${i}`} style={EVIDENCE_ITEM}>
              <span style={TIMESTAMP}>{new Date(item.timestamp).toLocaleTimeString(LOCALE)}</span>
              <span>{userFacingText(item.operation)}</span>
              <span style={{ color: "#999" }}>{userFacingText(item.problem)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
