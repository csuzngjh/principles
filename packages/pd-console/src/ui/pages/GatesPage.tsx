import { useState, useEffect } from "react";
import { fetchGateStats, fetchGateBlocks } from "../api.js";
import type { GateStats, GateBlockItem } from "../api.js";

const CARD_STYLE: React.CSSProperties = {
  border: "1px solid #e0e0e0",
  borderRadius: "8px",
  padding: "16px",
  backgroundColor: "#fff",
  marginBottom: "16px",
};

const STATUS_COLORS: Record<string, string> = {
  healthy: "#52c41a",
  warning: "#faad14",
  critical: "#ff4d4f",
};

const STAGE_COLORS: Record<string, string> = {
  stable: "#52c41a",
  elevated: "#faad14",
  critical: "#ff4d4f",
  saturated: "#722ed1",
};

export function GatesPage() {
  const [stats, setStats] = useState<GateStats | null>(null);
  const [blocks, setBlocks] = useState<GateBlockItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGateStats().then((r) => { if (r.success) setStats(r.data); else setError(r.error); });
    fetchGateBlocks(50).then((r) => { if (r.success) setBlocks(r.data); });
  }, []);

  if (error) {
    return <div style={{ padding: "24px", color: "#ff4d4f" }}>Error: {error}</div>;
  }

  if (!stats) {
    return <div style={{ padding: "24px", textAlign: "center", color: "#888" }}>Loading...</div>;
  }

  return (
    <div>
      <h1 style={{ marginBottom: "24px" }}>Gate Monitor</h1>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        <div style={{ ...CARD_STYLE, borderLeft: `4px solid ${STATUS_COLORS[stats.trust.status]}` }}>
          <div style={{ fontSize: "14px", color: "#888", marginBottom: "8px" }}>Trust Status</div>
          <div style={{ fontSize: "24px", fontWeight: "bold", color: STATUS_COLORS[stats.trust.status], textTransform: "capitalize" }}>
            {stats.trust.status}
          </div>
          <div style={{ fontSize: "13px", color: "#666", marginTop: "4px" }}>Stage: {stats.trust.stage} | Score: {stats.trust.score}</div>
        </div>

        <div style={{ ...CARD_STYLE, borderLeft: `4px solid ${STAGE_COLORS[stats.gfi.stage] ?? '#999'}` }}>
          <div style={{ fontSize: "14px", color: "#888", marginBottom: "8px" }}>GFI</div>
          <div style={{ fontSize: "24px", fontWeight: "bold" }}>{stats.gfi.current}</div>
          <div style={{ fontSize: "13px", color: STAGE_COLORS[stats.gfi.stage] ?? '#999', marginTop: "4px", textTransform: "capitalize" }}>
            {stats.gfi.stage}
          </div>
          <div style={{ fontSize: "12px", color: "#999", marginTop: "4px" }}>Peak: {stats.gfi.peakToday} | Threshold: {stats.gfi.threshold}</div>
        </div>

        <div style={CARD_STYLE}>
          <div style={{ fontSize: "14px", color: "#888", marginBottom: "8px" }}>Today</div>
          <div style={{ fontSize: "13px" }}>GFI Blocks: <strong>{stats.today.gfiBlocks}</strong></div>
          <div style={{ fontSize: "13px" }}>Stage Blocks: <strong>{stats.today.stageBlocks}</strong></div>
          <div style={{ fontSize: "13px" }}>Bypass Attempts: <strong>{stats.today.bypassAttempts}</strong></div>
        </div>
      </div>

      {Object.keys(stats.gfi.sources).length > 0 && (
        <>
          <h2 style={{ marginBottom: "16px" }}>GFI Sources</h2>
          <div style={CARD_STYLE}>
            {Object.entries(stats.gfi.sources).map(([source, value]) => (
              <div key={source} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #f0f0f0" }}>
                <span style={{ fontSize: "14px" }}>{source}</span>
                <span style={{ fontSize: "14px", fontWeight: "bold" }}>{value}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 style={{ marginTop: "24px", marginBottom: "16px" }}>Gate Blocks</h2>
      {blocks.length === 0 ? (
        <div style={{ color: "#888", padding: "16px" }}>No gate blocks recorded</div>
      ) : (
        blocks.map((block, i) => (
          <div key={i} style={{ ...CARD_STYLE, borderLeft: "4px solid #ff4d4f" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: "bold" }}>{block.toolName}</span>
              <span style={{ fontSize: "12px", color: "#999" }}>{new Date(block.timestamp).toLocaleString()}</span>
            </div>
            <div style={{ marginTop: "8px", fontSize: "14px" }}>{block.reason}</div>
            <div style={{ marginTop: "4px", fontSize: "12px", color: "#888" }}>
              Type: {block.gateType} | GFI: {block.gfi} | Trust Stage: {block.trustStage}
              {block.filePath && <span> | File: {block.filePath}</span>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
