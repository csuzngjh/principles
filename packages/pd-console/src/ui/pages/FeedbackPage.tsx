import { useState, useEffect } from "react";
import { fetchFeedbackGfi, fetchEmpathyEvents, fetchFeedbackGateBlocks } from "../api.js";
import type { FeedbackGfi, EmpathyEvent, GateBlockItem } from "../api.js";

const CARD_STYLE: React.CSSProperties = {
  border: "1px solid #e0e0e0",
  borderRadius: "8px",
  padding: "16px",
  backgroundColor: "#fff",
  marginBottom: "16px",
};

const SEVERITY_COLORS: Record<string, string> = {
  low: "#52c41a",
  medium: "#faad14",
  high: "#ff4d4f",
};

function GfiGauge({ gfi }: { gfi: FeedbackGfi | null }) {
  if (!gfi) return <div style={CARD_STYLE}>Loading GFI...</div>;

  const threshold = gfi.threshold || 1;
  const percentage = Math.min((gfi.current / threshold) * 100, 100);
  const color = percentage < 50 ? "#52c41a" : percentage < 80 ? "#faad14" : "#ff4d4f";

  return (
    <div style={CARD_STYLE}>
      <div style={{ fontSize: "14px", color: "#888", marginBottom: "8px" }}>GFI (General Friction Index)</div>
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <div style={{ fontSize: "36px", fontWeight: "bold", color }}>{gfi.current}</div>
        <div style={{ flex: 1 }}>
          <div style={{ background: "#f0f0f0", borderRadius: "4px", height: "12px", overflow: "hidden" }}>
            <div style={{ background: color, height: "100%", width: `${percentage}%`, borderRadius: "4px", transition: "width 0.3s" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#999", marginTop: "4px" }}>
            <span>0</span>
            <span>Threshold: {gfi.threshold}</span>
          </div>
        </div>
      </div>
      <div style={{ fontSize: "12px", color: "#999", marginTop: "8px" }}>Peak today: {gfi.peakToday}</div>
      {Object.keys(gfi.sources).length > 0 && (
        <div style={{ marginTop: "12px" }}>
          <div style={{ fontSize: "12px", color: "#888", marginBottom: "4px" }}>Sources</div>
          {Object.entries(gfi.sources).map(([source, value]) => (
            <div key={source} style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "2px 0" }}>
              <span>{source}</span>
              <span style={{ fontWeight: "bold" }}>{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FeedbackPage() {
  const [gfi, setGfi] = useState<FeedbackGfi | null>(null);
  const [empathyEvents, setEmpathyEvents] = useState<EmpathyEvent[]>([]);
  const [gateBlocks, setGateBlocks] = useState<GateBlockItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchFeedbackGfi().then((r) => { if (r.success) setGfi(r.data); else setError(r.error); });
    fetchEmpathyEvents(20).then((r) => { if (r.success) setEmpathyEvents(r.data); });
    fetchFeedbackGateBlocks(20).then((r) => { if (r.success) setGateBlocks(r.data); });
  }, []);

  if (error) {
    return <div style={{ padding: "24px", color: "#ff4d4f" }}>Error: {error}</div>;
  }

  return (
    <div>
      <h1 style={{ marginBottom: "24px" }}>Feedback</h1>

      <GfiGauge gfi={gfi} />

      <h2 style={{ marginTop: "24px", marginBottom: "16px" }}>Empathy Events</h2>
      {empathyEvents.length === 0 ? (
        <div style={{ color: "#888", padding: "16px" }}>No empathy events recorded</div>
      ) : (
        empathyEvents.map((event, i) => (
          <div key={i} style={{ ...CARD_STYLE, borderLeft: `4px solid ${SEVERITY_COLORS[event.severity] ?? '#999'}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: "bold", textTransform: "capitalize" }}>{event.severity}</span>
              <span style={{ fontSize: "12px", color: "#999" }}>{new Date(event.timestamp).toLocaleString()}</span>
            </div>
            <div style={{ marginTop: "8px", fontSize: "14px" }}>{event.reason}</div>
            <div style={{ marginTop: "4px", fontSize: "12px", color: "#888" }}>Origin: {event.origin} | GFI after: {event.gfiAfter}</div>
          </div>
        ))
      )}

      <h2 style={{ marginTop: "24px", marginBottom: "16px" }}>Gate Blocks</h2>
      {gateBlocks.length === 0 ? (
        <div style={{ color: "#888", padding: "16px" }}>No gate blocks recorded</div>
      ) : (
        gateBlocks.map((block, i) => (
          <div key={i} style={{ ...CARD_STYLE, borderLeft: "4px solid #ff4d4f" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: "bold" }}>{block.toolName}</span>
              <span style={{ fontSize: "12px", color: "#999" }}>{new Date(block.timestamp).toLocaleString()}</span>
            </div>
            <div style={{ marginTop: "8px", fontSize: "14px" }}>{block.reason}</div>
            <div style={{ marginTop: "4px", fontSize: "12px", color: "#888" }}>
              Type: {block.gateType} | GFI: {block.gfi} | Trust Stage: {block.trustStage}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
