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
import { NotificationProvider } from "./components/notifications/NotificationProvider.js";
import { Toaster } from "./components/ui/sonner.js";

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
import { IntentPage } from "./pages/intent/IntentPage.js";
import { DesignSystemPage } from "./pages/design-system/DesignSystemPage.js";

// Vite replaces import.meta.env.DEV with a boolean literal at build time.
// The cast avoids TS2339 without needing a generated .d.ts file.
const IS_DEV = (import.meta as unknown as { env: { DEV: boolean } }).env.DEV;

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
    if (authed !== true) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      console.log('handleKeyDown event:', e.key, 'altKey:', e.altKey);
      if (!e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
         target.tagName === "TEXTAREA" ||
         target.tagName === "SELECT" ||
         target.isContentEditable)
      ) {
        console.log('handleKeyDown ignored: input focused');
        return;
      }

      let targetPath: string | null = null;
      switch (e.key) {
        case "3":
          targetPath = "/focus";
          break;
        case "4":
          targetPath = "/pain";
          break;
        case "5":
          targetPath = "/principles";
          break;
        case "6":
          targetPath = "/activation";
          break;
        case "7":
          targetPath = "/debt";
          break;
        case "8":
          targetPath = "/control-center";
          break;
        case "9":
          targetPath = "/report-problem";
          break;
        case "0":
          targetPath = "/settings";
          break;
        default:
          console.log('handleKeyDown: key mismatch:', e.key);
          return;
      }

      if (targetPath) {
        console.log('handleKeyDown navigating to:', targetPath);
        e.preventDefault();
        navigate(targetPath);
      }
    };

    console.log('Registering handleKeyDown listener');
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      console.log('Removing handleKeyDown listener');
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [authed, navigate]);

  useEffect(() => {
    if (!showSplash) return;
    if (authed === null) return; // still checking
    // Wait for splash animation to complete before navigating
    // SplashScreen has its own 2200ms timer; we wait for it to call onComplete
    // This effect only handles the case where auth resolves after splash is done
  }, [authed, showSplash, navigate]);

  useEffect(() => {
    if (authed === true) {
      const currentPath = window.location.hash;
      if (currentPath === "#/login" || currentPath === "#/splash" || currentPath === "#/") {
        navigate("/focus", { replace: true });
      }
    }
  }, [authed, navigate]);

  const handleAuthSuccess = useCallback(() => {
    setAuthed(true);
    navigate("/focus", { replace: true });
  }, [navigate]);

  return (
    <Routes>
      <Route path="/splash" element={<SplashScreen onComplete={() => {
        setShowSplash(false);
        if (authed) {
          navigate("/focus", { replace: true });
        } else {
          navigate("/login", { replace: true });
        }
      }} />} />
      <Route path="/login" element={<LoginForm onAuthSuccess={handleAuthSuccess} />} />
      <Route
        path="/*"
        element={
          authed === null ? (
            <div className="min-h-screen bg-paper flex items-center justify-center">
              <div className="flex flex-col items-center gap-4">
                <div className="w-8 h-8 border-2 border-gov border-t-transparent rounded-full animate-spin"></div>
                <span className="text-[12px] font-mono tracking-wider text-ink-3 uppercase">Verifying Session...</span>
              </div>
            </div>
          ) : authed ? (
            <NotificationProvider>
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
                    <Route path="/update" element={<UpdatePage />} />
                    <Route path="/report-problem" element={<ReportProblemPage />} />
                    <Route path="/intent" element={<IntentPage />} />
                    {IS_DEV && (
                      <Route path="/design-system" element={<DesignSystemPage />} />
                    )}
                    {!IS_DEV && (
                      <Route path="/design-system" element={<Navigate to="/focus" replace />} />
                    )}
                  </Routes>
                </ErrorBoundary>
              </main>
            </div>
            </NotificationProvider>
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
        <Toaster />
      </I18nextProvider>
    </ThemeProvider>
  );
}
