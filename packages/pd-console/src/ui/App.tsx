import { useState, useEffect, useCallback } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n/index.js";
import { ThemeProvider } from "./components/theme-provider.js";
import { AppSidebar } from "./components/layout/app-sidebar.js";
import { SplashScreen } from "./components/auth/splash-screen.js";
import { LoginForm } from "./components/auth/login-form.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import { checkAuth, getToken, fetchConfigSummary, fetchWorkspaces } from "./api.js";
import type { ConfigSummaryData } from "./api.js";
import { NotificationProvider } from "./components/notifications/NotificationProvider.js";
import { Toaster } from "./components/ui/sonner.js";

// New page imports (CR2 directory structure)
import { FocusPage } from "./pages/focus/FocusPage.js";
import { PainPage } from "./pages/pain/PainPage.js";
import { PrinciplesPage } from "./pages/principles/PrinciplesPage.js";
import { CorePrinciplesPage } from "./pages/principles/CorePrinciplesPage.js";
import { PrincipleDetailPage } from "./pages/principles/PrincipleDetailPage.js";
import { ActivationPage } from "./pages/activation/ActivationPage.js";
import { DebtPage } from "./pages/debt/DebtPage.js";
import { ControlCenterPage } from "./pages/control-center/ControlCenterPage.js";
import { SignalKeywordsPage } from "./pages/signal-keywords/SignalKeywordsPage.js";
import { SettingsPage } from "./pages/settings/SettingsPage.js";
import { UpdatePage } from "./pages/settings/UpdatePage.js";
import { ReportProblemPage } from "./pages/report-problem/ReportProblemPage.js";
import { FailedTasksPage } from "./pages/failed-tasks/FailedTasksPage.js";
import { IntentPage } from "./pages/intent/IntentPage.js";
import { DesignSystemPage } from "./pages/design-system/DesignSystemPage.js";
import { WelcomePage } from "./pages/welcome/WelcomePage.js";
import { getOnboardingState } from "./utils/onboarding-state.js";

// Vite replaces import.meta.env.DEV with a boolean literal at build time.
// The cast avoids TS2339 without needing a generated .d.ts file.
const IS_DEV = (import.meta as unknown as { env: { DEV: boolean } }).env.DEV;

function AuthRoutes() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [showSplash, setShowSplash] = useState(() => window.location.hash.startsWith("#/splash"));
  // Onboarding redirect needs workspaceId (for onboarding-state lookup) and
  // feature flags (to gate the redirect). Both are fetched after auth.
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string>("default");
  const [featureFlags, setFeatureFlags] = useState<Record<string, { enabled: boolean }> | null>(null);
  // P2-C: tracks whether workspace fetch succeeded. If it failed, we skip
  // the onboarding redirect so state isn't saved under a fake "default" key.
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

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
    // Wait for splash animation to complete before navigating
    // SplashScreen has its own 2200ms timer; we wait for it to call onComplete
    // This effect only handles the case where auth resolves after splash is done
  }, [authed, showSplash, navigate]);

  // Fetch workspace list + feature flags after auth for onboarding redirect.
  // P2-5: use Promise.all so both states update together — prevents the
  // redirect effect from firing with the wrong workspaceId (race condition).
  // rc-9: on fetch failure, set featureFlags to {} so the redirect effect
  // fires (defaults to /focus — safe, no onboarding forced).
  useEffect(() => {
    if (authed !== true) return;

    Promise.all([
      fetchWorkspaces().catch(() => null),
      fetchConfigSummary().catch(() => null),
    ]).then(([wsResult, cfgResult]) => {
      // Update workspaceId first (if we have a real workspace)
      if (
        wsResult &&
        wsResult.success &&
        Array.isArray(wsResult.data) &&
        wsResult.data.length > 0
      ) {
        const firstWorkspace = wsResult.data[0];
        if (firstWorkspace) {
          setCurrentWorkspaceId(firstWorkspace.name);
          // P2-C: only mark workspaceReady when we have a real workspace name.
          setWorkspaceReady(true);
        }
      }
      // Then update featureFlags — the redirect effect waits for this.
      // rc-9: on any failure, default to {} so redirect fires to /focus.
      const flags: Record<string, { enabled: boolean }> = {};
      if (
        cfgResult &&
        cfgResult.success &&
        cfgResult.data
      ) {
        const summary: ConfigSummaryData = cfgResult.data;
        for (const f of summary.features) {
          flags[f.id] = { enabled: f.enabled };
        }
      }
      setFeatureFlags(flags);
    });
  }, [authed]);

  // P1-4: After splash finishes, if user is not authenticated, go to login.
  // (The authed === true case is handled by the redirect effect below.)
  useEffect(() => {
    if (showSplash || authed !== false) return;
    navigate('/login', { replace: true });
  }, [showSplash, authed, navigate]);

  // First-visit redirect: check new_user_onboarding flag + onboarding state.
  // P1-4: Only redirect AFTER splash is done AND featureFlags are loaded.
  // This prevents the race where splash navigates to /focus before flags
  // load, which would bypass the onboarding redirect entirely.
  useEffect(() => {
    if (authed !== true || featureFlags === null || showSplash) return;
    if (!['/', '/login', '/splash'].includes(location.pathname)) return;

    const flagEnabled = featureFlags?.new_user_onboarding?.enabled === true;
    // P2-C: if workspace fetch failed, don't force onboarding under "default" key.
    if (flagEnabled && workspaceReady) {
      const onboardingState = getOnboardingState(currentWorkspaceId);
      navigate(onboardingState.completed ? '/focus' : '/welcome', { replace: true });
    } else {
      navigate('/focus', { replace: true });
    }
  }, [authed, featureFlags, showSplash, currentWorkspaceId, workspaceReady, location.pathname, navigate]);

  const handleAuthSuccess = useCallback(() => {
    setAuthed(true);
    // Post-auth redirect is handled by the authed + featureFlags effect above,
    // which fires once feature flags have loaded.
  }, []);

  return (
    <Routes>
      <Route path="/splash" element={<SplashScreen onComplete={() => {
        setShowSplash(false);
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
              <AppSidebar featureFlags={featureFlags ?? undefined} />
              <main id="main-content" className="ml-[256px] min-h-screen overflow-y-auto">
                <ErrorBoundary>
                  <Routes>
                    <Route path="/" element={<Navigate to="/focus" replace />} />
                    <Route path="/welcome" element={<WelcomePage workspaceId={currentWorkspaceId} />} />
                    <Route path="/focus" element={<FocusPage featureFlags={featureFlags ?? undefined} />} />
                    <Route path="/pain" element={<PainPage />} />
                    <Route path="/principles" element={<PrinciplesPage />} />
                    {/* PRI-641: static segment must be declared before /principles/:id */}
                    <Route path="/principles/core" element={<CorePrinciplesPage />} />
                    <Route path="/principles/:id" element={<PrincipleDetailPage />} />
                    <Route path="/activation" element={<ActivationPage />} />
                    <Route path="/debt" element={<DebtPage />} />
                    <Route path="/control-center" element={<ControlCenterPage />} />
                    <Route path="/control-center/signal-keywords" element={<SignalKeywordsPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/update" element={<UpdatePage />} />
                    <Route path="/report-problem" element={<ReportProblemPage />} />
                    <Route path="/failed-tasks" element={<FailedTasksPage />} />
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
