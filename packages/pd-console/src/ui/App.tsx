import { useState, useEffect, useCallback } from "react";
import { TasksPage } from "./pages/TasksPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { FeedbackPage } from "./pages/FeedbackPage.js";
import { GatesPage } from "./pages/GatesPage.js";
import { SamplesPage } from "./pages/SamplesPage.js";
import { EvolutionPage } from "./pages/EvolutionPage.js";
import { ThinkingModelsPage } from "./pages/ThinkingModelsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { CentralPage } from "./pages/CentralPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { getToken, clearToken, checkAuth } from "./api.js";

type Route = "overview" | "tasks" | "feedback" | "gates" | "samples" | "evolution" | "thinking-models" | "settings" | "central";

function routeFromHash(hash: string): Route {
  if (hash === "#/tasks") return "tasks";
  if (hash === "#/feedback") return "feedback";
  if (hash === "#/gates") return "gates";
  if (hash === "#/samples") return "samples";
  if (hash === "#/evolution") return "evolution";
  if (hash === "#/thinking-models") return "thinking-models";
  if (hash === "#/settings") return "settings";
  if (hash === "#/central") return "central";
  return "overview";
}

const NAV_ITEMS: { route: Route; href: string; label: string }[] = [
  { route: "overview", href: "#/", label: "Overview" },
  { route: "central", href: "#/central", label: "Central" },
  { route: "tasks", href: "#/tasks", label: "Tasks" },
  { route: "feedback", href: "#/feedback", label: "Feedback" },
  { route: "gates", href: "#/gates", label: "Gates" },
  { route: "samples", href: "#/samples", label: "Samples" },
  { route: "evolution", href: "#/evolution", label: "Evolution" },
  { route: "thinking-models", href: "#/thinking-models", label: "Thinking" },
  { route: "settings", href: "#/settings", label: "Settings" },
];

const LAYOUT_STYLE: React.CSSProperties = {
  display: "flex",
  minHeight: "100vh",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

const SIDEBAR_STYLE: React.CSSProperties = {
  width: "200px",
  borderRight: "1px solid #e0e0e0",
  backgroundColor: "#fafafa",
  padding: "16px 0",
  flexShrink: 0,
};

const SIDEBAR_LINK_STYLE: React.CSSProperties = {
  display: "block",
  padding: "10px 20px",
  textDecoration: "none",
  color: "#555",
  fontSize: "14px",
  transition: "background-color 0.15s",
};

const SIDEBAR_ACTIVE_STYLE: React.CSSProperties = {
  ...SIDEBAR_LINK_STYLE,
  backgroundColor: "#e6f4ff",
  color: "#1677ff",
  fontWeight: "bold",
  borderRight: "3px solid #1677ff",
};

const MAIN_STYLE: React.CSSProperties = {
  flex: 1,
  padding: "24px",
  overflowY: "auto",
};

const HEADER_STYLE: React.CSSProperties = {
  padding: "12px 20px",
  borderBottom: "1px solid #e0e0e0",
  fontSize: "12px",
  color: "#888",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const PAGE_MAP: Record<Route, () => React.JSX.Element> = {
  overview: OverviewPage,
  central: CentralPage,
  tasks: TasksPage,
  feedback: FeedbackPage,
  gates: GatesPage,
  samples: SamplesPage,
  evolution: EvolutionPage,
  "thinking-models": ThinkingModelsPage,
  settings: SettingsPage,
};

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash(window.location.hash));
  const [authed, setAuthed] = useState<boolean | null>(null);

  const verifyAuth = useCallback(async () => {
    const valid = await checkAuth();
    setAuthed(valid);
  }, []);

  useEffect(() => {
    verifyAuth();
  }, [verifyAuth]);

  useEffect(() => {
    function handleHashChange() {
      setRoute(routeFromHash(window.location.hash));
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  if (authed === null) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#999" }}>
        Checking authentication...
      </div>
    );
  }

  if (!authed) {
    return <LoginPage onAuthSuccess={() => setAuthed(true)} />;
  }

  const PageComponent = PAGE_MAP[route];

  return (
    <div style={LAYOUT_STYLE}>
      <aside style={SIDEBAR_STYLE}>
        <div style={{ padding: "0 20px 16px", fontSize: "16px", fontWeight: "bold", color: "#333" }}>PD Console</div>
        {NAV_ITEMS.map((item) => (
          <a
            key={item.route}
            href={item.href}
            style={item.route === route ? SIDEBAR_ACTIVE_STYLE : SIDEBAR_LINK_STYLE}
          >
            {item.label}
          </a>
        ))}
      </aside>
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <header style={HEADER_STYLE}>
          <span>PD Console v0.2</span>
          {getToken() && (
            <button
              onClick={() => {
                clearToken();
                setAuthed(false);
              }}
              style={{
                border: "1px solid #d9d9d9",
                borderRadius: "4px",
                padding: "2px 10px",
                fontSize: "12px",
                cursor: "pointer",
                backgroundColor: "#fff",
                color: "#888",
              }}
            >
              Sign Out
            </button>
          )}
        </header>
        <main style={MAIN_STYLE}>
          <ErrorBoundary>
            <PageComponent />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
