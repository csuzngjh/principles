import { useState, useEffect } from "react";
import { fetchThinkingModels } from "../api.js";

interface ThinkingOsDirective {
  id: string;
  name: string;
  trigger: string;
  must: string;
  forbidden: string;
}

interface ThinkingModelOverview {
  totalModels: number;
  models: ThinkingOsDirective[];
  source: string;
}

export function ThinkingModelsPage() {
  const [data, setData] = useState<ThinkingModelOverview | null>(null);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    fetchThinkingModels().then((result) => {
      if (result.success) {
        setData(result.data);
        setError("");
      } else {
        setError(result.error);
      }
    });
  }, []);

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
    return <div style={{ padding: "24px", color: "#888" }}>Loading thinking models...</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h2 style={{ margin: 0 }}>Thinking Models</h2>
        <span style={{ fontSize: "13px", color: "#888" }}>
          {data.totalModels} models | Source: {data.source}
        </span>
      </div>

      {data.totalModels === 0 && (
        <div style={{ padding: "48px 24px", textAlign: "center", border: "1px solid #e8e8e8", borderRadius: "8px" }}>
          <div style={{ fontSize: "32px", marginBottom: "8px" }}>🧠</div>
          <div style={{ color: "#999", marginBottom: "8px" }}>No thinking models found</div>
          <div style={{ fontSize: "13px", color: "#bbb" }}>
            Place a THINKING_OS.md file in the workspace root or .state directory
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {data.models.map((model) => (
          <div
            key={model.id}
            style={{ border: "1px solid #e8e8e8", borderRadius: "8px", overflow: "hidden" }}
          >
            <div
              onClick={() => setExpandedId(expandedId === model.id ? null : model.id)}
              style={{
                padding: "12px 16px",
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                backgroundColor: expandedId === model.id ? "#f0f5ff" : "#fafafa",
                transition: "background-color 0.15s",
              }}
            >
              <div>
                <span style={{ fontWeight: 600, fontSize: "14px", color: "#1890ff" }}>{model.id}</span>
                <span style={{ marginLeft: "8px", fontSize: "14px" }}>{model.name}</span>
              </div>
              <span style={{ fontSize: "12px", color: "#aaa" }}>
                {expandedId === model.id ? "▲" : "▼"}
              </span>
            </div>

            {expandedId === model.id && (
              <div style={{ padding: "16px", borderTop: "1px solid #e8e8e8" }}>
                {model.trigger && (
                  <div style={{ marginBottom: "16px" }}>
                    <h4 style={{ margin: "0 0 8px", fontSize: "13px", color: "#666" }}>Trigger</h4>
                    <div style={{ backgroundColor: "#f9f9f9", padding: "12px", borderRadius: "6px", fontSize: "13px", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                      {model.trigger}
                    </div>
                  </div>
                )}

                {model.must && (
                  <div style={{ marginBottom: "16px" }}>
                    <h4 style={{ margin: "0 0 8px", fontSize: "13px", color: "#666" }}>Must (Requirements)</h4>
                    <div style={{ backgroundColor: "#f6ffed", padding: "12px", borderRadius: "6px", fontSize: "13px", lineHeight: 1.6, whiteSpace: "pre-wrap", borderLeft: "3px solid #52c41a" }}>
                      {model.must}
                    </div>
                  </div>
                )}

                {model.forbidden && (
                  <div>
                    <h4 style={{ margin: "0 0 8px", fontSize: "13px", color: "#666" }}>Forbidden (Anti-patterns)</h4>
                    <div style={{ backgroundColor: "#fff2f0", padding: "12px", borderRadius: "6px", fontSize: "13px", lineHeight: 1.6, whiteSpace: "pre-wrap", borderLeft: "3px solid #ff4d4f" }}>
                      {model.forbidden}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
