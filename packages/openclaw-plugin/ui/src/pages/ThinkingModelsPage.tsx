import React, { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { api } from '../api';
import type { ThinkingOverviewResponse, ThinkingModelDetailResponse } from '../types';
import { EmptyState } from '../charts';
import { useI18n } from '../i18n/ui';
import { formatPercent, formatDate } from '../utils/format';
import { Loading, ErrorState } from '../components';

export function ThinkingModelsPage() {
  const { t } = useI18n();
  const [data, setData] = useState<ThinkingOverviewResponse | null>(null);
  const [detail, setDetail] = useState<ThinkingModelDetailResponse | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.getThinkingOverview().then((value) => {
      setData(value);
      setSelectedModel(value.topModels[0]?.modelId ?? '');
    }).catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    if (!selectedModel) return;
    api.getThinkingModelDetail(selectedModel).then(setDetail).catch((err) => setError(String(err)));
  }, [selectedModel]);

  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>{t('thinkingModels.pageTitle')}</h2>
        </div>
        <div className="pill-row">
          <span className="badge">{t('thinkingModels.coverage')} {formatPercent(data.summary.coverageRate)}</span>
          <span className="badge">{t('thinkingModels.active')} {data.summary.activeModels}</span>
          <span className="badge">{t('thinkingModels.dormant')} {data.summary.dormantModels}</span>
          <span className="badge">{t('thinkingModels.effective')} {data.summary.effectiveModels}</span>
        </div>
      </header>

      <div className="grid two-columns wide-right">
        <section className="panel">
          <div className="list-table">
            {data.topModels.map((item) => (
              <button className={`table-row ${selectedModel === item.modelId ? 'active' : ''}`} key={item.modelId} onClick={() => setSelectedModel(item.modelId)}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.commonScenarios.join(', ') || 'No scenarios yet'}</span>
                </div>
                <div>
                  <span>{item.hits} hits</span>
                  <span>{item.recommendation}</span>
                </div>
                <div className="align-right">
                  <strong>{formatPercent(item.successRate)}</strong>
                  <span>{formatPercent(item.failureRate)} failure</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          {!detail && <EmptyState title={t('thinkingModels.emptyTitle')} description={t('thinkingModels.emptyDesc')} />}
          {detail && (
            <div className="detail-stack">
              <div className="detail-header">
                <button
                  className="back-button"
                  onClick={() => setDetail(null)}
                  title={t('common.back') || 'Back'}
                >
                  <ChevronLeft strokeWidth={1.75} size={18} />
                </button>
                <div>
                  <h3>{detail.modelMeta.name}</h3>
                  <p>{detail.modelMeta.description}</p>
                </div>
                <span className="badge">{detail.modelMeta.recommendation}</span>
              </div>
              <article>
                <h4>{t('thinkingModels.outcomeStats')}</h4>
                <div className="pill-row">
                  <span className="badge">{t('thinkingModels.success')} {formatPercent(detail.outcomeStats.successRate)}</span>
                  <span className="badge">{t('thinkingModels.failure')} {formatPercent(detail.outcomeStats.failureRate)}</span>
                  <span className="badge">{t('thinkingModels.pain')} {formatPercent(detail.outcomeStats.painRate)}</span>
                  <span className="badge">{t('thinkingModels.correction')} {formatPercent(detail.outcomeStats.correctionRate)}</span>
                </div>
              </article>
              <article>
                <h4>{t('thinkingModels.scenarioDistribution')}</h4>
                <div className="stack">
                  {detail.scenarioDistribution.map((item) => (
                    <div className="row-card" key={item.scenario}>
                      <strong>{item.scenario}</strong>
                      <span>{item.hits}</span>
                    </div>
                  ))}
                </div>
              </article>
              <article>
                <h4>{t('thinkingModels.recentEvents')}</h4>
                <div className="stack">
                  {detail.recentEvents.map((event) => (
                    <div className="row-card vertical" key={event.id}>
                      <div>
                        <strong>{formatDate(event.createdAt)}</strong>
                        <span>{event.scenarios.join(', ') || 'No scenarios'}</span>
                      </div>
                      <pre>{event.triggerExcerpt}</pre>
                    </div>
                  ))}
                </div>
              </article>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

