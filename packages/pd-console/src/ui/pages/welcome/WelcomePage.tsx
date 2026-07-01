import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CircuitDiagram } from '../../components/onboarding/CircuitDiagram.js';
import { DemoResultView, type DemoResultData, type DemoStage } from '../../components/onboarding/DemoResultView.js';
import { getOnboardingState, setOnboardingState, type OnboardingState } from '../../utils/onboarding-state.js';
import { request } from '../../api.js';

// Polling configuration for step 3 evidence detection (spec 6.5.2).
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;

interface WelcomePageProps {
  workspaceId: string;
}

type DemoStatus = 'idle' | 'loading' | 'success' | 'error';

interface DemoResponse {
  demo: DemoResultData;
  simulated: boolean;
}

// rc-1/rc-2/rc-4: validate the demo response shape before use.
// The backend owns this shape, but parsed JSON is treated as unknown.
function isDemoStage(value: unknown): value is DemoStage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || typeof v.status !== 'string') return false;
  return v.status === 'passed' || v.status === 'failed' || v.status === 'degraded' || v.status === 'skipped';
}

function parseDemoResponse(value: unknown): DemoResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.simulated !== 'boolean') return null;
  if (typeof v.demo !== 'object' || v.demo === null) return null;
  const d = v.demo as Record<string, unknown>;
  if (typeof d.status !== 'string') return null;

  const demo: DemoResultData = { status: d.status };
  if (typeof d.generatedAt === 'string') demo.generatedAt = d.generatedAt;
  if (typeof d.narrative === 'string') demo.narrative = d.narrative;
  if (typeof d.storyDescription === 'string') demo.storyDescription = d.storyDescription;
  if (typeof d.simulated === 'boolean') demo.simulated = d.simulated;
  if (Array.isArray(d.stages)) demo.stages = d.stages.filter(isDemoStage);
  return { demo, simulated: v.simulated };
}
export function WelcomePage({ workspaceId }: WelcomePageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [demoStatus, setDemoStatus] = useState<DemoStatus>('idle');
  const [demoResult, setDemoResult] = useState<DemoResultData | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [pollingActive, setPollingActive] = useState(false);
  const [pollingStatus, setPollingStatus] = useState<'idle' | 'polling' | 'timeout' | 'evidence-found'>('idle');

  // Refs for polling cleanup (spec 6.5.2 test case 3: unmount clears timers).
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // P2-3: baseline record count captured when polling starts, so we only
  // trigger evidence-found on NEW evidence (not pre-existing records).
  const baselineCountRef = useRef<number>(0);

  // If onboarding was already completed for this workspace, skip the wizard.
  useEffect(() => {
    const state = getOnboardingState(workspaceId);
    if (state.completed) {
      navigate('/focus', { replace: true });
    }
  }, [workspaceId, navigate]);

  const completeOnboarding = useCallback((status: OnboardingState['status']) => {
    setOnboardingState(workspaceId, {
      completed: true,
      step: 3,
      status,
      completedAt: new Date().toISOString(),
    });
    navigate('/focus', { replace: true });
  }, [workspaceId, navigate]);

  const runDemo = useCallback(async () => {
    setDemoStatus('loading');
    setDemoError(null);
    try {
      const response = await request(
        '/api/v1/onboarding/run-demo',
        { method: 'POST' },
        parseDemoResponse,
      );
      if (!response.success) {
        throw new Error(response.error);
      }
      setDemoResult(response.data.demo);
      setDemoStatus('success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Demo failed to start';
      setDemoError(message);
      setDemoStatus('error');
    }
  }, []);

  const skipOnboarding = useCallback(() => {
    completeOnboarding('skipped');
  }, [completeOnboarding]);

  // EP-05 (Loop State Freshness): each poll fetches fresh evidence.
  const stopPolling = useCallback(() => {
    setPollingActive(false);
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    setPollingActive(true);
    setPollingStatus('polling');

    pollingTimeoutRef.current = setTimeout(() => {
      setPollingStatus('timeout');
      stopPolling();
    }, TWO_HOURS_MS);

    // P2-3: capture baseline count on first poll, then only trigger
    // evidence-found when count exceeds baseline (NEW evidence appeared).
    let baselineCaptured = false;

    const checkForEvidence = async () => {
      try {
        const response = await request('/api/v1/evidence-chain');
        if (response.success && response.data) {
          const data = response.data;
          if (typeof data === 'object' && data !== null && Object.hasOwn(data, 'records')) {
            const records = (data as { records: unknown }).records;
            if (Array.isArray(records)) {
              if (!baselineCaptured) {
                // First poll: capture baseline count, do not trigger.
                baselineCountRef.current = records.length;
                baselineCaptured = true;
                return;
              }
              if (records.length > baselineCountRef.current) {
                setPollingStatus('evidence-found');
                stopPolling();
              }
            }
          }
        }
      } catch {
        // Continue polling on transient errors (rc-9: status reflects polling).
      }
    };

    checkForEvidence();
    pollingIntervalRef.current = setInterval(checkForEvidence, POLL_INTERVAL_MS);
  }, [stopPolling]);

  // Cleanup on unmount (spec 6.5.2 test case 3: no memory leak).
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);
  return (
    <div className="welcome-page" role="main">
      <header className="welcome-header">
        <h1>{t('pages.welcome.title')}</h1>
        <p className="welcome-subtitle">{t('pages.welcome.subtitle')}</p>
        <div
          className="welcome-step-indicator"
          role="progressbar"
          aria-valuetext={t('pages.welcome.stepIndicator', { current: step, total: 3 })}
        >
          {[1, 2, 3].map((s) => (
            <span
              key={s}
              className={`step-dot ${s === step ? 'active' : ''} ${s < step ? 'completed' : ''}`}
            />
          ))}
        </div>
      </header>

      {step === 1 && (
        <section className="welcome-step welcome-step-1" aria-labelledby="step1-title">
          <h2 id="step1-title">{t('pages.welcome.step1.title')}</h2>
          <p>{t('pages.welcome.step1.description')}</p>
          <CircuitDiagram />
          <div className="welcome-actions">
            <button className="pd-btn pd-btn-brand" onClick={() => setStep(2)}>
              {t('pages.welcome.step1.startButton')}
            </button>
            <button className="pd-btn pd-btn-alt" onClick={skipOnboarding}>
              {t('pages.welcome.step1.skipButton')}
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="welcome-step welcome-step-2" aria-labelledby="step2-title">
          <h2 id="step2-title">{t('pages.welcome.step2.title')}</h2>
          <p>{t('pages.welcome.step2.description')}</p>
          <DemoResultView
            result={demoResult}
            loading={demoStatus === 'loading'}
            error={demoError}
          />
          <div className="welcome-actions">
            {demoStatus === 'idle' && (
              <button className="pd-btn pd-btn-brand" onClick={runDemo}>
                {t('pages.welcome.step2.runDemoButton')}
              </button>
            )}
            <button className="pd-btn pd-btn-alt" onClick={() => setStep(3)}>
              {t('pages.welcome.step2.nextButton')}
            </button>
          </div>
        </section>
      )}
      {step === 3 && (
        <section className="welcome-step welcome-step-3" aria-labelledby="step3-title">
          <h2 id="step3-title">{t('pages.welcome.step3.title')}</h2>
          <p>{t('pages.welcome.step3.description')}</p>
          <div className="example-prompt" role="note">
            <span className="prompt-label">{t('pages.welcome.step3.examplePrompt')}</span>
            <code className="prompt-text">{t('pages.welcome.step3.examplePromptText')}</code>
          </div>

          {pollingStatus === 'idle' && (
            <>
              <p className="window-hint">{t('pages.welcome.step3.windowHint')}</p>
              <div className="welcome-actions">
                <button className="pd-btn pd-btn-brand" onClick={() => { startPolling(); }}>
                  {t('pages.welcome.step3.tryNowButton')}
                </button>
                <button className="pd-btn pd-btn-alt" onClick={() => completeOnboarding('demo')}>
                  {t('pages.welcome.step3.goToFocusButton')}
                </button>
                <button className="pd-btn pd-btn-alt" onClick={skipOnboarding}>
                  {t('pages.welcome.step3.skipButton')}
                </button>
              </div>
            </>
          )}

          {pollingStatus === 'polling' && (
            <div className="polling-active" role="status" aria-live="polite">
              <p>{t('pages.welcome.step3.pollingActive')}</p>
              <button className="pd-btn pd-btn-alt" onClick={() => { stopPolling(); completeOnboarding('demo'); }}>
                {t('pages.welcome.step3.stopPollingButton')}
              </button>
            </div>
          )}

          {pollingStatus === 'evidence-found' && (
            <div className="polling-success" role="status">
              <p>{t('pages.welcome.step3.evidenceFound')}</p>
              <button className="pd-btn pd-btn-brand" onClick={() => completeOnboarding('demo')}>
                {t('pages.welcome.step3.goToFocusButton')}
              </button>
            </div>
          )}

          {pollingStatus === 'timeout' && (
            <div className="polling-timeout" role="status">
              <p>{t('pages.welcome.step3.timeoutHint')}</p>
              <button className="pd-btn pd-btn-brand" onClick={() => completeOnboarding('demo')}>
                {t('pages.welcome.step3.goToFocusButton')}
              </button>
              <button className="pd-btn pd-btn-alt" onClick={skipOnboarding}>
                {t('pages.welcome.step3.skipButton')}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}