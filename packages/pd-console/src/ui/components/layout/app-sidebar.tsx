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
  Menu,
} from "lucide-react";
import { useTheme } from "../theme-provider.js";
import { useTranslation } from "react-i18next";
import { useNotifications } from "../notifications/useNotifications.js";
import { clearToken } from "../../api.js";
import { cn } from "../../../lib/utils.js";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "../ui/sheet.js";

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

/**
 * Shared sidebar body — rendered by the desktop aside and by the narrow-screen
 * drawer (SPEC-PD-UIUX-001 R3). Display-only: navigation targets and flags are
 * unchanged; `onNavigate` lets the drawer close after a selection.
 */
function SidebarContent({
  featureFlags,
  onNavigate,
  touchTargets,
}: {
  featureFlags?: Record<string, { enabled: boolean }>;
  onNavigate?: () => void;
  touchTargets?: boolean;
}) {
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
    <>
      {/* Main nav */}
      <nav className="flex-1 py-2 overflow-y-auto" aria-label={t("components.sidebar.navigation", { defaultValue: "主导航" })}>
        <div className="px-2">
          {mainNavItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.id}
                to={item.href}
                data-testid={`nav-${item.id}`}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 px-3 rounded-[var(--radius-sm)] text-[13px] transition-all duration-150",
                  touchTargets ? "min-h-[44px] py-2" : "py-2",
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
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-3 px-3 rounded-[var(--radius-sm)] text-[12px] transition-all duration-150",
                    touchTargets ? "min-h-[44px] py-2" : "py-1.5",
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
          className={cn(
            "flex items-center gap-3 px-3 rounded-[var(--radius-sm)] text-[12px] text-ink-4 hover:text-ink-3 hover:bg-paper-2 transition-colors w-full",
            touchTargets ? "min-h-[44px] py-2" : "py-1.5"
          )}
          title={theme === "dark" ? t("components.sidebar.themeToLight") : t("components.sidebar.themeToDark")}
        >
          {theme === "dark" ? (
            <Sun className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          ) : (
            <Moon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          )}
          <span>{theme === "dark" ? t("components.sidebar.themeToLight") : t("components.sidebar.themeToDark")}</span>
        </button>

        {/* Language switcher */}
        <button
          type="button"
          onClick={toggleLanguage}
          className={cn(
            "flex items-center gap-3 px-3 rounded-[var(--radius-sm)] text-[12px] text-ink-4 hover:text-ink-3 hover:bg-paper-2 transition-colors w-full",
            touchTargets ? "min-h-[44px] py-2" : "py-1.5"
          )}
          title={t("components.sidebar.switchLanguage")}
        >
          <Languages className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span>{i18n.language === "zh-CN" ? "English" : "中文"}</span>
        </button>

        {/* Sign out */}
        <button
          type="button"
          onClick={handleSignOut}
          className={cn(
            "flex items-center gap-3 px-3 rounded-[var(--radius-sm)] text-[12px] text-ink-4 hover:text-ink-3 hover:bg-paper-2 transition-colors w-full",
            touchTargets ? "min-h-[44px] py-2" : "py-1.5"
          )}
        >
          <LogOut className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span>{t("components.sidebar.signOut")}</span>
        </button>
      </div>
    </>
  );
}

export function AppSidebar({ featureFlags }: { featureFlags?: Record<string, { enabled: boolean }> }) {
  return (
    <aside className="w-[256px] h-screen fixed left-0 top-0 hidden lg:flex flex-col bg-surface border-r border-line flex-shrink-0 z-20">
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
      <SidebarContent featureFlags={featureFlags} />
    </aside>
  );
}

/**
 * Narrow-screen shell replacement for the fixed 256px sidebar (R3): a top bar
 * with a 44px menu button opening a left Sheet drawer. Radix Dialog provides
 * focus trapping, Esc-to-close and focus return to the trigger; selecting a
 * route closes the drawer. Desktop keeps the fixed sidebar (lg and up).
 */
export function MobileNav({ featureFlags }: { featureFlags?: Record<string, { enabled: boolean }> }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const location = useLocation();

  // Route changes (e.g. browser back/forward) close the drawer so the main
  // content is never left behind a stale overlay.
  React.useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <header className="lg:hidden fixed top-0 left-0 right-0 z-30 h-14 flex items-center gap-2 px-3 bg-surface border-b border-line">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            data-testid="mobile-nav-trigger"
            aria-label={t("components.sidebar.openMenu")}
            className="inline-flex items-center justify-center h-11 w-11 rounded-[var(--radius-sm)] text-ink-3 hover:text-ink hover:bg-paper-2 transition-colors"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
        </SheetTrigger>
        <SheetContent
          side="left"
          className="w-[280px] max-w-[85vw] p-0 border-r border-line bg-surface flex flex-col"
          data-testid="mobile-nav-drawer"
        >
          <SheetTitle className="sr-only">{t("components.sidebar.navigation")}</SheetTitle>
          <SheetDescription className="sr-only">{t("components.sidebar.navigationDescription")}</SheetDescription>
          <div className="px-5 pt-5 pb-4 border-b border-line">
            <div className="flex items-center gap-2.5">
              <ThresholdMark className="w-6 h-6 text-gov" />
              <div>
                <div className="font-mono text-[14px] tracking-[0.16em] font-bold text-ink">PD</div>
                <div className="font-mono text-[10px] tracking-[0.14em] text-ink-3">GOVERNANCE WORKSPACE</div>
              </div>
            </div>
          </div>
          <SidebarContent featureFlags={featureFlags} onNavigate={() => setOpen(false)} touchTargets />
        </SheetContent>
      </Sheet>
      <div className="flex items-center gap-2 min-w-0">
        <ThresholdMark className="w-5 h-5 text-gov flex-shrink-0" />
        <span className="font-mono text-[12px] tracking-[0.12em] font-bold text-ink truncate">PD</span>
      </div>
    </header>
  );
}
