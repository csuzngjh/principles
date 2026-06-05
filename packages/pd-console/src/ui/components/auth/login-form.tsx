import * as React from "react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "../theme-toggle.js";
import { setToken, checkAuth } from "../../api.js";

export function LoginForm({ onAuthSuccess }: { onAuthSuccess: () => void }) {
  const [token, setTokenInput] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const { t } = useTranslation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setLoading(true);
    setError(null);
    setToken(token.trim());
    const valid = await checkAuth();
    if (valid) {
      onAuthSuccess();
    } else {
      setError("令牌无效或服务未就绪，请检查后重试。");
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-paper relative"
      style={{
        backgroundImage: `linear-gradient(color-mix(in srgb, var(--color-gov) 3.5%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--color-gov) 3.5%, transparent) 1px, transparent 1px)`,
        backgroundSize: "32px 32px",
      }}
    >
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[400px] mx-4 p-8 bg-surface rounded-[var(--radius-md)] border border-line shadow-card">
        <div className="flex flex-col items-center mb-6">
          <svg
            viewBox="0 0 28 28"
            className="w-12 h-12 text-gov mb-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M6 4V24M22 4V24M2 14H26" strokeLinecap="square" />
            <circle cx="14" cy="14" r="2.5" fill="currentColor" stroke="none" />
          </svg>
          <div className="font-mono text-[14px] tracking-[0.16em] font-bold text-ink">PD</div>
          <div className="font-mono text-[11px] tracking-[0.14em] text-ink-3 mt-1">
            GOVERNANCE WORKSPACE
          </div>
          <div className="text-[13px] text-ink-3 mt-3">拥有者治理工作台</div>
        </div>
        <div className="border-t border-line my-5" />
        <form onSubmit={handleSubmit}>
          <label
            htmlFor="bearer-token"
            className="font-mono text-[11px] tracking-[0.08em] text-ink-3 uppercase mb-2 block"
          >
            Bearer Token
          </label>
          <input
            id="bearer-token"
            type="password"
            value={token}
            onChange={(e) => setTokenInput(e.target.value)}
            className="w-full px-3 py-2 bg-panel border border-line rounded-[var(--radius-sm)] font-mono text-[13px] text-ink focus:border-gov focus:outline-2 focus:outline-offset-2 focus:outline-gov transition-colors"
            placeholder="输入令牌…"
            autoFocus
          />
          {error && <p className="mt-2 text-[13px] text-amber">{error}</p>}
          <button
            type="submit"
            disabled={loading || !token.trim()}
            className="mt-4 w-full py-2 px-4 bg-gov text-paper rounded-[var(--radius-sm)] text-[12.5px] font-medium hover:bg-gov-2 disabled:opacity-50 transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-gov"
          >
            {loading ? "验证中…" : "进入工作台"}
          </button>
        </form>
      </div>
    </div>
  );
}
