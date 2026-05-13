import { useState, useEffect } from "react";
import { fetchEvolutionStats, fetchEvolutionTasks, fetchEvolutionPrinciples, fetchEvolutionQueue } from "../api.js";

interface EvolutionStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  stageDistribution: Array<{ stage: string; count: number }>;
}

interface EvolutionTaskItem {
  taskId: string;
  taskKind: string;
  status: string;
  createdAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

interface EvolutionTasksData {
  items: EvolutionTaskItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

interface PrincipleLifecycleSummary {
  candidate: number;
  probation: number;
  active: number;
  deprecated: number;
  archived: number;
  total: number;
}

interface PrincipleTransition {
  principleId: string;
  status: string;
  text: string;
  triggerPattern: string;
  action: string;
  evaluability: string;
  createdAt: string;
  updatedAt: string;
}

interface EvolutionPrinciplesData {
  summary: PrincipleLifecycleSummary;
  recent: PrincipleTransition[];
}

interface QueueHealthData {
  pendingCount: number;
  retryWaitCount: number;
  countsByTaskKind: Record<string, number>;
  countsByChannel: Record<string, number>;
  invalidMetadataCount: number;
  blockedCount: number;
  dependencyFailedCount: number;
  readyTaskCount: number;
  noReadyTasksReason: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#faad14",
  leased: "#1890ff",
  succeeded: "#52c41a",
  retry_wait: "#722ed1",
  failed: "#ff4d4f",
};

const PRINCIPLE_STATUS_COLORS: Record<string, string> = {
  candidate: "#faad14",
  probation: "#1890ff",
  active: "#52c41a",
  deprecated: "#ff4d4f",
  archived: "#8c8c8c",
};

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ padding: "16px", borderRadius: "8px", backgroundColor: "#fafafa", border: "1px solid #f0f0f0", textAlign: "center", minWidth: "100px" }}>
      <div style={{ fontSize: "28px", fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: "12px", color: "#888", marginTop: "4px" }}>{label}</div>
    </div>
  );
}

export function EvolutionPage() {
  const [stats, setStats] = useState<EvolutionStats | null>(null);
  const [tasks, setTasks] = useState<EvolutionTasksData | null>(null);
  const [principles, setPrinciples] = useState<EvolutionPrinciplesData | null>(null);
  const [queue, setQueue] = useState<QueueHealthData | null>(null);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    Promise.all([
      fetchEvolutionStats(),
      fetchEvolutionPrinciples(),
      fetchEvolutionQueue(),
    ]).then(([statsRes, principlesRes, queueRes]) => {
      if (statsRes.success) setStats(statsRes.data);
      if (principlesRes.success) setPrinciples(principlesRes.data);
      if (queueRes.success) setQueue(queueRes.data);
      setError("");
    }).catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    fetchEvolutionTasks(statusFilter, page).then((result) => {
      if (result.success) {
        setTasks(result.data);
        setError("");
      } else {
        setError(result.error);
      }
    });
  }, [statusFilter, page]);

  if (error && !stats) {
    return (
      <div style={{ padding: "24px", color: "#ff4d4f" }}>
        <h3>Error</h3>
        <p>{error}</p>
        <button onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }

  if (!stats) {
    return <div style={{ padding: "24px", color: "#888" }}>Loading evolution data...</div>;
  }

  return (
    <div>
      <h2 style={{ marginBottom: "16px" }}>Evolution</h2>

      <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
        <StatCard label="Pending" value={stats.pending} color={STATUS_COLORS.pending} />
        <StatCard label="In Progress" value={stats.inProgress} color={STATUS_COLORS.leased} />
        <StatCard label="Completed" value={stats.completed} color={STATUS_COLORS.succeeded} />
        <StatCard label="Failed" value={stats.failed} color={STATUS_COLORS.failed} />
      </div>

      {principles && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "20px" }}>
          <div style={{ border: "1px solid #e8e8e8", borderRadius: "8px", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid #e8e8e8", backgroundColor: "#fafafa", fontWeight: 600, fontSize: "14px" }}>
              Principle Lifecycle
            </div>
            <div style={{ padding: "16px" }}>
              <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
                {Object.entries(principles.summary).filter(([k]) => k !== 'total').map(([key, value]) => (
                  <span key={key} style={{ padding: "4px 12px", borderRadius: "4px", fontSize: "13px", backgroundColor: "#f5f5f5", color: PRINCIPLE_STATUS_COLORS[key] ?? "#555" }}>
                    {key}: <strong>{value}</strong>
                  </span>
                ))}
                <span style={{ padding: "4px 12px", borderRadius: "4px", fontSize: "13px", backgroundColor: "#e6f4ff", color: "#1890ff" }}>
                  total: <strong>{principles.summary.total}</strong>
                </span>
              </div>
              {principles.recent.length > 0 && (
                <div>
                  <h4 style={{ margin: "0 0 8px", fontSize: "13px", color: "#666" }}>Recent Transitions</h4>
                  {principles.recent.slice(0, 5).map((p, i) => (
                    <div key={`${p.principleId}-${i}`} style={{ padding: "8px 0", borderBottom: "1px solid #f5f5f5" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <span style={{ fontWeight: 500, fontSize: "13px" }}>{p.principleId}</span>
                          <span style={{ marginLeft: "8px", padding: "2px 6px", borderRadius: "3px", fontSize: "11px", backgroundColor: PRINCIPLE_STATUS_COLORS[p.status] ? `${PRINCIPLE_STATUS_COLORS[p.status]}20` : "#f0f0f0", color: PRINCIPLE_STATUS_COLORS[p.status] ?? "#666" }}>
                            {p.status}
                          </span>
                        </div>
                        <span style={{ fontSize: "11px", color: "#aaa" }}>{new Date(p.updatedAt).toLocaleString()}</span>
                      </div>
                      <div style={{ fontSize: "12px", color: "#888", marginTop: "4px" }}>{(p.text ?? "").slice(0, 100)}{(p.text ?? "").length > 100 ? "..." : ""}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {queue && (
            <div style={{ border: "1px solid #e8e8e8", borderRadius: "8px", overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #e8e8e8", backgroundColor: "#fafafa", fontWeight: 600, fontSize: "14px" }}>
                Queue Health
              </div>
              <div style={{ padding: "16px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <div style={{ padding: "8px 12px", borderRadius: "4px", backgroundColor: "#fff7e6" }}>
                    <div style={{ fontSize: "20px", fontWeight: 700, color: "#d48806" }}>{queue.pendingCount}</div>
                    <div style={{ fontSize: "12px", color: "#888" }}>Pending</div>
                  </div>
                  <div style={{ padding: "8px 12px", borderRadius: "4px", backgroundColor: "#f6ffed" }}>
                    <div style={{ fontSize: "20px", fontWeight: 700, color: "#52c41a" }}>{queue.readyTaskCount}</div>
                    <div style={{ fontSize: "12px", color: "#888" }}>Ready</div>
                  </div>
                  <div style={{ padding: "8px 12px", borderRadius: "4px", backgroundColor: "#f9f0ff" }}>
                    <div style={{ fontSize: "20px", fontWeight: 700, color: "#722ed1" }}>{queue.retryWaitCount}</div>
                    <div style={{ fontSize: "12px", color: "#888" }}>Retry Wait</div>
                  </div>
                  <div style={{ padding: "8px 12px", borderRadius: "4px", backgroundColor: "#fff2f0" }}>
                    <div style={{ fontSize: "20px", fontWeight: 700, color: "#ff4d4f" }}>{queue.blockedCount}</div>
                    <div style={{ fontSize: "12px", color: "#888" }}>Blocked</div>
                  </div>
                </div>

                {queue.noReadyTasksReason && (
                  <div style={{ marginTop: "12px", padding: "8px 12px", borderRadius: "4px", backgroundColor: "#fff2f0", fontSize: "13px", color: "#cf1322" }}>
                    No ready tasks: {queue.noReadyTasksReason}
                  </div>
                )}

                {Object.keys(queue.countsByTaskKind).length > 0 && (
                  <div style={{ marginTop: "12px" }}>
                    <h4 style={{ margin: "0 0 8px", fontSize: "13px", color: "#666" }}>By Task Kind</h4>
                    {Object.entries(queue.countsByTaskKind).map(([kind, count]) => (
                      <div key={kind} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "13px" }}>
                        <span style={{ color: "#555" }}>{kind}</span>
                        <strong>{count}</strong>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {stats.stageDistribution.length > 0 && (
        <div style={{ border: "1px solid #e8e8e8", borderRadius: "8px", padding: "16px", marginBottom: "20px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: "14px" }}>Stage Distribution</h3>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {stats.stageDistribution.map((stage) => (
              <span key={stage.stage} style={{ padding: "4px 12px", borderRadius: "4px", fontSize: "13px", backgroundColor: "#f5f5f5" }}>
                <span style={{ color: STATUS_COLORS[stage.stage] ?? "#555", fontWeight: 500 }}>{stage.stage}</span>: {stage.count}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ border: "1px solid #e8e8e8", borderRadius: "8px", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #e8e8e8", backgroundColor: "#fafafa", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 600, fontSize: "14px" }}>Tasks</span>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <label style={{ fontSize: "14px", color: "#666" }}>Status:</label>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid #d9d9d9" }}
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="leased">Leased</option>
              <option value="succeeded">Succeeded</option>
              <option value="retry_wait">Retry Wait</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>

        <div style={{ maxHeight: "400px", overflowY: "auto" }}>
          {tasks && tasks.items.length === 0 && (
            <div style={{ padding: "24px", textAlign: "center", color: "#999" }}>No tasks found</div>
          )}
          {tasks && tasks.items.map((task) => (
            <div key={task.taskId} style={{ padding: "10px 16px", borderBottom: "1px solid #f0f0f0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontWeight: 500, fontSize: "13px", color: STATUS_COLORS[task.status] ?? "#555" }}>{task.taskId.slice(0, 16)}...</span>
                  <span style={{ marginLeft: "8px", fontSize: "12px", color: "#888" }}>{task.taskKind}</span>
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <span style={{ padding: "2px 8px", borderRadius: "4px", fontSize: "12px", fontWeight: 500, backgroundColor: `${STATUS_COLORS[task.status] ?? "#666"}20`, color: STATUS_COLORS[task.status] ?? "#666" }}>
                    {task.status}
                  </span>
                  {task.leaseOwner && (
                    <span style={{ fontSize: "11px", color: "#aaa" }}>leased by {task.leaseOwner.slice(0, 8)}</span>
                  )}
                </div>
              </div>
              <div style={{ fontSize: "11px", color: "#aaa", marginTop: "4px" }}>{new Date(task.createdAt).toLocaleString()}</div>
            </div>
          ))}
        </div>

        {tasks && tasks.pagination.totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "center", gap: "8px", padding: "12px", borderTop: "1px solid #e8e8e8" }}>
            <button
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              style={{ padding: "4px 12px", border: "1px solid #d9d9d9", borderRadius: "4px", cursor: page <= 1 ? "not-allowed" : "pointer", opacity: page <= 1 ? 0.5 : 1 }}
            >
              Prev
            </button>
            <span style={{ lineHeight: "28px", fontSize: "13px", color: "#666" }}>
              Page {tasks.pagination.page} / {tasks.pagination.totalPages}
            </span>
            <button
              disabled={page >= tasks.pagination.totalPages}
              onClick={() => setPage(page + 1)}
              style={{ padding: "4px 12px", border: "1px solid #d9d9d9", borderRadius: "4px", cursor: page >= tasks.pagination.totalPages ? "not-allowed" : "pointer", opacity: page >= tasks.pagination.totalPages ? 0.5 : 1 }}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
