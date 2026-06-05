import { useState, useEffect, useCallback } from "react";
import { HashRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n/index.js";
import { ThemeProvider } from "./components/theme-provider.js";
import { AppSidebar } from "./components/layout/app-sidebar.js";
import { SplashScreen } from "./components/auth/splash-screen.js";
import { LoginForm } from "./components/auth/login-form.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import { checkAuth, getToken } from "./api.js";

// New page imports (CR2 directory structure)
import { FocusPage } from "./pages/focus/FocusPage.js";
import { PainPage } from "./pages/pain/PainPage.js";
import { PrinciplesPage } from "./pages/principles/PrinciplesPage.js";
import { PrincipleDetailPage } from "./pages/principles/PrincipleDetailPage.js";
import { ActivationPage } from "./pages/activation/ActivationPage.js";
import { DebtPage } from "./pages/debt/DebtPage.js";
import { ControlCenterPage } from "./pages/control-center/ControlCenterPage.js";
import { SettingsPage } from "./pages/settings/SettingsPage.js";
import { UpdatePage } from "./pages/settings/UpdatePage.js";
import { ReportProblemPage } from "./pages/report-problem/ReportProblemPage.js";
import { DesignSystemPage } from "./pages/design-system/DesignSystemPage.js";

function AuthRoutes() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [showSplash, setShowSplash] = useState(true);
  const navigate = useNavigate();

  const verifyAuth = useCallback(async () => {
    const valid = await checkAuth();
    setAuthed(valid);
  }, []);

  useEffect(() => {
    verifyAuth();
  }, [verifyAuth]);

  useEffect(() => {
    if (!showSplash) return;
    if (authed === null) return; // still checking
    // After splash, navigate based on auth
    const timer = setTimeout(() => {
      setShowSplash(false);
      if (authed) {
        navigate("/focus", { replace: true });
      } else {
        navigate("/login", { replace: true });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [authed, showSplash, navigate]);

  const handleAuthSuccess = useCallback(() => {
    setAuthed(true);
    navigate("/focus", { replace: true });
  }, [navigate]);

  return (
    <Routes>
      <Route path="/splash" element={<SplashScreen onComplete={() => setShowSplash(false)} />} />
      <Route path="/login" element={<LoginForm onAuthSuccess={handleAuthSuccess} />} />
      <Route
        path="/*"
        element={
          authed ? (
            <div className="min-h-screen bg-paper text-ink">
              <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-paper focus:text-ink">
                Skip to main content
              </a>
              <AppSidebar />
              <main id="main-content" className="ml-[256px] min-h-screen overflow-y-auto">
                <ErrorBoundary>
                  <Routes>
                    <Route path="/" element={<Navigate to="/focus" replace />} />
                    <Route path="/focus" element={<FocusPage />} />
                    <Route path="/pain" element={<PainPage />} />
                    <Route path="/principles" element={<PrinciplesPage />} />
                    <Route path="/principles/:id" element={<PrincipleDetailPage />} />
                    <Route path="/activation" element={<ActivationPage />} />
                    <Route path="/debt" element={<DebtPage />} />
                    <Route path="/control-center" element={<ControlCenterPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/settings/update" element={<UpdatePage />} />
                    <Route path="/report-problem" element={<ReportProblemPage />} />
                    <Route path="/design-system" element={<DesignSystemPage />} />
                  </Routes>
                </ErrorBoundary>
              </main>
            </div>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <HashRouter>
          <AuthRoutes />
        </HashRouter>
      </I18nextProvider>
    </ThemeProvider>
  );
}
