import { useState, useEffect } from "react";
import { getToken, setToken, fetchWorkspaces, addWorkspace, removeWorkspace, syncWorkspace } from "../api.js";
import type { WorkspaceEntry } from "../api.js";

const CARD_STYLE: React.CSSProperties = {
  border: "1px solid #e0e0e0",
  borderRadius: "8px",
  padding: "16px",
  backgroundColor: "#fff",
  marginBottom: "16px",
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  border: "1px solid #d9d9d9",
  borderRadius: "6px",
  fontSize: "14px",
  marginTop: "4px",
  boxSizing: "border-box",
};

const BUTTON_STYLE: React.CSSProperties = {
  border: "none",
  borderRadius: "6px",
  padding: "8px 16px",
  fontSize: "13px",
  cursor: "pointer",
  fontWeight: 500,
};

const PRIMARY_BUTTON: React.CSSProperties = {
  ...BUTTON_STYLE,
  backgroundColor: "#1677ff",
  color: "#fff",
};

const DANGER_BUTTON: React.CSSProperties = {
  ...BUTTON_STYLE,
  backgroundColor: "#ff4d4f",
  color: "#fff",
};

const SUCCESS_MSG_STYLE: React.CSSProperties = {
  marginTop: "12px",
  padding: "8px 12px",
  backgroundColor: "#f6ffed",
  border: "1px solid #b7eb8f",
  borderRadius: "4px",
  color: "#52c41a",
  fontSize: "13px",
};

function AuthSettings() {
  const [tokenValue, setTokenValue] = useState(() => getToken() ?? "");
  const [saved, setSaved] = useState(false);

  function handleSave() {
    const trimmed = tokenValue.trim();
    if (!trimmed) return;
    setToken(trimmed);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <div style={CARD_STYLE}>
      <h3 style={{ marginTop: 0 }}>Authentication</h3>
      <label style={{ display: "block", marginBottom: "8px", fontSize: "14px", fontWeight: 500, color: "#333" }}>
        Bearer Token
        <input
          type="password"
          value={tokenValue}
          onChange={(e) => { setTokenValue(e.target.value); setSaved(false); }}
          placeholder="Enter access token"
          style={INPUT_STYLE}
        />
      </label>
      <button onClick={handleSave} style={PRIMARY_BUTTON}>Save</button>
      {saved && <div style={SUCCESS_MSG_STYLE}>Token saved</div>}
      <p style={{ marginTop: "12px", color: "#999", fontSize: "13px" }}>
        Token is stored in the browser session and will be cleared when the tab is closed.
      </p>
    </div>
  );
}

function WorkspaceManager() {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetchWorkspaces().then((r) => {
      if (r.success) setWorkspaces(r.data);
    });
  }, []);

  function showMessage(type: "success" | "error", text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }

  async function handleAdd() {
    if (!newName.trim() || !newPath.trim()) return;
    const result = await addWorkspace(newName.trim(), newPath.trim());
    if (result.success) {
      setWorkspaces([...workspaces, result.data]);
      setNewName("");
      setNewPath("");
      showMessage("success", `Workspace "${newName}" added`);
    } else {
      showMessage("error", result.error);
    }
  }

  async function handleRemove(name: string) {
    const result = await removeWorkspace(name);
    if (result.success) {
      setWorkspaces(workspaces.filter(w => w.name !== name));
      showMessage("success", `Workspace "${name}" removed`);
    } else {
      showMessage("error", result.error);
    }
  }

  async function handleSync(name: string) {
    const result = await syncWorkspace(name);
    if (result.success) {
      showMessage("success", `Workspace "${name}" synced`);
      const refreshResult = await fetchWorkspaces();
      if (refreshResult.success) setWorkspaces(refreshResult.data);
    } else {
      showMessage("error", result.error);
    }
  }

  return (
    <div style={CARD_STYLE}>
      <h3 style={{ marginTop: 0 }}>Workspaces</h3>

      {workspaces.length === 0 ? (
        <div style={{ padding: "12px", color: "#888", fontSize: "14px" }}>No workspaces configured</div>
      ) : (
        workspaces.map((ws) => (
          <div key={ws.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #f0f0f0" }}>
            <div>
              <div style={{ fontWeight: "bold", fontSize: "14px" }}>{ws.config?.displayName ?? ws.name}</div>
              <div style={{ fontSize: "12px", color: "#888" }}>{ws.path}</div>
              {ws.lastSync && <div style={{ fontSize: "11px", color: "#999" }}>Last sync: {new Date(ws.lastSync).toLocaleString()}</div>}
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => handleSync(ws.name)} style={PRIMARY_BUTTON}>Sync</button>
              <button onClick={() => handleRemove(ws.name)} style={DANGER_BUTTON}>Remove</button>
            </div>
          </div>
        ))
      )}

      <div style={{ marginTop: "16px", paddingTop: "16px", borderTop: "1px solid #e0e0e0" }}>
        <h4 style={{ margin: "0 0 12px" }}>Add Workspace</h4>
        <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: "13px", color: "#666" }}>Name</label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-workspace" style={INPUT_STYLE} />
          </div>
          <div style={{ flex: 2 }}>
            <label style={{ fontSize: "13px", color: "#666" }}>Path</label>
            <input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="/path/to/workspace" style={INPUT_STYLE} />
          </div>
          <button onClick={handleAdd} style={PRIMARY_BUTTON} disabled={!newName.trim() || !newPath.trim()}>Add</button>
        </div>
      </div>

      {message && (
        <div style={{ marginTop: "12px", padding: "8px 12px", borderRadius: "4px", fontSize: "13px",
          ...(message.type === "success" ? { backgroundColor: "#f6ffed", border: "1px solid #b7eb8f", color: "#52c41a" } : { backgroundColor: "#fff2f0", border: "1px solid #ffccc7", color: "#ff4d4f" })
        }}>
          {message.text}
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  return (
    <div style={{ maxWidth: "640px" }}>
      <h1 style={{ marginBottom: "24px" }}>Settings</h1>
      <AuthSettings />
      <WorkspaceManager />
    </div>
  );
}
