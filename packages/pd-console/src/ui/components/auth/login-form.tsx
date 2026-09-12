import * as React from "react";
import { ThemeToggle } from "../theme-toggle.js";
import { setToken, clearToken, checkAuth } from "../../api.js";
import { toast } from "sonner";

/**
 * Login entry for the PD governance workspace.
 *
 * When running inside PD Companion (`window.pdCompanion` present), the stored
 * Owner credential is fetched over IPC and used to connect automatically —
 * the Owner never re-pastes the token for a new browser session. Manual
 * entry remains the fallback for plain-browser access and for a stored
 * credential the server rejects (recovery), and a successful manual login in
 * the Companion persists the token into its encrypted store so the next open
 * auto-connects.
 *
 * The Bearer token stays the only credential: the browser keeps a
 * sessionStorage session cache (same as before), the Companion keeps the
 * only long-term (encrypted) copy.
 */

interface CompanionAuthBridge {
  getConsoleToken(): Promise<{ available: boolean; token?: string }>;
  configureConsoleToken(token: string): Promise<{
    persisted: boolean;
    restartRequested: boolean;
    reason?: string;
    nextAction?: string;
  }>;
}

function getCompanionBridge(): CompanionAuthBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as typeof window & { pdCompanion?: CompanionAuthBridge }).pdCompanion;
}

type Phase =
  | { kind: "checking" } // detecting the Companion credential
  | { kind: "connecting" } // checkAuth in flight
  | { kind: "form" } // manual token entry
  | { kind: "recovery" }; // stored credential rejected by the server

export function LoginForm({ onAuthSuccess }: { onAuthSuccess: () => void }) {
  const [phase, setPhase] = React.useState<Phase>({ kind: "checking" });
  const [token, setTokenInput] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // Auto-restore: ask the Companion for the stored credential and connect
  // without user input. Any failure degrades to manual entry — never a
  // dead-end screen. Runs once per mount (onAuthSuccess is a stable
  // useCallback in App.tsx); the 重新连接 button re-runs it on demand.
  React.useEffect(() => {
    const companion = getCompanionBridge();
    if (companion === undefined) {
      setPhase({ kind: "form" });
      return;
    }
    let cancelled = false;
    void (async () => {
      let status: Awaited<ReturnType<CompanionAuthBridge["getConsoleToken"]>>;
      try {
        status = await companion.getConsoleToken();
      } catch {
        if (!cancelled) setPhase({ kind: "form" });
        return;
      }
      if (cancelled) return;
      if (!status.available || status.token === undefined) {
        setPhase({ kind: "form" });
        return;
      }
      setPhase({ kind: "connecting" });
      setToken(status.token);
      const valid = await checkAuth();
      if (cancelled) return;
      if (valid) {
        onAuthSuccess();
      } else {
        // checkAuth's 401 path already cleared the session token.
        setPhase({ kind: "recovery" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onAuthSuccess]);

  // The 401 redirect appends session_expired=true before auto-restore has had
  // a chance to run; that banner would be wrong ("expired") for a fresh
  // browser session with a valid stored credential, so it is only surfaced on
  // the manual-entry form.
  React.useEffect(() => {
    if (phase.kind !== "form") return;
    if (window.location.hash.includes("session_expired=true")) {
      setError("会话已过期或令牌失效，请重新输入。");
    }
  }, [phase.kind]);

  const persistToCompanion = async (value: string): Promise<void> => {
    const companion = getCompanionBridge();
    if (companion === undefined) return;
    try {
      const result = await companion.configureConsoleToken(value);
      if (!result.persisted) {
        // rc-9: never fake success — the workspace opens, but the Owner must
        // know the credential was NOT durably saved.
        toast.error("已连接，但凭证未能安全保存，下次需重新输入令牌。");
        if (result.nextAction) toast.info(result.nextAction, { duration: 8000 });
        return;
      }
      if (result.reason === "external_console_attached") {
        toast.info("凭证已保存，但当前使用的是外部启动的控制台，重启 Companion 后生效。");
      } else {
        toast.success("Owner 凭证已由 Companion 安全保存，下次打开将自动连接。");
      }
    } catch {
      toast.error("已连接，但凭证未能安全保存，下次需重新输入令牌。");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setError(null);
    setPhase({ kind: "connecting" });
    setToken(trimmed);
    const valid = await checkAuth();
    if (valid) {
      await persistToCompanion(trimmed);
      onAuthSuccess();
    } else {
      setError("访问凭证无效或服务未就绪，请检查后重试。");
      setPhase({ kind: "form" });
    }
  };

  // The detection effect keys on mount, so an honest retry re-enters the
  // route with a clean state instead of duplicating the async body here.
  const retryCompanionConnect = () => {
    setError(null);
    clearToken();
    window.location.reload();
  };

  const showCard = (children: React.ReactNode) => (
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
          <div className="text-[13px] text-ink-3 mt-3">连接 PD 工作台</div>
        </div>
        <div className="border-t border-line my-5" />
        {children}
      </div>
    </div>
  );

  if (phase.kind === "checking" || phase.kind === "connecting") {
    return showCard(
      <div className="flex flex-col items-center gap-4 py-6" data-testid="login-connecting">
        <div className="w-8 h-8 border-2 border-gov border-t-transparent rounded-full animate-spin" />
        <span className="text-[13px] text-ink-3">
          {phase.kind === "checking" ? "正在检测本机 Companion…" : "正在连接 PD 工作台…"}
        </span>
      </div>,
    );
  }

  if (phase.kind === "recovery") {
    return showCard(
      <div className="flex flex-col gap-4" data-testid="login-recovery">
        <p className="text-[13px] text-amber">无法连接 PD 工作台</p>
        <p className="text-[13px] text-ink-3 leading-relaxed">
          原因：Owner 凭证已失效或与本机控制台不匹配。
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={retryCompanionConnect}
            className="w-full py-2 px-4 bg-gov text-paper rounded-[var(--radius-sm)] text-[12.5px] font-medium hover:bg-gov-2 transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-gov"
          >
            重新连接
          </button>
          <button
            type="button"
            onClick={() => {
              clearToken();
              setTokenInput("");
              setError(null);
              setPhase({ kind: "form" });
            }}
            className="w-full py-2 px-4 border border-line text-ink rounded-[var(--radius-sm)] text-[12.5px] font-medium hover:border-gov transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-gov"
          >
            手动输入访问令牌
          </button>
        </div>
        <p className="text-[12px] text-ink-4 leading-relaxed">
          手动输入的新令牌会更新 Companion 中保存的凭证。
        </p>
      </div>,
    );
  }

  return showCard(
    <form onSubmit={handleSubmit}>
      <label
        htmlFor="access-token"
        className="font-mono text-[11px] tracking-[0.08em] text-ink-3 uppercase mb-2 block"
      >
        访问令牌
      </label>
      <input
        id="access-token"
        type="password"
        value={token}
        onChange={(e) => setTokenInput(e.target.value)}
        className="w-full px-3 py-2 bg-panel border border-line rounded-[var(--radius-sm)] font-mono text-[13px] text-ink focus:border-gov focus:outline-2 focus:outline-offset-2 focus:outline-gov transition-colors"
        placeholder="输入访问令牌完成连接"
        autoFocus
      />
      {error && <p className="mt-2 text-[13px] text-amber">{error}</p>}
      <button
        type="submit"
        disabled={!token.trim()}
        className="mt-4 w-full py-2 px-4 bg-gov text-paper rounded-[var(--radius-sm)] text-[12.5px] font-medium hover:bg-gov-2 disabled:opacity-50 transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-gov"
      >
        连接
      </button>
    </form>,
  );
}
