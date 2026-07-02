import { useTranslation } from 'react-i18next';

export interface DemoStage {
  name: string;
  status: 'passed' | 'failed' | 'degraded' | 'skipped';
  reason?: string;
  nextAction?: string;
  evidenceRef?: string;
}

/**
 * Map backend demo stage identifiers (snake_case English, stable contract
 * from demo-story-a-runner.ts) to localized labels. Falls back to the raw
 * name if no mapping exists, so new stages still render (rc-9: no silent
 * failure) but future stages should be added here.
 */
const STAGE_LABEL_KEYS: Record<string, string> = {
  evidence_seed: 'pages.welcome.step2.stages.evidenceSeed',
  principle_proposal: 'pages.welcome.step2.stages.principleProposal',
  owner_review: 'pages.welcome.step2.stages.ownerReview',
  activation: 'pages.welcome.step2.stages.activation',
  follow_up_observation: 'pages.welcome.step2.stages.followUpObservation',
  rollback_proof: 'pages.welcome.step2.stages.rollbackProof',
};

function localizeStageName(rawName: string, t: (key: string) => string): string {
  const key = STAGE_LABEL_KEYS[rawName];
  return key ? t(key) : rawName;
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

      {result.stages && result.stages.length > 0 && (
        <ol className="demo-stages">
          {result.stages.map((stage, idx) => (
            <li key={idx} className={`demo-stage demo-stage-${stage.status}`}>
              <span className="demo-stage-name">{localizeStageName(stage.name, t)}</span>
              {stage.reason && <span className="demo-stage-detail">{stage.reason}</span>}
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