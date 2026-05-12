import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { fetchGateStats, fetchGateBlocks } from "../api.js";
import type { GateStats, GateBlockItem } from "../api.js";
import { COLORS, REFRESH_BAR, SHADOW_CARD } from "../styles/constants.js";

const STATUS_COLORS: Record<string, string> = {
  healthy: COLORS.success,
  warning: COLORS.warning,
  critical: COLORS.danger,
};

const STAGE_COLORS: Record<string, string> = {
  stable: COLORS.success,
  elevated: COLORS.warning,
  critical: COLORS.danger,
  saturated: "#722ed1",
};

export function GatesPage() {
  const stats = useAutoRefresh<GateStats>(fetchGateStats, 30000);
  const blocks = useAutoRefresh<GateBlockItem[]>(() => fetchGateBlocks(50), 30000);

  const refreshAll = () => {
    stats.refresh();
    blocks.refresh();
  };

  if (stats.error && !stats.data) {
    return <div style={{ padding: "24px", color: COLORS.danger }}>Error: {stats.error}</div>;
  }

  if (!stats.data) {
    return <div style={{ padding: "40px", textAlign: "center", color: COLORS.textMuted }}>Loading...</div>;
  }

  const statsData = stats.data;

  return (
    <div>
      <div style={REFRESH_BAR}>
        <h1 style={{ margin: 0 }}>Gate Monitor</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {stats.lastUpdated && (
            <span style={{ fontSize: "12px", color: COLORS.textMuted }}>
              Updated: {new Date(stats.lastUpdated).toLocaleTimeString()}
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

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        <div style={{ ...SHADOW_CARD, borderLeft: `4px solid ${STATUS_COLORS[statsData.trust.status]}` }}>
          <div style={{ fontSize: "14px", color: COLORS.textMuted, marginBottom: "8px" }}>Trust Status</div>
          <div style={{ fontSize: "24px", fontWeight: "bold", color: STATUS_COLORS[statsData.trust.status], textTransform: "capitalize" }}>
            {statsData.trust.status}
          </div>
          <div style={{ fontSize: "13px", color: COLORS.textSecondary, marginTop: "4px" }}>Stage: {statsData.trust.stage} | Score: {statsData.trust.score}</div>
        </div>

        <div style={{ ...SHADOW_CARD, borderLeft: `4px solid ${STAGE_COLORS[statsData.gfi.stage] ?? '#999'}` }}>
          <div style={{ fontSize: "14px", color: COLORS.textMuted, marginBottom: "8px" }}>GFI</div>
          <div style={{ fontSize: "24px", fontWeight: "bold" }}>{statsData.gfi.current}</div>
          <div style={{ fontSize: "13px", color: STAGE_COLORS[statsData.gfi.stage] ?? '#999', marginTop: "4px", textTransform: "capitalize" }}>
            {statsData.gfi.stage}
          </div>
          <div style={{ fontSize: "12px", color: COLORS.textMuted, marginTop: "4px" }}>Peak: {statsData.gfi.peakToday} | Threshold: {statsData.gfi.threshold}</div>
        </div>

        <div style={SHADOW_CARD}>
          <div style={{ fontSize: "14px", color: COLORS.textMuted, marginBottom: "8px" }}>Today</div>
          <div style={{ fontSize: "13px" }}>GFI Blocks: <strong>{statsData.today.gfiBlocks}</strong></div>
          <div style={{ fontSize: "13px" }}>Stage Blocks: <strong>{statsData.today.stageBlocks}</strong></div>
          <div style={{ fontSize: "13px" }}>Bypass Attempts: <strong>{statsData.today.bypassAttempts}</strong></div>
        </div>
      </div>

      {Object.keys(statsData.gfi.sources).length > 0 && (
        <>
          <h2 style={{ marginBottom: "16px" }}>GFI Sources</h2>
          <div style={SHADOW_CARD}>
            {Object.entries(statsData.gfi.sources).map(([source, value]) => (
              <div key={source} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #f0f0f0" }}>
                <span style={{ fontSize: "14px" }}>{source}</span>
                <span style={{ fontSize: "14px", fontWeight: "bold" }}>{value}</span>
              </div>
            ))}
          </div>
        </>
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
              {block.filePath && <span> | File: {block.filePath}</span>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
