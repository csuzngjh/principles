import * as React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Sun,
  Moon,
  Focus,
  AlertTriangle,
  AlertCircle,
  BookOpen,
  Zap,
  Archive,
  Compass,
  Settings,
  MessageSquare,
  RefreshCw,
  LogOut,
  Languages,
} from "lucide-react";
import { useTheme } from "../theme-provider.js";
import { useTranslation } from "react-i18next";
import { useNotifications } from "../notifications/useNotifications.js";
import { clearToken } from "../../api.js";
import { cn } from "../../../lib/utils.js";

function ThresholdMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M6 4V24M22 4V24M2 14H26" strokeLinecap="square" />
      <circle cx="14" cy="14" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

const mainNavItems = [
  { id: "focus", labelKey: "components.sidebar.focus", href: "/focus", icon: Focus },
  { id: "pain", labelKey: "components.sidebar.pain", href: "/pain", icon: AlertTriangle },
  { id: "principles", labelKey: "components.sidebar.principles", href: "/principles", icon: BookOpen },
  { id: "activation", labelKey: "components.sidebar.activation", href: "/activation", icon: Zap },
  { id: "debt", labelKey: "components.sidebar.debt", href: "/debt", icon: Archive },
  { id: "intent", labelKey: "components.sidebar.intent", href: "/intent", icon: Compass },
];

const toolNavItems = [
  { id: "control-center", labelKey: "components.sidebar.controlCenter", href: "/control-center", icon: Settings },
  { id: "report-problem", labelKey: "components.sidebar.reportProblem", href: "/report-problem", icon: MessageSquare },
  { id: "failed-tasks", labelKey: "components.sidebar.failedTasks", href: "/failed-tasks", icon: AlertCircle },
  { id: "settings", labelKey: "components.sidebar.settings", href: "/settings", icon: Settings },
  { id: "update", labelKey: "components.sidebar.update", href: "/update", icon: RefreshCw },
];

export function AppSidebar({ featureFlags }: { featureFlags?: Record<string, { enabled: boolean }> }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const { t, i18n } = useTranslation();
  const { pendingCount, degradedCount } = useNotifications();

  const isActive = (href: string) => {
    if (href === "/") return location.pathname === "/";
    return location.pathname === href || location.pathname.startsWith(href + "/");
  };

  const handleSignOut = () => {
    clearToken();
    navigate("/login");
  };

  const toggleLanguage = () => {
    const nextLang = i18n.language === "zh-CN" ? "en" : "zh-CN";
    i18n.changeLanguage(nextLang);
    localStorage.setItem("pd-language", nextLang);
  };

  return (
    <aside className="w-[256px] h-screen fixed left-0 top-0 flex flex-col bg-surface border-r border-line flex-shrink-0 z-20">
      {/* Brand area */}
      <div className="px-5 pt-5 pb-4">
        <div className="flex items-center gap-2.5">
          <ThresholdMark className="w-6 h-6 text-gov" />
          <div>
            <div className="font-mono text-[14px] tracking-[0.16em] font-bold text-ink">
              PD
            </div>
            <div className="font-mono text-[10px] tracking-[0.14em] text-ink-3">
              GOVERNANCE WORKSPACE
            </div>
          </div>
        </div>
      </div>

      {/* Main nav */}
      <nav className="flex-1 py-2 overflow-y-auto">
        <div className="px-2">
          {mainNavItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.id}
                to={item.href}
                data-testid={`nav-${item.id}`}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-[var(--radius-sm)] text-[13px] transition-all duration-150",
                  active
                    ? "border-l-2 border-l-gov bg-paper-2 text-ink"
                    : "border-l-2 border-l-transparent text-ink-3 hover:text-ink hover:bg-paper-2"
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span className="flex-1">{t(item.labelKey)}</span>
                {item.id === "focus" && pendingCount > 0 ? (
                  <span
                    className="ml-auto h-2 w-2 rotate-45 rounded-[1px] border border-rose-400/50 bg-rose-400/15 shadow-[0_0_3px_rgba(251,113,133,0.35)]"
                    role="status"
                    aria-label={t("components.sidebar.pendingApprovalsAria", { count: pendingCount })}
                  />
                ) : null}
              </Link>
            );
          })}
        </div>

        {/* Secondary tools */}
        <div className="mt-4 pt-3 border-t border-line mx-4">
          <div className="px-1 pb-1 text-[10px] font-mono tracking-[0.1em] uppercase text-ink-4">
            Tools
          </div>
          <div className="px-0">
            {toolNavItems.map((item) => {
              // Feature-flag gate: failed-tasks entry only shows when
              // failed_tasks_observability is enabled. When featureFlags is
              // undefined (still loading) or the flag is missing, hide the
              // entry to avoid surfacing a page the backend will 403.
              if (item.id === "failed-tasks" && featureFlags?.failed_tasks_observability?.enabled !== true) {
                return null;
              }
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <Link
                  key={item.id}
                  to={item.href}
                  data-testid={`nav-${item.id}`}
                  className={cn(
                    "flex items-center gap-3 px-3 py-1.5 rounded-[var(--radius-sm)] text-[12px] transition-all duration-150",
                    active
                      ? "border-l-2 border-l-gov bg-paper-2 text-ink"
                      : "border-l-2 border-l-transparent text-ink-4 hover:text-ink-3 hover:bg-paper-2"
                  )}
                >
                  <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                  <span className="flex-1">{t(item.labelKey)}</span>
                  {item.id === "control-center" && degradedCount > 0 ? (
                    <span
                      className="ml-auto h-[7px] w-[7px] rotate-45 rounded-[1px] border border-amber-400/50 bg-amber-400/15 shadow-[0_0_3px_rgba(251,191,36,0.35)]"
                      role="status"
                      aria-label={t("components.sidebar.degradedSignalsAria", { count: degradedCount })}
                    />
                  ) : null}
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Bottom actions */}
      <div className="px-3 py-3 border-t border-line space-y-1">
        {/* Theme toggle */}
        <button
          type="button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="flex items-center gap-3 px-3 py-1.5 rounded-[var(--radius-sm)] text-[12px] text-ink-4 hover:text-ink-3 hover:bg-paper-2 transition-colors w-full"
          title={theme === "dark" ? "切换亮色模式" : "切换暗色模式"}
        >
          {theme === "dark" ? (
            <Sun className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          ) : (
            <Moon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          )}
          <span>{theme === "dark" ? "亮色模式" : "暗色模式"}</span>
        </button>

        {/* Language switcher */}
        <button
          type="button"
          onClick={toggleLanguage}
          className="flex items-center gap-3 px-3 py-1.5 rounded-[var(--radius-sm)] text-[12px] text-ink-4 hover:text-ink-3 hover:bg-paper-2 transition-colors w-full"
          title="切换语言"
        >
          <Languages className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span>{i18n.language === "zh-CN" ? "English" : "中文"}</span>
        </button>

        {/* Sign out */}
        <button
          type="button"
          onClick={handleSignOut}
          className="flex items-center gap-3 px-3 py-1.5 rounded-[var(--radius-sm)] text-[12px] text-ink-4 hover:text-ink-3 hover:bg-paper-2 transition-colors w-full"
        >
          <LogOut className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span>退出</span>
        </button>
      </div>
    </aside>
  );
}
