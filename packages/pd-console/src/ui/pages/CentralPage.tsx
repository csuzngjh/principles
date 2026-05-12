import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { fetchCentralOverview, fetchCentralHealth } from "../api.js";
import type { CentralOverview, CentralHealth } from "../api.js";
import { COLORS, REFRESH_BAR, SHADOW_CARD } from "../styles/constants.js";

const STATUS_COLORS: Record<string, string> = {
  healthy: COLORS.success,
  degraded: COLORS.warning,
  error: COLORS.danger,
};

const STATUS_BG: Record<string, string> = {
  healthy: "#f6ffed",
  degraded: "#fffbe6",
  error: "#fff2f0",
};

function OverallStatusBadge({ status }: { status: string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 16px",
        borderRadius: "20px",
        backgroundColor: STATUS_BG[status] ?? "#f5f5f5",
        border: `1px solid ${STATUS_COLORS[status] ?? "#d9d9d9"}`,
      }}
    >
      <div
        style={{
          width: "10px",
          height: "10px",
          borderRadius: "50%",
          backgroundColor: STATUS_COLORS[status] ?? "#999",
        }}
      />
      <span style={{ fontWeight: 600, color: STATUS_COLORS[status] ?? "#666", textTransform: "capitalize", fontSize: "14px" }}>
        {status}
      </span>
    </div>
  );
}

function WorkspaceCard({ ws }: { ws: CentralOverview["workspaces"][number] }) {
  return (
    <div
      style={{
        ...SHADOW_CARD,
        borderLeft: `4px solid ${STATUS_COLORS[ws.status] ?? "#999"}`,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div>
        <div style={{ fontSize: "16px", fontWeight: 600, color: COLORS.textPrimary }}>
          {ws.name}
        </div>
        <div style={{ fontSize: "12px", color: COLORS.textMuted, marginTop: "2px" }}>
          {ws.path}
        </div>
      </div>
      <div style={{ display: "flex", gap: "24px", alignItems: "center" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "20px", fontWeight: 700, color: ws.gfi >= 0 ? COLORS.textPrimary : COLORS.textMuted }}>
            {ws.gfi >= 0 ? ws.gfi : "N/A"}
          </div>
          <div style={{ fontSize: "11px", color: COLORS.textMuted }}>GFI</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "20px", fontWeight: 700, color: COLORS.textPrimary }}>
            {ws.principleCount}
          </div>
          <div style={{ fontSize: "11px", color: COLORS.textMuted }}>Principles</div>
        </div>
        <OverallStatusBadge status={ws.status} />
      </div>
    </div>
  );
}

function HealthDetailCard({ ws }: { ws: CentralHealth["workspaces"][number] }) {
  return (
    <div
      style={{
        ...SHADOW_CARD,
        borderLeft: `4px solid ${STATUS_COLORS[ws.status] ?? "#999"}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <span style={{ fontWeight: 600, fontSize: "15px", color: COLORS.textPrimary }}>{ws.name}</span>
        <OverallStatusBadge status={ws.status} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
        <div style={{ textAlign: "center", padding: "8px", backgroundColor: "#fafafa", borderRadius: "6px" }}>
          <div style={{ fontSize: "18px", fontWeight: 700 }}>{ws.gfi >= 0 ? ws.gfi : "N/A"}</div>
          <div style={{ fontSize: "11px", color: COLORS.textMuted }}>GFI</div>
        </div>
        <div style={{ textAlign: "center", padding: "8px", backgroundColor: "#fafafa", borderRadius: "6px" }}>
          <div style={{ fontSize: "18px", fontWeight: 700 }}>{ws.activePrinciples}</div>
          <div style={{ fontSize: "11px", color: COLORS.textMuted }}>Active Principles</div>
        </div>
        <div style={{ textAlign: "center", padding: "8px", backgroundColor: "#fafafa", borderRadius: "6px" }}>
          <div style={{ fontSize: "18px", fontWeight: 700 }}>{ws.pendingTasks}</div>
          <div style={{ fontSize: "11px", color: COLORS.textMuted }}>Pending Tasks</div>
        </div>
      </div>
    </div>
  );
}

export function CentralPage() {
  const overview = useAutoRefresh<CentralOverview>(fetchCentralOverview, 30000);
  const health = useAutoRefresh<CentralHealth>(fetchCentralHealth, 30000);

  const overviewData = overview.data;
  const healthData = health.data;
  const isLoading = overview.loading && !overviewData;
  const hasError = overview.error && !overviewData;

  if (isLoading) {
    return <div style={{ padding: "40px", textAlign: "center", color: COLORS.textMuted }}>Loading...</div>;
  }

  if (hasError) {
    return (
      <div style={{ padding: "24px", color: COLORS.danger, backgroundColor: "#fff2f0", borderRadius: "8px" }}>
        Error: {overview.error}
      </div>
    );
  }

  if (!overviewData) {
    return <div style={{ padding: "24px", color: COLORS.textMuted }}>No workspace data available</div>;
  }

  const overallStatus = healthData?.overallStatus ?? "error";
  const healthyCount = overviewData.workspaces.filter((w) => w.status === "healthy").length;
  const degradedCount = overviewData.workspaces.filter((w) => w.status === "degraded").length;
  const errorCount = overviewData.workspaces.filter((w) => w.status === "error").length;

  return (
    <div>
      <div style={REFRESH_BAR}>
        <h1 style={{ margin: 0 }}>Central Overview</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {overview.lastUpdated && (
            <span style={{ fontSize: "12px", color: COLORS.textMuted }}>
              Updated: {new Date(overview.lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => { overview.refresh(); health.refresh(); }}
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

      <div
        style={{
          ...SHADOW_CARD,
          padding: "20px 24px",
          marginBottom: "24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontSize: "14px", color: COLORS.textMuted, marginBottom: "4px" }}>Overall System Status</div>
          <OverallStatusBadge status={overallStatus} />
        </div>
        <div style={{ display: "flex", gap: "24px" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "28px", fontWeight: 700, color: COLORS.success }}>{healthyCount}</div>
            <div style={{ fontSize: "12px", color: COLORS.textMuted }}>Healthy</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "28px", fontWeight: 700, color: COLORS.warning }}>{degradedCount}</div>
            <div style={{ fontSize: "12px", color: COLORS.textMuted }}>Degraded</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "28px", fontWeight: 700, color: COLORS.danger }}>{errorCount}</div>
            <div style={{ fontSize: "12px", color: COLORS.textMuted }}>Error</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "28px", fontWeight: 700 }}>{overviewData.workspaceCount}</div>
            <div style={{ fontSize: "12px", color: COLORS.textMuted }}>Total</div>
          </div>
        </div>
      </div>

      <h2 style={{ marginBottom: "16px" }}>Workspaces</h2>
      {overviewData.workspaces.length === 0 ? (
        <div style={{ padding: "24px", textAlign: "center", color: COLORS.textMuted }}>
          No workspaces configured. Go to Settings to add workspaces.
        </div>
      ) : (
        overviewData.workspaces.map((ws) => <WorkspaceCard key={ws.name} ws={ws} />)
      )}

      {healthData && healthData.workspaces.length > 0 && (
        <>
          <h2 style={{ marginTop: "32px", marginBottom: "16px" }}>Health Details</h2>
          {healthData.workspaces.map((ws) => <HealthDetailCard key={ws.name} ws={ws} />)}
        </>
      )}
    </div>
  );
}
