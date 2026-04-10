import React, { useEffect, useState, useMemo } from 'react';
import { ChevronLeft, Search, ArrowUpDown, Info } from 'lucide-react';
import { api } from '../api';
import type { ThinkingOverviewResponse, ThinkingModelDetailResponse } from '../types';
import { EmptyState, LineChart, StatusBadge } from '../charts';
import { useI18n } from '../i18n/ui';
import { formatPercent, formatDate } from '../utils/format';
import { Loading, ErrorState } from '../components';

// ---------------------------------------------------------------------------
// Recommendation badge helper
// ---------------------------------------------------------------------------

type BadgeVariant = 'success' | 'warning' | 'neutral';

const REC_BADGE: Record<string, { variant: BadgeVariant; label: (t: (k: string) => string) => string }> = {
  reinforce: { variant: 'success', label: (t) => t('thinkingModels.reinforce') },
  rework: { variant: 'warning', label: (t) => t('thinkingModels.rework') },
  archive: { variant: 'neutral', label: (t) => t('thinkingModels.archive') },
};

// ---------------------------------------------------------------------------
// ThinkingModelsPage — Redesigned Layout
// ---------------------------------------------------------------------------

export function ThinkingModelsPage() {
  const { t } = useI18n();
  const [data, setData] = useState<ThinkingOverviewResponse | null>(null);
  const [detail, setDetail] = useState<ThinkingModelDetailResponse | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [error, setError] = useState('');

  // Filters
  const [recFilter, setRecFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'hits' | 'successRate' | 'name'>('hits');

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

  // Filtered + sorted model list
  const filteredModels = useMemo(() => {
    if (!data) return [];
    let models = [...data.topModels];
    if (recFilter !== 'all') {
      models = models.filter(m => m.recommendation === recFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      models = models.filter(m =>
        m.name.toLowerCase().includes(q) ||
        m.commonScenarios.some(s => s.toLowerCase().includes(q))
      );
    }
    models.sort((a, b) => {
      if (sortBy === 'hits') return b.hits - a.hits;
      if (sortBy === 'successRate') return b.successRate - a.successRate;
      return a.name.localeCompare(b.name);
    });
    return models;
  }, [data, recFilter, search, sortBy]);

  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;

  const totalHits = data.topModels.reduce((sum, m) => sum + m.hits, 0);
  const hasData = totalHits > 0;

  return (
    <div className="page">
      {/* ── Header ── */}
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

      {!hasData ? (
        /* ── No data yet: show model definitions grid ── */
        <section className="panel" style={{ marginBottom: 'var(--space-4)' }}>
          <div style={{ textAlign: 'center', padding: 'var(--space-5)', color: 'var(--text-secondary)' }}>
            <div style={{ fontSize: '2rem', marginBottom: 8 }}>🧠</div>
            <h3 style={{ marginBottom: 4 }}>{t('thinkingModels.noDataTitle') || '思维模型定义'}</h3>
            <p style={{ fontSize: '0.85rem', maxWidth: 500, margin: '0 auto 24px' }}>
              {t('thinkingModels.noDataDesc') || '以下是 10 个思维模型的定义。当 AI 开始使用后，这里会显示每个模型的使用统计。'}
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {data.topModels.map(model => (
              <div
                key={model.modelId}
                style={{
                  padding: 12,
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--bg-sunken)',
                  cursor: 'pointer',
                }}
                onClick={() => { setSelectedModel(model.modelId); setDetail(null); }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <strong style={{ fontSize: '0.85rem' }}>{model.modelId}: {model.name}</strong>
                </div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0 0 8px', lineHeight: 1.4 }}>
                  {model.description}
                </p>
                {model.commonScenarios.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {model.commonScenarios.slice(0, 3).map(s => (
                      <span key={s} style={{ fontSize: '0.65rem', padding: '1px 6px', background: 'rgba(91,139,160,0.1)', borderRadius: 3, color: 'var(--info)' }}>
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : (
        /* ── Has data: full dashboard ── */
        <>
          {/* Coverage Trend */}
          {data.coverageTrend.length >= 1 && (
            <section className="panel" style={{ marginBottom: 'var(--space-4)' }}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 8 }}>
                {t('thinkingModels.coverageTrend')}
              </h3>
              <LineChart
                data={data.coverageTrend.map(d => ({ label: d.day.slice(5), value: Math.round(d.coverageRate * 100) }))}
                width={560}
                height={140}
                color="var(--accent)"
                showGrid
                showDots
                showArea
              />
            </section>
          )}

          {/* Search + Sort + Filter */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: '1 1 200px' }}>
              <Search size={14} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
              <input
                type="text"
                placeholder={t('common.search') || 'Search...'}
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ paddingLeft: 28, width: '100%', padding: '6px 8px 6px 28px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-panel)', color: 'var(--text-primary)', fontSize: '0.8rem' }}
              />
            </div>
            <button
              onClick={() => setSortBy(prev => prev === 'hits' ? 'successRate' : prev === 'successRate' ? 'name' : 'hits')}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-panel)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.75rem' }}
            >
              <ArrowUpDown size={14} />
              {sortBy === 'hits' ? 'Hits' : sortBy === 'successRate' ? 'Success' : 'Name'}
            </button>
            <div style={{ display: 'flex', gap: 4 }}>
              {['all', 'reinforce', 'rework', 'archive'].map(key => (
                <button
                  key={key}
                  onClick={() => setRecFilter(key)}
                  style={{
                    padding: '3px 8px',
                    border: `1px solid ${recFilter === key ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 4,
                    background: recFilter === key ? 'rgba(91, 139, 160, 0.15)' : 'transparent',
                    color: recFilter === key ? 'var(--accent)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: '0.7rem',
                  }}
                >
                  {key === 'all' ? 'All' : REC_BADGE[key]?.label(t)}
                </button>
              ))}
            </div>
          </div>

          {/* Two-column layout: Model List + Detail */}
          <div className="grid two-columns wide-right">
            {/* Left: Model List */}
            <section className="panel">
              <div className="list-table">
                {filteredModels.map((item) => (
                  <button
                    className={`table-row ${selectedModel === item.modelId ? 'active' : ''}`}
                    key={item.modelId}
                    onClick={() => { setSelectedModel(item.modelId); setDetail(null); }}
                  >
                    <div>
                      <strong>{item.name}</strong>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180, display: 'block' }}>
                        {item.commonScenarios.join(', ') || '—'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{item.hits}</span>
                      {REC_BADGE[item.recommendation] && (
                        <StatusBadge variant={REC_BADGE[item.recommendation].variant}>
                          {REC_BADGE[item.recommendation].label(t)}
                        </StatusBadge>
                      )}
                    </div>
                  </button>
                ))}
                {filteredModels.length === 0 && (
                  <div style={{ padding: 'var(--space-4)', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    No models match your filters.
                  </div>
                )}
              </div>
            </section>

            {/* Right: Detail Panel */}
            <section className="panel">
              {!detail && <EmptyState title={t('thinkingModels.emptyTitle')} description={t('thinkingModels.emptyDesc')} />}
              {detail && (
                <div className="detail-stack">
                  <div className="detail-header">
                    <button className="back-button" onClick={() => setDetail(null)} title="Back">
                      <ChevronLeft strokeWidth={1.75} size={18} />
                    </button>
                    <div>
                      <h3>{detail.modelMeta.name}</h3>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{detail.modelMeta.description}</p>
                    </div>
                    {REC_BADGE[detail.modelMeta.recommendation] && (
                      <StatusBadge variant={REC_BADGE[detail.modelMeta.recommendation].variant}>
                        {REC_BADGE[detail.modelMeta.recommendation].label(t)}
                      </StatusBadge>
                    )}
                  </div>

                  {/* Usage Trend */}
                  {detail.usageTrend.length >= 1 && (
                    <article>
                      <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: 8 }}>
                        {t('thinkingModels.usageTrend') || 'Usage Trend'}
                      </h4>
                      <LineChart
                        data={detail.usageTrend.map(d => ({ label: d.day.slice(5), value: d.hits }))}
                        width={500}
                        height={100}
                        color="var(--accent)"
                        showGrid
                        showDots
                        showArea
                      />
                    </article>
                  )}

                  {/* Outcome Stats */}
                  <article>
                    <h4>{t('thinkingModels.outcomeStats')}</h4>
                    <div className="pill-row">
                      <span className="badge">{t('thinkingModels.success')} {formatPercent(detail.outcomeStats.successRate)}</span>
                      <span className="badge">{t('thinkingModels.failure')} {formatPercent(detail.outcomeStats.failureRate)}</span>
                      <span className="badge">{t('thinkingModels.pain')} {formatPercent(detail.outcomeStats.painRate)}</span>
                      <span className="badge">{t('thinkingModels.correction')} {formatPercent(detail.outcomeStats.correctionRate)}</span>
                    </div>
                  </article>

                  {/* Scenario Distribution */}
                  {detail.scenarioDistribution.length > 0 && (
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
                  )}

                  {/* Recent Events */}
                  {detail.recentEvents.length > 0 && (
                    <article>
                      <h4>{t('thinkingModels.recentEvents')}</h4>
                      <div className="stack">
                        {detail.recentEvents.map((event) => (
                          <div className="row-card vertical" key={event.id}>
                            <div>
                              <strong>{formatDate(event.createdAt)}</strong>
                              <span>{event.scenarios.join(', ') || '—'}</span>
                            </div>
                            {(event as any).toolContext?.length > 0 && (
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                                🛠 {(event as any).toolContext.map((tc: any) => `${tc.toolName} (${tc.outcome})`).join(', ')}
                              </div>
                            )}
                            {(event as any).painContext?.length > 0 && (
                              <div style={{ fontSize: '0.7rem', color: 'var(--error)' }}>
                                ⚡ {(event as any).painContext.map((pc: any) => `${pc.source} (${pc.score})`).join(', ')}
                              </div>
                            )}
                            {(event as any).principleContext?.length > 0 && (
                              <div style={{ fontSize: '0.7rem', color: 'var(--info)' }}>
                                📋 {(event as any).principleContext.map((pr: any) => `${pr.principleId}`).join(', ')}
                              </div>
                            )}
                            <pre style={{ fontSize: '0.7rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                              {event.triggerExcerpt}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </article>
                  )}

                  {/* No data message for detail */}
                  {detail.usageTrend.length === 0 && detail.recentEvents.length === 0 && (
                    <div style={{ textAlign: 'center', padding: 'var(--space-4)', color: 'var(--text-secondary)' }}>
                      <Info size={20} style={{ marginBottom: 8 }} />
                      <p style={{ fontSize: '0.8rem' }}>No usage data for this model yet.</p>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
