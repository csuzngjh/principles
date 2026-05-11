import { useState, useEffect } from "react";
import { TasksPage } from "./pages/TasksPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

type Route = "tasks" | "status" | "settings";

function routeFromHash(hash: string): Route {
  if (hash === "#/status") return "status";
  if (hash === "#/settings") return "settings";
  return "tasks";
}

const NAV_ITEMS: { route: Route; href: string; label: string }[] = [
  { route: "tasks", href: "#/", label: "待办事项" },
  { route: "status", href: "#/status", label: "系统状态" },
  { route: "settings", href: "#/settings", label: "设置" },
];

const NAV_STYLE: React.CSSProperties = {
  display: "flex",
  gap: "16px",
  padding: "12px 24px",
  borderBottom: "1px solid #e0e0e0",
  backgroundColor: "#fafafa",
};

const LINK_STYLE: React.CSSProperties = {
  textDecoration: "none",
  color: "#333",
  padding: "4px 8px",
};

const ACTIVE_LINK_STYLE: React.CSSProperties = {
  ...LINK_STYLE,
  fontWeight: "bold",
  color: "#1677ff",
  borderBottom: "2px solid #1677ff",
};

const CONTENT_STYLE: React.CSSProperties = {
  padding: "24px",
};

function StatusPage() {
  return (
    <div>
      <h1>系统状态</h1>
      <p>系统状态信息将在此显示</p>
    </div>
  );
}

function SettingsPagePlaceholder() {
  return (
    <div>
      <h1>设置</h1>
      <p>设置选项将在此显示</p>
    </div>
  );
}

const PAGE_MAP: Record<Route, () => React.JSX.Element> = {
  tasks: TasksPage,
  status: StatusPage,
  settings: SettingsPage,
};

export function App() {
  const [route, setRoute] = useState<Route>(
    routeFromHash(window.location.hash),
  );

  useEffect(() => {
    function handleHashChange() {
      setRoute(routeFromHash(window.location.hash));
    }

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const PageComponent = PAGE_MAP[route];

  return (
    <div>
      <nav style={NAV_STYLE}>
        {NAV_ITEMS.map((item) => (
          <a
            key={item.route}
            href={item.href}
            style={item.route === route ? ACTIVE_LINK_STYLE : LINK_STYLE}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <main style={CONTENT_STYLE}>
        <PageComponent />
      </main>
    </div>
  );
}
