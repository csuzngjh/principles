import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Flame,
  ScrollText,
  ShieldCheck,
  Settings,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Activity,
  FileText,
  Dna,
  Wrench,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Button } from "./ui/button.js";
import { Badge } from "./ui/badge.js";
import { fetchSystemHealth } from "../api.js";
import type { SystemHealthStatus } from "../api.js";

const mvpNavItems = [
  { id: "pain", label: "Pain", icon: Flame, href: "/pain" },
  { id: "principles", label: "Principle", icon: ScrollText, href: "/principles" },
  { id: "approvals", label: "Approval", icon: ShieldCheck, href: "/approvals" },
];

const diagnosticNavItems = [
  { id: "overview", label: "Overview", icon: Activity, href: "/" },
  { id: "data-flow", label: "Data Flow", icon: Activity, href: "/data-flow" },
  { id: "event-log", label: "Event Log", icon: FileText, href: "/event-log" },
  { id: "evolution", label: "Evolution", icon: Dna, href: "/evolution" },
];

interface AppSidebarProps {
  className?: string;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function AppSidebar({ className, collapsed = false, onCollapsedChange }: AppSidebarProps) {
  const location = useLocation();
  const [healthData, setHealthData] = useState<SystemHealthStatus | null>(null);
  const [alertCount, setAlertCount] = useState(0);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const isActive = (href: string) => {
    if (href === "/" && location.pathname === "/") return true;
    return location.pathname.startsWith(href);
  };

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        setHealthError(null);
        const result = await fetchSystemHealth();
        if (result.success && result.data) {
          setHealthData(result.data);
          const errorChecks = result.data.checks.filter(c => c.status === "error").length;
          const warningChecks = result.data.checks.filter(c => c.status === "warning").length;
          setAlertCount(errorChecks + warningChecks);
        } else if (!result.success) {
          setHealthError(result.error ?? "Failed to load health status");
        }
      } catch (err) {
        setHealthError(err instanceof Error ? err.message : "Network error");
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  const getAlertBadgeVariant = () => {
    if (!healthData) return "secondary";
    if (healthData.overall === "error") return "destructive";
    if (healthData.overall === "degraded") return "secondary";
    return "default";
  };

  const isDiagnosticsActive = diagnosticNavItems.some(d => isActive(d.href));

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 h-screen bg-sidebar border-r border-border flex flex-col transition-all duration-300 ease-in-out z-50",
        collapsed ? "w-16" : "w-56",
        className
      )}
    >
      <div className="p-4 border-b border-border">
        <div
          className={cn(
            "flex items-center gap-3 font-bold text-lg text-primary",
            collapsed && "justify-center"
          )}
        >
          <div className="relative">
            <Dna className="h-6 w-6" aria-hidden="true" />
            {alertCount > 0 && (
              <Badge
                variant={getAlertBadgeVariant()}
                className="absolute -top-2 -right-2 h-5 min-w-5 flex items-center justify-center p-0 text-[10px]"
              >
                {alertCount}
              </Badge>
            )}
          </div>
          {!collapsed && (
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span>PD Console</span>
                {alertCount > 0 && (
                  <div className="flex items-center gap-1 text-xs text-destructive">
                    <AlertTriangle className="h-3 w-3" />
                    <span>{alertCount}</span>
                  </div>
                )}
                {healthError && (
                  <div className="flex items-center gap-1 text-xs text-destructive" title={healthError}>
                    <AlertTriangle className="h-3 w-3" />
                    <span>!</span>
                  </div>
                )}
              </div>
              <span className="text-[10px] text-muted-foreground mt-0.5 tracking-wider">Burn pain, drive evolution</span>
            </div>
          )}
        </div>
      </div>

      <nav className="flex-1 py-4 overflow-y-auto">
        <div className="mb-2">
          {!collapsed && (
            <div className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              MVP Journey
            </div>
          )}
          {mvpNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                to={item.href}
                data-testid={`nav-${item.id}`}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 text-sm transition-all duration-200",
                  "hover:bg-accent hover:text-accent-foreground",
                  isActive(item.href)
                    ? "bg-primary/10 text-primary border-r-2 border-primary"
                    : "text-muted-foreground",
                  collapsed && "justify-center"
                )}
              >
                <Icon className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );
          })}
        </div>

        <div className="border-t border-border pt-2 mt-2">
          <button
            type="button"
            data-testid="diagnostics-toggle"
            onClick={() => setDiagnosticsOpen(!diagnosticsOpen)}
            className={cn(
              "flex items-center gap-3 px-4 py-2 text-xs w-full text-left transition-all duration-200",
              "hover:bg-accent hover:text-accent-foreground",
              isDiagnosticsActive ? "text-primary" : "text-muted-foreground",
              collapsed && "justify-center"
            )}
          >
            <Wrench className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            {!collapsed && (
              <>
                <span className="flex-1 uppercase tracking-wider font-semibold">Diagnostics</span>
                {diagnosticsOpen ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </>
            )}
          </button>
          {(diagnosticsOpen || collapsed) && diagnosticNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                to={item.href}
                data-testid={`nav-${item.id}`}
                className={cn(
                  "flex items-center gap-3 px-4 py-2 text-xs transition-all duration-200",
                  "hover:bg-accent hover:text-accent-foreground",
                  isActive(item.href)
                    ? "bg-primary/10 text-primary border-r-2 border-primary"
                    : "text-muted-foreground",
                  collapsed && "justify-center"
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );
          })}
        </div>

        <div className="border-t border-border pt-2 mt-2">
          <Link
            to="/settings"
            data-testid="nav-settings"
            className={cn(
              "flex items-center gap-3 px-4 py-2 text-xs transition-all duration-200",
              "hover:bg-accent hover:text-accent-foreground",
              isActive("/settings")
                ? "bg-primary/10 text-primary border-r-2 border-primary"
                : "text-muted-foreground",
              collapsed && "justify-center"
            )}
          >
            <Settings className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            {!collapsed && <span>Settings</span>}
          </Link>
        </div>
      </nav>

      <div className="p-2 border-t border-border">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onCollapsedChange?.(!collapsed)}
          className="w-full justify-center"
        >
          {collapsed ? (
            <ChevronRight className="h-5 w-5" />
          ) : (
            <ChevronLeft className="h-5 w-5" />
          )}
        </Button>
      </div>
    </aside>
  );
}
