import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CircuitDiagram } from '../../components/onboarding/CircuitDiagram.js';
import { DemoResultView, type DemoResultData, type DemoStage } from '../../components/onboarding/DemoResultView.js';
import { getOnboardingState, setOnboardingState, type OnboardingState } from '../../utils/onboarding-state.js';
import { request } from '../../api.js';

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
  return v.status === 'pending' || v.status === 'running' || v.status === 'completed' || v.status === 'failed';
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
            {demoStatus === 'success' && (
              <button className="pd-btn pd-btn-brand" onClick={() => setStep(3)}>
                {t('pages.welcome.step2.nextButton')}
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
          <p className="window-hint">{t('pages.welcome.step3.windowHint')}</p>
          <div className="welcome-actions">
            <button className="pd-btn pd-btn-brand" onClick={() => completeOnboarding('demo')}>
              {t('pages.welcome.step3.tryNowButton')}
            </button>
            <button className="pd-btn pd-btn-alt" onClick={() => completeOnboarding('demo')}>
              {t('pages.welcome.step3.goToFocusButton')}
            </button>
            <button className="pd-btn pd-btn-alt" onClick={skipOnboarding}>
              {t('pages.welcome.step3.skipButton')}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
