import { useState, useEffect } from "react";
import { fetchOverview } from "../api.js";
import type { OverviewData } from "../api.js";

const CARD_STYLE: React.CSSProperties = {
  border: "1px solid #e0e0e0",
  borderRadius: "8px",
  padding: "16px",
  backgroundColor: "#fff",
};

const GRID_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: "16px",
  marginBottom: "24px",
};

const STATUS_COLORS: Record<string, string> = {
  healthy: "#52c41a",
  degraded: "#faad14",
  error: "#ff4d4f",
};

function HealthCard({ health }: { health: OverviewData["health"] }) {
  return (
    <div style={{ ...CARD_STYLE, borderLeft: `4px solid ${STATUS_COLORS[health.status] ?? '#999'}` }}>
      <div style={{ fontSize: "14px", color: "#888", marginBottom: "8px" }}>Health Status</div>
      <div style={{ fontSize: "24px", fontWeight: "bold", color: STATUS_COLORS[health.status] ?? '#999', textTransform: "capitalize" }}>
        {health.status}
      </div>
      <div style={{ marginTop: "8px", fontSize: "13px", color: "#666" }}>
        GFI: {health.gfi.current} ({health.gfi.stage})
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={CARD_STYLE}>
      <div style={{ fontSize: "14px", color: "#888", marginBottom: "4px" }}>{label}</div>
      <div style={{ fontSize: "28px", fontWeight: "bold" }}>{value}</div>
    </div>
  );
}

export function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchOverview().then((result) => {
      if (cancelled) return;
      if (result.success) {
        setData(result.data);
      } else {
        setError(result.error);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div style={{ padding: "24px", textAlign: "center", color: "#888" }}>Loading...</div>;
  }

  if (error) {
    return <div style={{ padding: "24px", color: "#ff4d4f" }}>Error: {error}</div>;
  }

  if (!data) {
    return <div style={{ padding: "24px", color: "#888" }}>No data available</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h1 style={{ margin: 0 }}>Overview</h1>
        <span style={{ fontSize: "12px", color: "#999" }}>Updated: {new Date(data.generatedAt).toLocaleTimeString()}</span>
      </div>

      <HealthCard health={data.health} />

      <h2 style={{ marginTop: "24px", marginBottom: "16px" }}>Summary</h2>
      <div style={GRID_STYLE}>
        <StatCard label="Principles" value={data.summary.principleEventCount} />
        <StatCard label="Pain Events" value={data.summary.painEvents} />
        <StatCard label="Pending Samples" value={data.summary.pendingSamples} />
        <StatCard label="Approved Samples" value={data.summary.approvedSamples} />
        <StatCard label="Task Outcomes" value={data.summary.taskOutcomes} />
        <StatCard label="Gate Blocks" value={data.summary.gateBlocks} />
      </div>

      <h2 style={{ marginTop: "24px", marginBottom: "16px" }}>Principles Breakdown</h2>
      <div style={GRID_STYLE}>
        <StatCard label="Active" value={data.health.principles.active} />
        <StatCard label="Candidate" value={data.health.principles.candidate} />
        <StatCard label="Probation" value={data.health.principles.probation} />
        <StatCard label="Deprecated" value={data.health.principles.deprecated} />
      </div>

      <h2 style={{ marginTop: "24px", marginBottom: "16px" }}>Queue</h2>
      <div style={GRID_STYLE}>
        <StatCard label="Pending" value={data.health.queue.pending} />
        <StatCard label="In Progress" value={data.health.queue.inProgress} />
        <StatCard label="Completed" value={data.health.queue.completed} />
      </div>
    </div>
  );
}
