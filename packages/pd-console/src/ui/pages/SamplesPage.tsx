import { useState, useEffect } from "react";
import { fetchSamples, fetchSampleDetail, reviewSample } from "../api.js";

interface SampleListItem {
  sampleId: string;
  taskId: string;
  title: string;
  description: string;
  reviewStatus: "pending" | "approved" | "rejected";
  confidence: number | null;
  createdAt: string;
}

interface SampleDetail {
  sampleId: string;
  taskId: string;
  title: string;
  description: string;
  reviewStatus: "pending" | "approved" | "rejected";
  confidence: number | null;
  createdAt: string;
  artifactContent: Record<string, unknown> | null;
  recommendation: {
    title?: string;
    text?: string;
    triggerPattern?: string;
    action?: string;
    abstractedPrinciple?: string;
  } | null;
}

interface SamplesData {
  counters: Record<string, number>;
  items: SampleListItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: "#fff7e6", text: "#d48806" },
  approved: { bg: "#f6ffed", text: "#52c41a" },
  rejected: { bg: "#fff2f0", text: "#ff4d4f" },
};

function Badge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? { bg: "#f0f0f0", text: "#666" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "12px",
        fontWeight: 500,
        backgroundColor: colors.bg,
        color: colors.text,
      }}
    >
      {status}
    </span>
  );
}

export function SamplesPage() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SamplesData | null>(null);
  const [selected, setSelected] = useState<SampleDetail | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);

  useEffect(() => {
    fetchSamples(statusFilter, page).then((result) => {
      if (result.success) {
        setData(result.data);
        setError("");
      } else {
        setError(result.error);
      }
    });
  }, [statusFilter, page]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    fetchSampleDetail(selectedId).then((result) => {
      if (result.success) {
        setSelected(result.data);
        setError("");
      } else {
        setError(result.error);
      }
    });
  }, [selectedId]);

  async function handleReview(decision: "approved" | "rejected") {
    if (!selected) return;
    setReviewLoading(true);
    try {
      const result = await reviewSample(selected.sampleId, decision);
      if (result.success) {
        const [samplesResult, detailResult] = await Promise.all([
          fetchSamples(statusFilter, page),
          fetchSampleDetail(selected.sampleId),
        ]);
        if (samplesResult.success) setData(samplesResult.data);
        if (detailResult.success) setSelected(detailResult.data);
      } else {
        setError(result.error);
      }
    } finally {
      setReviewLoading(false);
    }
  }

  if (error && !data) {
    return (
      <div style={{ padding: "24px", color: "#ff4d4f" }}>
        <h3>Error</h3>
        <p>{error}</p>
        <button onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }

  if (!data) {
    return <div style={{ padding: "24px", color: "#888" }}>Loading samples...</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h2 style={{ margin: 0 }}>Samples</h2>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <label style={{ fontSize: "14px", color: "#666" }}>Status:</label>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); setSelectedId(""); }}
            style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid #d9d9d9" }}
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
      </div>

      {Object.keys(data.counters).length > 0 && (
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
          {Object.entries(data.counters).map(([key, value]) => (
            <span key={key} style={{ padding: "4px 12px", borderRadius: "4px", fontSize: "13px", backgroundColor: "#f5f5f5", color: "#555" }}>
              {key}: <strong>{value}</strong>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        <div style={{ border: "1px solid #e8e8e8", borderRadius: "8px", overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #e8e8e8", backgroundColor: "#fafafa", fontWeight: 600, fontSize: "14px" }}>
            Sample Queue ({data.pagination.total})
          </div>
          <div style={{ maxHeight: "500px", overflowY: "auto" }}>
            {data.items.length === 0 && (
              <div style={{ padding: "24px", textAlign: "center", color: "#999" }}>No samples found</div>
            )}
            {data.items.map((item) => (
              <div
                key={item.sampleId}
                onClick={() => setSelectedId(item.sampleId)}
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid #f0f0f0",
                  cursor: "pointer",
                  backgroundColor: selectedId === item.sampleId ? "#e6f4ff" : "transparent",
                  transition: "background-color 0.15s",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: "14px", marginBottom: "4px" }}>{item.title || item.sampleId}</div>
                    <div style={{ fontSize: "12px", color: "#888" }}>{item.description?.slice(0, 80)}{item.description && item.description.length > 80 ? "..." : ""}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
                    <Badge status={item.reviewStatus} />
                    {item.confidence !== null && (
                      <span style={{ fontSize: "12px", color: "#888" }}>Score: {item.confidence}</span>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: "11px", color: "#aaa", marginTop: "4px" }}>{new Date(item.createdAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
          {data.pagination.totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "center", gap: "8px", padding: "12px", borderTop: "1px solid #e8e8e8" }}>
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                style={{ padding: "4px 12px", border: "1px solid #d9d9d9", borderRadius: "4px", cursor: page <= 1 ? "not-allowed" : "pointer", opacity: page <= 1 ? 0.5 : 1 }}
              >
                Prev
              </button>
              <span style={{ lineHeight: "28px", fontSize: "13px", color: "#666" }}>
                Page {data.pagination.page} / {data.pagination.totalPages}
              </span>
              <button
                disabled={page >= data.pagination.totalPages}
                onClick={() => setPage(page + 1)}
                style={{ padding: "4px 12px", border: "1px solid #d9d9d9", borderRadius: "4px", cursor: page >= data.pagination.totalPages ? "not-allowed" : "pointer", opacity: page >= data.pagination.totalPages ? 0.5 : 1 }}
              >
                Next
              </button>
            </div>
          )}
        </div>

        <div style={{ border: "1px solid #e8e8e8", borderRadius: "8px", overflow: "hidden" }}>
          {!selected && (
            <div style={{ padding: "48px 24px", textAlign: "center", color: "#999" }}>
              <div style={{ fontSize: "32px", marginBottom: "8px" }}>📋</div>
              <div>Select a sample to view details</div>
            </div>
          )}
          {selected && (
            <div>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #e8e8e8", backgroundColor: "#fafafa" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "14px" }}>{selected.title || selected.sampleId}</div>
                    <div style={{ fontSize: "12px", color: "#888", marginTop: "2px" }}>
                      {selected.sampleId.slice(0, 12)}... | <Badge status={selected.reviewStatus} />
                      {selected.confidence !== null && ` | Score: ${selected.confidence}`}
                    </div>
                  </div>
                  {selected.reviewStatus === "pending" && (
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        onClick={() => handleReview("approved")}
                        disabled={reviewLoading}
                        style={{
                          padding: "6px 16px",
                          backgroundColor: "#52c41a",
                          color: "white",
                          border: "none",
                          borderRadius: "4px",
                          cursor: reviewLoading ? "not-allowed" : "pointer",
                          fontSize: "13px",
                          fontWeight: 500,
                        }}
                      >
                        {reviewLoading ? "..." : "Approve"}
                      </button>
                      <button
                        onClick={() => handleReview("rejected")}
                        disabled={reviewLoading}
                        style={{
                          padding: "6px 16px",
                          backgroundColor: "transparent",
                          color: "#ff4d4f",
                          border: "1px solid #ff4d4f",
                          borderRadius: "4px",
                          cursor: reviewLoading ? "not-allowed" : "pointer",
                          fontSize: "13px",
                          fontWeight: 500,
                        }}
                      >
                        {reviewLoading ? "..." : "Reject"}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ padding: "16px", maxHeight: "450px", overflowY: "auto" }}>
                {selected.description && (
                  <div style={{ marginBottom: "16px" }}>
                    <h4 style={{ margin: "0 0 8px", fontSize: "13px", color: "#666" }}>Description</h4>
                    <p style={{ margin: 0, fontSize: "14px", lineHeight: 1.6 }}>{selected.description}</p>
                  </div>
                )}

                {selected.recommendation && (
                  <div style={{ marginBottom: "16px" }}>
                    <h4 style={{ margin: "0 0 8px", fontSize: "13px", color: "#666" }}>Recommendation</h4>
                    <div style={{ backgroundColor: "#f9f9f9", padding: "12px", borderRadius: "6px", fontSize: "13px" }}>
                      {selected.recommendation.title && (
                        <div style={{ marginBottom: "8px" }}><strong>Title:</strong> {selected.recommendation.title}</div>
                      )}
                      {selected.recommendation.text && (
                        <div style={{ marginBottom: "8px" }}><strong>Text:</strong> {selected.recommendation.text}</div>
                      )}
                      {selected.recommendation.triggerPattern && (
                        <div style={{ marginBottom: "8px" }}><strong>Trigger Pattern:</strong> <code style={{ backgroundColor: "#f0f0f0", padding: "2px 6px", borderRadius: "3px" }}>{selected.recommendation.triggerPattern}</code></div>
                      )}
                      {selected.recommendation.action && (
                        <div style={{ marginBottom: "8px" }}><strong>Action:</strong> {selected.recommendation.action}</div>
                      )}
                      {selected.recommendation.abstractedPrinciple && (
                        <div><strong>Abstracted Principle:</strong> {selected.recommendation.abstractedPrinciple}</div>
                      )}
                    </div>
                  </div>
                )}

                {selected.artifactContent && (
                  <div>
                    <h4 style={{ margin: "0 0 8px", fontSize: "13px", color: "#666" }}>Artifact Content</h4>
                    <pre style={{
                      backgroundColor: "#f5f5f5",
                      padding: "12px",
                      borderRadius: "6px",
                      fontSize: "12px",
                      overflowX: "auto",
                      maxHeight: "200px",
                      margin: 0,
                    }}>
                      {JSON.stringify(selected.artifactContent, null, 2)}
                    </pre>
                  </div>
                )}

                <div style={{ marginTop: "16px", fontSize: "12px", color: "#aaa" }}>
                  Created: {new Date(selected.createdAt).toLocaleString()} | Task: {selected.taskId.slice(0, 12)}...
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
