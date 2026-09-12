import * as React from "react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "../theme-toggle.js";
import { setToken, clearToken, checkAuth } from "../../api.js";
import { toast } from "sonner";

/**
 * Login entry for the PD governance workspace.
 *
 * When running inside PD Companion (`window.pdCompanion` present), the stored
 * Owner credential is fetched over IPC and used to connect automatically —
 * the Owner never re-pastes the token for a new browser session. Manual
 * entry remains the fallback for plain-browser access, for a Companion read
 * failure (version skew surfaces a diagnosable message instead of a silent
 * plain form), and for a stored credential the server rejects (recovery); a
 * successful manual login in the Companion persists the token into its
 * encrypted store so the next open auto-connects.
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
  | { kind: "form-with-read-error" } // manual entry + companion read-failure note
  | { kind: "recovery" }; // stored credential rejected by the server

export function LoginForm({ onAuthSuccess }: { onAuthSuccess: () => void }) {
  const { t } = useTranslation();
  const [phase, setPhase] = React.useState<Phase>({ kind: "checking" });
  const [token, setTokenInput] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // Auto-restore: ask the Companion for the stored credential and connect
  // without user input. Absent companion / absent credential degrade to the
  // manual form; a rejected read degrades to the manual form PLUS an
  // observable diagnostic (rc-9) so version skew is not mistaken for "no
  // credential". Runs once per mount (onAuthSuccess is a stable useCallback
  // in App.tsx); the 重新连接 button re-enters the route to re-run it.
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
        if (!cancelled) setPhase({ kind: "form-with-read-error" });
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
        // checkAuth's 401 path only cleared the session when it was still
        // this token (api.ts staleness guard).
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
    if (phase.kind !== "form" && phase.kind !== "form-with-read-error") return;
    if (window.location.hash.includes("session_expired=true")) {
      setError(t("pages.login.errorExpired"));
    }
  }, [phase.kind, t]);

  const persistToCompanion = async (value: string): Promise<void> => {
    const companion = getCompanionBridge();
    if (companion === undefined) return;
    try {
      const result = await companion.configureConsoleToken(value);
      if (!result.persisted) {
        // rc-9: never fake success — the workspace opens, but the Owner must
        // know the credential was NOT durably saved.
        toast.error(t("pages.login.persistFailed"));
        if (result.nextAction) toast.info(result.nextAction, { duration: 8000 });
        return;
      }
      if (result.reason === "external_console_attached") {
        toast.info(t("pages.login.persistAttached"));
      } else {
        toast.success(t("pages.login.persistSucceeded"));
      }
    } catch {
      toast.error(t("pages.login.persistFailed"));
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
      setError(t("pages.login.errorInvalid"));
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
          <div className="text-[13px] text-ink-3 mt-3">{t("pages.login.connectWorkspace")}</div>
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
          {phase.kind === "checking" ? t("pages.login.detecting") : t("pages.login.connecting")}
        </span>
      </div>,
    );
  }

  if (phase.kind === "recovery") {
    return showCard(
      <div className="flex flex-col gap-4" data-testid="login-recovery">
        <p className="text-[13px] text-amber">{t("pages.login.recoveryTitle")}</p>
        <p className="text-[13px] text-ink-3 leading-relaxed">
          {t("pages.login.recoveryReason")}
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={retryCompanionConnect}
            className="w-full py-2 px-4 bg-gov text-paper rounded-[var(--radius-sm)] text-[12.5px] font-medium hover:bg-gov-2 transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-gov"
          >
            {t("pages.login.reconnect")}
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
            {t("pages.login.manualEntry")}
          </button>
        </div>
        <p className="text-[12px] text-ink-4 leading-relaxed">
          {t("pages.login.manualEntryHint")}
        </p>
      </div>,
    );
  }

  const showReadError = phase.kind === "form-with-read-error";
  return showCard(
    <form onSubmit={handleSubmit}>
      {showReadError && (
        <div className="mb-4 border border-amber rounded-[var(--radius-sm)] px-3 py-2" data-testid="login-read-error">
          <p className="text-[12.5px] font-medium text-amber">{t("pages.login.readFailedTitle")}</p>
          <p className="text-[12px] text-ink-3 mt-1 leading-relaxed">{t("pages.login.readFailedHint")}</p>
        </div>
      )}
      <label
        htmlFor="access-token"
        className="font-mono text-[11px] tracking-[0.08em] text-ink-3 uppercase mb-2 block"
      >
        {t("pages.login.accessToken")}
      </label>
      <input
        id="access-token"
        type="password"
        value={token}
        onChange={(e) => setTokenInput(e.target.value)}
        className="w-full px-3 py-2 bg-panel border border-line rounded-[var(--radius-sm)] font-mono text-[13px] text-ink focus:border-gov focus:outline-2 focus:outline-offset-2 focus:outline-gov transition-colors"
        placeholder={t("pages.login.enterAccessToken")}
        autoFocus
      />
      {error && <p className="mt-2 text-[13px] text-amber">{error}</p>}
      <button
        type="submit"
        disabled={!token.trim()}
        className="mt-4 w-full py-2 px-4 bg-gov text-paper rounded-[var(--radius-sm)] text-[12.5px] font-medium hover:bg-gov-2 disabled:opacity-50 transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-gov"
      >
        {t("pages.login.connect")}
      </button>
    </form>,
  );
}
