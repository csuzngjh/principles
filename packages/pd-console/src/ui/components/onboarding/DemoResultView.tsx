import { useTranslation } from 'react-i18next';

export interface DemoStage {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  detail?: string;
}

export interface DemoResultData {
  status: string;
  generatedAt?: string;
  narrative?: string;
  storyDescription?: string;
  stages?: DemoStage[];
  simulated?: boolean;
}

interface DemoResultViewProps {
  result: DemoResultData | null;
  loading: boolean;
  error: string | null;
}

export function DemoResultView({ result, loading, error }: DemoResultViewProps) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="demo-result-view demo-loading" role="status" aria-live="polite">
        <span className="demo-status-text">{t('pages.welcome.step2.demoRunning')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="demo-result-view demo-error" role="alert">
        <span className="demo-status-text">{t('pages.welcome.step2.demoFailed')}</span>
        <p className="demo-error-detail">{error}</p>
      </div>
    );
  }

  if (!result) {
    return null;
  }

  return (
    <div className="demo-result-view" role="region" aria-label={t('pages.welcome.step2.demoComplete')}>
      {result.simulated && (
        <div className="demo-simulated-banner" role="note">
          {t('pages.welcome.step2.demoSimulatedNote')}
        </div>
      )}

      {result.narrative && (
        <div className="demo-narrative">
          <p>{result.narrative}</p>
        </div>
      )}

      {result.stages && result.stages.length > 0 && (
        <ol className="demo-stages">
          {result.stages.map((stage, idx) => (
            <li key={idx} className={`demo-stage demo-stage-${stage.status}`}>
              <span className="demo-stage-name">{stage.name}</span>
              {stage.detail && <span className="demo-stage-detail">{stage.detail}</span>}
            </li>
          ))}
        </ol>
      )}

      <div className="demo-labels">
        <div className="demo-label-item">
          <span className="demo-label-title">{t('pages.welcome.step2.evidenceLabel')}</span>
        </div>
        <div className="demo-label-item">
          <span className="demo-label-title">{t('pages.welcome.step2.candidateLabel')}</span>
        </div>
        <div className="demo-label-item">
          <span className="demo-label-title">{t('pages.welcome.step2.ownerGateLabel')}</span>
        </div>
        <div className="demo-label-item">
          <span className="demo-label-title">{t('pages.welcome.step2.activationLabel')}</span>
        </div>
        <div className="demo-label-item">
          <span className="demo-label-title">{t('pages.welcome.step2.rollbackLabel')}</span>
        </div>
      </div>
    </div>
  );
}
