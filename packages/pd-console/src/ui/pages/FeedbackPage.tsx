import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { fetchFeedbackGfi, fetchEmpathyEvents, fetchFeedbackGateBlocks } from "../api.js";
import type { FeedbackGfi, EmpathyEvent, GateBlockItem } from "../api.js";
import { COLORS, REFRESH_BAR, SHADOW_CARD } from "../styles/constants.js";

const SEVERITY_COLORS: Record<string, string> = {
  low: COLORS.success,
  medium: COLORS.warning,
  high: COLORS.danger,
};

function GfiGauge({ gfi }: { gfi: FeedbackGfi | null }) {
  if (!gfi) return <div style={SHADOW_CARD}>Loading GFI...</div>;

  const threshold = gfi.threshold || 1;
  const percentage = Math.min((gfi.current / threshold) * 100, 100);
  const color = percentage < 50 ? COLORS.success : percentage < 80 ? COLORS.warning : COLORS.danger;

  return (
    <div style={SHADOW_CARD}>
      <div style={{ fontSize: "14px", color: COLORS.textMuted, marginBottom: "8px" }}>GFI (General Friction Index)</div>
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <div style={{ fontSize: "36px", fontWeight: "bold", color }}>{gfi.current}</div>
        <div style={{ flex: 1 }}>
          <div style={{ background: "#f0f0f0", borderRadius: "4px", height: "12px", overflow: "hidden" }}>
            <div style={{ background: color, height: "100%", width: `${percentage}%`, borderRadius: "4px", transition: "width 0.3s" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: COLORS.textMuted, marginTop: "4px" }}>
            <span>0</span>
            <span>Threshold: {gfi.threshold}</span>
          </div>
        </div>
      </div>
      <div style={{ fontSize: "12px", color: COLORS.textMuted, marginTop: "8px" }}>Peak today: {gfi.peakToday}</div>
      {Object.keys(gfi.sources).length > 0 && (
        <div style={{ marginTop: "12px" }}>
          <div style={{ fontSize: "12px", color: COLORS.textMuted, marginBottom: "4px" }}>Sources</div>
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
  const gfi = useAutoRefresh<FeedbackGfi>(fetchFeedbackGfi, 30000);
  const empathy = useAutoRefresh<EmpathyEvent[]>(() => fetchEmpathyEvents(20), 30000);
  const blocks = useAutoRefresh<GateBlockItem[]>(() => fetchFeedbackGateBlocks(20), 30000);

  const refreshAll = () => {
    gfi.refresh();
    empathy.refresh();
    blocks.refresh();
  };

  const lastUpdated = gfi.lastUpdated ?? empathy.lastUpdated ?? blocks.lastUpdated;

  return (
    <div>
      <div style={REFRESH_BAR}>
        <h1 style={{ margin: 0 }}>Feedback</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {lastUpdated && (
            <span style={{ fontSize: "12px", color: COLORS.textMuted }}>
              Updated: {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={refreshAll}
            style={{
              border: "1px solid #d9d9d9",
              borderRadius: "6px",
              padding: "6px 12px",
              fontSize: "13px",
              cursor: "pointer",
              backgroundColor: "#fff",
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      <GfiGauge gfi={gfi.data} />

      <h2 style={{ marginTop: "24px", marginBottom: "16px" }}>Empathy Events</h2>
      {empathy.error && <div style={{ color: COLORS.danger, marginBottom: "12px" }}>Error: {empathy.error}</div>}
      {!empathy.data || empathy.data.length === 0 ? (
        <div style={{ color: COLORS.textMuted, padding: "16px" }}>No empathy events recorded</div>
      ) : (
        empathy.data.map((event, i) => (
          <div key={i} style={{ ...SHADOW_CARD, borderLeft: `4px solid ${SEVERITY_COLORS[event.severity] ?? '#999'}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: "bold", textTransform: "capitalize" }}>{event.severity}</span>
              <span style={{ fontSize: "12px", color: COLORS.textMuted }}>{new Date(event.timestamp).toLocaleString()}</span>
            </div>
            <div style={{ marginTop: "8px", fontSize: "14px" }}>{event.reason}</div>
            <div style={{ marginTop: "4px", fontSize: "12px", color: COLORS.textMuted }}>Origin: {event.origin} | GFI after: {event.gfiAfter}</div>
          </div>
        ))
      )}

      <h2 style={{ marginTop: "24px", marginBottom: "16px" }}>Gate Blocks</h2>
      {blocks.error && <div style={{ color: COLORS.danger, marginBottom: "12px" }}>Error: {blocks.error}</div>}
      {!blocks.data || blocks.data.length === 0 ? (
        <div style={{ color: COLORS.textMuted, padding: "16px" }}>No gate blocks recorded</div>
      ) : (
        blocks.data.map((block, i) => (
          <div key={i} style={{ ...SHADOW_CARD, borderLeft: "4px solid #ff4d4f" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: "bold" }}>{block.toolName}</span>
              <span style={{ fontSize: "12px", color: COLORS.textMuted }}>{new Date(block.timestamp).toLocaleString()}</span>
            </div>
            <div style={{ marginTop: "8px", fontSize: "14px" }}>{block.reason}</div>
            <div style={{ marginTop: "4px", fontSize: "12px", color: COLORS.textMuted }}>
              Type: {block.gateType} | GFI: {block.gfi} | Trust Stage: {block.trustStage}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
