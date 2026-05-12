import { useState } from "react";
import { setToken, clearToken, checkAuth } from "../api.js";
import { COLORS } from "../styles/constants.js";

interface LoginPageProps {
  onAuthSuccess: () => void;
}

export function LoginPage({ onAuthSuccess }: LoginPageProps) {
  const [token, setTokenValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Please enter a token");
      return;
    }

    setChecking(true);
    setError(null);

    setToken(trimmed);
    const isValid = await checkAuth();
    setChecking(false);

    if (isValid) {
      onAuthSuccess();
    } else {
      clearToken();
      setError("Invalid token. Please check and try again.");
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#f5f5f5",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <div
        style={{
          width: "400px",
          backgroundColor: "#fff",
          borderRadius: "12px",
          padding: "40px 32px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div style={{ fontSize: "24px", fontWeight: 700, color: COLORS.textPrimary }}>
            PD Console
          </div>
          <div style={{ fontSize: "14px", color: COLORS.textMuted, marginTop: "8px" }}>
            Enter your access token to continue
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <label
            style={{
              display: "block",
              fontSize: "13px",
              fontWeight: 500,
              color: COLORS.textSecondary,
              marginBottom: "6px",
            }}
          >
            Bearer Token
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setTokenValue(e.target.value);
              setError(null);
            }}
            placeholder="Enter access token"
            autoFocus
            style={{
              width: "100%",
              padding: "10px 12px",
              border: error ? "1px solid #ff4d4f" : "1px solid #d9d9d9",
              borderRadius: "6px",
              fontSize: "14px",
              boxSizing: "border-box",
              outline: "none",
            }}
          />

          {error && (
            <div
              style={{
                marginTop: "8px",
                fontSize: "13px",
                color: COLORS.danger,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={checking || !token.trim()}
            style={{
              width: "100%",
              marginTop: "20px",
              padding: "10px",
              border: "none",
              borderRadius: "6px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: checking || !token.trim() ? "not-allowed" : "pointer",
              backgroundColor: checking || !token.trim() ? "#d9d9d9" : COLORS.primary,
              color: "#fff",
              transition: "background-color 0.2s",
            }}
          >
            {checking ? "Verifying..." : "Sign In"}
          </button>
        </form>

        <div
          style={{
            marginTop: "24px",
            paddingTop: "16px",
            borderTop: "1px solid #f0f0f0",
            fontSize: "12px",
            color: COLORS.textMuted,
            textAlign: "center",
          }}
        >
          Token is stored in browser session only.
          <br />
          Use <code style={{ backgroundColor: "#f5f5f5", padding: "1px 4px", borderRadius: "3px" }}>--no-auth</code> flag to disable authentication.
        </div>
      </div>
    </div>
  );
}
