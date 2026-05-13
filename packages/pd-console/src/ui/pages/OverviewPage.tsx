import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { fetchOverview } from "../api.js";
import type { OverviewData } from "../api.js";
import { COLORS, REFRESH_BAR, SHADOW_CARD } from "../styles/constants.js";

const GRID_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: "16px",
  marginBottom: "24px",
};

const STATUS_COLORS: Record<string, string> = {
  healthy: COLORS.success,
  degraded: COLORS.warning,
  error: COLORS.danger,
};

function HealthCard({ health }: { health: OverviewData["health"] }) {
  return (
    <div style={{ ...SHADOW_CARD, borderLeft: `4px solid ${STATUS_COLORS[health.status] ?? '#999'}` }}>
      <div style={{ fontSize: "14px", color: COLORS.textMuted, marginBottom: "8px" }}>Health Status</div>
      <div style={{ fontSize: "24px", fontWeight: "bold", color: STATUS_COLORS[health.status] ?? '#999', textTransform: "capitalize" }}>
        {health.status}
      </div>
      <div style={{ marginTop: "8px", fontSize: "13px", color: COLORS.textSecondary }}>
        GFI: {health.gfi.current} ({health.gfi.stage})
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={SHADOW_CARD}>
      <div style={{ fontSize: "14px", color: COLORS.textMuted, marginBottom: "4px" }}>{label}</div>
      <div style={{ fontSize: "28px", fontWeight: "bold" }}>{value}</div>
    </div>
  );
}

export function OverviewPage() {
  const { data, error, loading, refresh, lastUpdated } = useAutoRefresh<OverviewData>(fetchOverview, 30000);

  if (loading && !data) {
    return <div style={{ padding: "40px", textAlign: "center", color: COLORS.textMuted }}>Loading...</div>;
  }

  if (error && !data) {
    return <div style={{ padding: "24px", color: COLORS.danger }}>Error: {error}</div>;
  }

  if (!data) {
    return <div style={{ padding: "24px", color: COLORS.textMuted }}>No data available</div>;
  }

  return (
    <div>
      <div style={REFRESH_BAR}>
        <h1 style={{ margin: 0 }}>Overview</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {lastUpdated && (
            <span style={{ fontSize: "12px", color: COLORS.textMuted }}>
              Updated: {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={loading}
            style={{
              border: "1px solid #d9d9d9",
              borderRadius: "6px",
              padding: "6px 12px",
              fontSize: "13px",
              cursor: loading ? "not-allowed" : "pointer",
              backgroundColor: "#fff",
            }}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
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
