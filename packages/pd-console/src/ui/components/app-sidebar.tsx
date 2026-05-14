import * as React from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Building2,
  ListTodo,
  MessageSquare,
  Shield,
  FlaskConical,
  Dna,
  Brain,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Button } from "./ui/button.js";

const navItems = [
  { id: "overview", label: "概览", icon: LayoutDashboard, href: "/" },
  { id: "central", label: "中央", icon: Building2, href: "/central" },
  { id: "tasks", label: "任务", icon: ListTodo, href: "/tasks" },
  { id: "feedback", label: "反馈", icon: MessageSquare, href: "/feedback" },
  { id: "gates", label: "门控", icon: Shield, href: "/gates" },
  { id: "samples", label: "样本", icon: FlaskConical, href: "/samples" },
  { id: "evolution", label: "进化", icon: Dna, href: "/evolution" },
  { id: "thinking-models", label: "思维模型", icon: Brain, href: "/thinking-models" },
  { id: "settings", label: "设置", icon: Settings, href: "/settings" },
];

interface AppSidebarProps {
  className?: string;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function AppSidebar({ className, collapsed = false, onCollapsedChange }: AppSidebarProps) {
  const location = useLocation();

  const isActive = (href: string) => {
    if (href === "/" && location.pathname === "/") return true;
    return location.pathname.startsWith(href);
  };

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
          <Dna className="h-6 w-6" />
          {!collapsed && <span>PD Console</span>}
        </div>
      </div>

      <nav className="flex-1 py-4 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.id}
              to={item.href}
              className={cn(
                "flex items-center gap-3 px-4 py-3 text-sm transition-all duration-200",
                "hover:bg-accent hover:text-accent-foreground",
                isActive(item.href)
                  ? "bg-primary/10 text-primary border-r-2 border-primary"
                  : "text-muted-foreground",
                collapsed && "justify-center"
              )}
            >
              <Icon className={cn("h-5 w-5 flex-shrink-0", collapsed && "h-5 w-5")} />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
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
