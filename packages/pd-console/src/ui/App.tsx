import { useState, useEffect, useCallback } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { I18nextProvider, useTranslation } from "react-i18next";
import i18n from "./i18n/index.js";
import { ThemeProvider } from "./components/theme-provider.js";
import { AppSidebar, MobileNav } from "./components/layout/app-sidebar.js";
import { SplashScreen } from "./components/auth/splash-screen.js";
import { LoginForm } from "./components/auth/login-form.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import { checkAuth, getToken, fetchConfigSummary, fetchWorkspaces } from "./api.js";
import type { ConfigSummaryData } from "./api.js";
import { Toaster } from "./components/ui/sonner.js";

// New page imports (CR2 directory structure)
import { FocusPage } from "./pages/focus/FocusPage.js";
import { TodayPage } from "./pages/today/TodayPage.js";
import { ReviewPage } from "./pages/review/ReviewPage.js";
import { PainPage } from "./pages/pain/PainPage.js";
import { PrinciplesPage } from "./pages/principles/PrinciplesPage.js";
import { CorePrinciplesPage } from "./pages/principles/CorePrinciplesPage.js";
import { PrincipleDetailPage } from "./pages/principles/PrincipleDetailPage.js";
import { ActivationPage } from "./pages/activation/ActivationPage.js";
import { DebtPage } from "./pages/debt/DebtPage.js";
import { ExaminerPage } from "./pages/examiner/ExaminerPage.js";
import { ExaminerConfigurePage } from "./pages/examiner/ExaminerConfigurePage.js";
import { ExaminerStudyPage } from "./pages/examiner/ExaminerStudyPage.js";
import { ExaminerReportPage } from "./pages/examiner/ExaminerReportPage.js";
import { ControlCenterPage } from "./pages/control-center/ControlCenterPage.js";
import { SettingsPage } from "./pages/settings/SettingsPage.js";
import { UpdatePage } from "./pages/settings/UpdatePage.js";
import { ReportProblemPage } from "./pages/report-problem/ReportProblemPage.js";
import { FailedTasksPage } from "./pages/failed-tasks/FailedTasksPage.js";
import { IntentPage } from "./pages/intent/IntentPage.js";
import { IngestionStatusPage } from "./pages/ingestion-status/IngestionStatusPage.js";
import { NotFoundPage } from "./pages/not-found/NotFoundPage.js";
import { DesignSystemPage } from "./pages/design-system/DesignSystemPage.js";
import { WelcomePage } from "./pages/welcome/WelcomePage.js";
import { getOnboardingState } from "./utils/onboarding-state.js";

// Vite replaces import.meta.env.DEV with a boolean literal at build time, so a
// production bundle resolves this to false and dead-code elimination drops the
// DEV-only routes from the shipped UI. `utils/runtime-mode.ts` exports the same
// value for components rendered outside this module; both read the same define.
const IS_DEV = (import.meta as unknown as { env: { DEV: boolean } }).env.DEV;

/**
 * SPEC-PD-UIUX-001 R4: the skip control must NOT touch the URL hash — the app
 * routes through HashRouter, so an `#main-content` anchor navigates away and
 * blanks the page. Focus main programmatically instead; the route is kept.
 */
function skipToMainContent() {
  const main = document.getElementById("main-content");
  if (main instanceof HTMLElement) {
    main.focus({ preventScroll: true });
    main.scrollIntoView({ block: "start", behavior: "auto" });
  }
}

function AuthenticatedShell({ children, featureFlags }: { children: React.ReactNode; featureFlags?: Record<string, { enabled: boolean }> }) {
  const { t } = useTranslation();
  const location = useLocation();
  // REVIEW_SESSION_SPEC §1.2: the review card is a focused surface — no
  // sidebar, no filters, no overview. It keeps the same <main> landmark and
  // focus contract as every other page, just without the chrome.
  const bare = location.pathname.startsWith("/review/");
  if (bare) {
    return (
      <div className="min-h-screen bg-paper text-ink">
        <main
          id="main-content"
          tabIndex={-1}
          data-testid="main-content"
          className="min-h-screen overflow-y-auto [scroll-padding-bottom:13rem] focus:outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gov"
        >
          {children}
        </main>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-paper text-ink">
      <button
        type="button"
        onClick={skipToMainContent}
        data-testid="skip-to-main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-paper focus:text-ink focus:font-medium"
      >
        {t("common.skipToMain", { defaultValue: "跳到正文" })}
      </button>
      <MobileNav featureFlags={featureFlags} />
      <AppSidebar featureFlags={featureFlags} />
      <main
        id="main-content"
        tabIndex={-1}
        data-testid="main-content"
        className="min-h-screen overflow-y-auto pt-14 lg:pt-0 lg:ml-[256px] [scroll-padding-bottom:13rem] focus:outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gov"
      >
        {children}
      </main>
    </div>
  );
}

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
    // `null` = the server did not answer at all. That is not evidence of a
    // missing token: enter the shell and let each page render its own
    // unreachable state (with retry) instead of a token form that cannot work.
    setAuthed(valid ?? true);
  }, []);

  useEffect(() => {
    verifyAuth();
  }, [verifyAuth]);

  // PRI-643: verifyAuth otherwise runs only on mount. If the server switches
  // auth mode (or the token expires) while the page stays open, re-verify
  // when the tab becomes visible or the window regains focus; a 401 from the
  // probe also triggers api.ts's global redirect to the login route.
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState === "visible") verifyAuth();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
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
            <AuthenticatedShell featureFlags={featureFlags ?? undefined}>
                <ErrorBoundary>
                  <Routes>
                    <Route path="/" element={<Navigate to="/focus" replace />} />
                    <Route path="/welcome" element={<WelcomePage workspaceId={currentWorkspaceId} />} />
                    {/* B2: /focus is the daily "今天" entry. The full
                        workbench keeps every existing capability at
                        /workbench (deep-link contracts preserved). */}
                    <Route path="/focus" element={<TodayPage featureFlags={featureFlags ?? undefined} />} />
                    <Route path="/review/:id" element={<ReviewPage featureFlags={featureFlags ?? undefined} />} />
                    <Route path="/workbench" element={<FocusPage featureFlags={featureFlags ?? undefined} />} />
                    <Route path="/pain" element={<PainPage />} />
                    <Route path="/principles" element={<PrinciplesPage />} />
                    {/* PRI-641: static segment must be declared before /principles/:id */}
                    <Route path="/principles/core" element={<CorePrinciplesPage />} />
                    <Route path="/principles/:id" element={<PrincipleDetailPage />} />
                    <Route path="/activation" element={<ActivationPage />} />
                    <Route path="/debt" element={<DebtPage />} />
                    {/* PRI-1171 ticket ⑦: three-host ingestion health —
                        read-only status (SPEC G6: never trajectory browsing). */}
                    <Route path="/ingestion-status" element={<IngestionStatusPage />} />
                    {/* The Examiner panel is a shipped surface: mounted in
                        every build. Real-host execution stays refused by the
                        server, not by hiding the page. v0.10.1: the single
                        v0.9 page became a four-page Owner journey
                        (evaluation → configure → study → report). */}
                    <Route path="/examiner" element={<ExaminerPage />} />
                    <Route path="/examiner/configure" element={<ExaminerConfigurePage />} />
                    <Route path="/examiner/studies/:studyId" element={<ExaminerStudyPage />} />
                    <Route path="/examiner/studies/:studyId/report" element={<ExaminerReportPage />} />
                    <Route path="/control-center" element={<ControlCenterPage />} />
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
                    {/* B1-05: an unknown route used to blank the page (the
                        catch-all painted nothing). One quiet explanation with a
                        way back beats a white screen. */}
                    <Route path="*" element={<NotFoundPage />} />
                  </Routes>
                </ErrorBoundary>
            </AuthenticatedShell>
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
