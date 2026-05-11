import { useState } from "react";
import { getToken, setToken } from "../api.js";

const CONTAINER_STYLE: React.CSSProperties = {
  maxWidth: "480px",
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  marginBottom: "8px",
  fontSize: "14px",
  fontWeight: 500,
  color: "#333",
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

const SAVE_BUTTON_STYLE: React.CSSProperties = {
  marginTop: "16px",
  border: "none",
  borderRadius: "6px",
  padding: "8px 24px",
  fontSize: "14px",
  cursor: "pointer",
  fontWeight: 500,
  backgroundColor: "#1677ff",
  color: "#ffffff",
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

export function SettingsPage() {
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
    <div style={CONTAINER_STYLE}>
      <h2 style={{ marginBottom: "20px" }}>设置</h2>
      <label style={LABEL_STYLE}>
        访问令牌 (Bearer Token)
        <input
          type="password"
          value={tokenValue}
          onChange={(e) => { setTokenValue(e.target.value); setSaved(false); }}
          placeholder="请输入访问令牌"
          style={INPUT_STYLE}
        />
      </label>
      <button onClick={handleSave} style={SAVE_BUTTON_STYLE}>
        保存
      </button>
      {saved && <div style={SUCCESS_MSG_STYLE}>令牌已保存</div>}
      <p style={{ marginTop: "16px", color: "#999", fontSize: "13px" }}>
        令牌存储在浏览器当前会话中，关闭标签页后将清除。
      </p>
    </div>
  );
}
