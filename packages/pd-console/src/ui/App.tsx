import { useState, useEffect, useCallback } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import { I18nextProvider, useTranslation } from "react-i18next";
import i18n from "./i18n/index.js";
import { ThemeProvider } from "./components/theme-provider.js";
import { ThemeToggle } from "./components/theme-toggle.js";
import { LanguageSwitcher } from "./components/language-switcher.js";
import { AppSidebar } from "./components/app-sidebar.js";
import { Button } from "./components/ui/button.js";
import { TasksPage } from "./pages/TasksPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { FeedbackPage } from "./pages/FeedbackPage.js";
import { PainPage } from "./pages/PainPage.js";
import { ApprovalsPage } from "./pages/ApprovalsPage.js";
import { GatesPage } from "./pages/GatesPage.js";
import { SamplesPage } from "./pages/SamplesPage.js";
import { EvolutionPage } from "./pages/EvolutionPage.js";
import { ThinkingModelsPage } from "./pages/ThinkingModelsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { CentralPage } from "./pages/CentralPage.js";
import { DataFlowPage } from "./pages/DataFlowPage.js";
import { EventLogPage } from "./pages/EventLogPage.js";
import { PrinciplesPage } from "./pages/PrinciplesPage.js";
import { PrincipleDetailPage } from "./pages/PrincipleDetailPage.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import { getToken, clearToken, checkAuth } from "./api.js";

export function App() {
  const { t } = useTranslation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const verifyAuth = useCallback(async () => {
    const valid = await checkAuth();
    setAuthed(valid);
  }, []);

  useEffect(() => {
    verifyAuth();
  }, [verifyAuth]);

  if (authed === null) {
    return (
      <ThemeProvider>
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-muted-foreground animate-pulse">
            Checking authentication…
          </div>
        </div>
      </ThemeProvider>
    );
  }

  if (!authed) {
    return (
      <ThemeProvider>
        <I18nextProvider i18n={i18n}>
          <LoginPage onAuthSuccess={() => setAuthed(true)} />
        </I18nextProvider>
      </ThemeProvider>
    );
  }

  const handleSignOut = () => {
    clearToken();
    setAuthed(false);
  };

  return (
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <HashRouter>
          <div className="min-h-screen bg-background text-foreground">
            <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground">
              Skip to main content
            </a>
            <AppSidebar
              collapsed={sidebarCollapsed}
              onCollapsedChange={setSidebarCollapsed}
            />
            <div
              className={`transition-[margin] duration-300 motion-reduce:transition-none flex flex-col min-h-screen ${sidebarCollapsed ? "ml-16" : "ml-56"}`}
            >
              <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                <div className="flex items-center justify-between px-6 py-3">
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-medium text-muted-foreground">
                      PD Console v0.2
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <LanguageSwitcher />
                    <ThemeToggle />
                    {getToken() && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleSignOut}
                      >
                        {t("common:logout")}
                      </Button>
                    )}
                  </div>
                </div>
              </header>
              <main id="main-content" className="flex-1 p-6 overflow-y-auto">
                <ErrorBoundary>
                  <Routes>
                    <Route path="/" element={<PainPage />} />
                    <Route path="/pain" element={<PainPage />} />
                    <Route path="/approvals" element={<ApprovalsPage />} />
                    <Route path="/overview" element={<OverviewPage />} />
                    <Route path="/central" element={<CentralPage />} />
                    <Route path="/tasks" element={<TasksPage />} />
                    <Route path="/feedback" element={<FeedbackPage />} />
                    <Route path="/gates" element={<GatesPage />} />
                    <Route path="/samples" element={<SamplesPage />} />
                    <Route path="/evolution" element={<EvolutionPage />} />
                    <Route path="/principles" element={<PrinciplesPage />} />
                    <Route path="/principles/:id" element={<PrincipleDetailPage />} />
                    <Route path="/agents" element={<AgentsPage />} />
                    <Route path="/data-flow" element={<DataFlowPage />} />
                    <Route path="/event-log" element={<EventLogPage />} />
                    <Route path="/thinking-models" element={<ThinkingModelsPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                  </Routes>
                </ErrorBoundary>
              </main>
            </div>
          </div>
        </HashRouter>
      </I18nextProvider>
    </ThemeProvider>
  );
}
