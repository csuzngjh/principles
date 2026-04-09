import React, { useEffect, useState, useMemo } from 'react';
import { ChevronLeft, ChevronDown, ChevronUp, Search, ArrowUpDown } from 'lucide-react';
import { api } from '../api';
import type { ThinkingOverviewResponse, ThinkingModelDetailResponse } from '../types';
import { EmptyState, LineChart, StatusBadge, CollapsiblePanel } from '../charts';
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
// Heatmap color helper
// ---------------------------------------------------------------------------

function heatmapBg(hits: number, maxHits: number): string {
  if (hits === 0) return 'var(--bg-sunken)';
  const intensity = hits / maxHits;
  return `rgba(91, 139, 160, ${Math.max(0.15, intensity * 0.55).toFixed(2)})`;
}

// ---------------------------------------------------------------------------
// ThinkingModelsPage
// ---------------------------------------------------------------------------

export function ThinkingModelsPage() {
  const { t } = useI18n();
  const [data, setData] = useState<ThinkingOverviewResponse | null>(null);
  const [detail, setDetail] = useState<ThinkingModelDetailResponse | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [error, setError] = useState('');

  // Phase 3: filter by recommendation
  const [recFilter, setRecFilter] = useState('all');

  // Phase 7: search and sort
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'hits' | 'successRate' | 'name'>('hits');

  // Phase 6: multi-select for comparison
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);

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

    // Phase 3: filter by recommendation
    if (recFilter !== 'all') {
      models = models.filter(m => m.recommendation === recFilter);
    }

    // Phase 7: search
    if (search) {
      const q = search.toLowerCase();
      models = models.filter(m =>
        m.name.toLowerCase().includes(q) ||
        m.commonScenarios.some(s => s.toLowerCase().includes(q))
      );
    }

    // Phase 7: sort
    models.sort((a, b) => {
      if (sortBy === 'hits') return b.hits - a.hits;
      if (sortBy === 'successRate') return b.successRate - a.successRate;
      return a.name.localeCompare(b.name);
    });

    return models;
  }, [data, recFilter, search, sortBy]);

  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;

  const hasNoModels = data.topModels.length === 0;
  const hasCoverageTrend = data.coverageTrend.length >= 1;
  const hasScenarioMatrix = data.scenarioMatrix.length > 0;
  const hasDormant = data.dormantModels.length > 0;

  // Coverage trend chart data
  const coverageChartData = data.coverageTrend.map(d => ({
    label: d.day.slice(5),
    value: Math.round(d.coverageRate * 100),
  }));

  // Scenario heatmap data
  const allScenarios = [...new Set(data.scenarioMatrix.map(m => m.scenario))].sort();
  const hitMap = new Map<string, number>();
  for (const entry of data.scenarioMatrix) {
    hitMap.set(`${entry.modelId}::${entry.scenario}`, entry.hits);
  }
  const maxHits = Math.max(...data.scenarioMatrix.map(m => m.hits), 1);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>{t('thinkingModels.pageTitle')}</h2>
          {data.modelDefinitions && (
            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              {t('thinkingModels.thinkingOsSource')}: THINKING_OS.md
            </span>
          )}
        </div>
        <div className="pill-row">
          <span className="badge">{t('thinkingModels.coverage')} {formatPercent(data.summary.coverageRate)}</span>
          <span className="badge">{t('thinkingModels.active')} {data.summary.activeModels}</span>
          <span className="badge">{t('thinkingModels.dormant')} {data.summary.dormantModels}</span>
          <span className="badge">{t('thinkingModels.effective')} {data.summary.effectiveModels}</span>
        </div>
      </header>

      {hasNoModels ? (
        <EmptyState
          title={t('thinkingModels.noModelsYet')}
          description={t('thinkingModels.noModelsYetDesc')}
        />
      ) : (
        <>
          {/* Phase 1: Coverage Trend Chart (VIZ-01) */}
          <section className="panel" style={{ marginBottom: 'var(--space-4)' }}>
            <h3 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 8 }}>
              {t('thinkingModels.coverageTrend')}
            </h3>
            {hasCoverageTrend ? (
              <LineChart
                data={coverageChartData}
                width={560}
                height={160}
                color="var(--accent)"
                showGrid
                showDots
                showArea
              />
            ) : (
              <EmptyState
                title={t('thinkingModels.emptyCoverageTrend')}
                description={t('thinkingModels.emptyCoverageTrendDesc')}
              />
            )}
          </section>

          {/* Phase 7: Search + Sort bar */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 'var(--space-3)', alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
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
          </div>

          <div className="grid two-columns wide-right">
            <section className="panel">
              {/* Phase 3: Recommendation filter */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
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

              <div className="list-table">
                {filteredModels.map((item) => (
                  <button
                    className={`table-row ${selectedModel === item.modelId ? 'active' : ''}`}
                    key={item.modelId}
                    onClick={() => { setSelectedModel(item.modelId); setDetail(null); }}
                  >
                    <div>
                      <strong>{item.name}</strong>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200, display: 'block' }}>
                        {item.commonScenarios.join(', ') || 'No scenarios yet'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{item.hits} hits</span>
                      {/* Phase 3: Color-coded recommendation badge */}
                      {REC_BADGE[item.recommendation] && (
                        <StatusBadge variant={REC_BADGE[item.recommendation].variant}>
                          {REC_BADGE[item.recommendation].label(t)}
                        </StatusBadge>
                      )}
                    </div>
                    <div className="align-right">
                      <strong>{formatPercent(item.successRate)}</strong>
                      <span>{formatPercent(item.failureRate)} failure</span>
                    </div>
                  </button>
                ))}
              </div>

              {/* Phase 3: Dormant models section */}
              {hasDormant && (
                <CollapsiblePanel
                  title={t('thinkingModels.dormantModels')}
                  badge={`${data.dormantModels.length}`}
                  defaultCollapsed
                >
                  {data.dormantModels.map(model => (
                    <div key={model.modelId} style={{ padding: '6px 8px', fontSize: '0.75rem', borderBottom: '1px solid var(--border)' }}>
                      <strong style={{ color: 'var(--text-secondary)' }}>{model.name}</strong>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                        {model.description}
                      </div>
                    </div>
                  ))}
                </CollapsiblePanel>
              )}
              {!hasDormant && data.summary.dormantModels === 0 && (
                <div style={{ padding: 'var(--space-2)', textAlign: 'center', fontSize: '0.75rem', color: 'var(--success)' }}>
                  ✓ {t('thinkingModels.emptyAllActive')}
                </div>
              )}
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
                    {REC_BADGE[detail.modelMeta.recommendation] && (
                      <StatusBadge variant={REC_BADGE[detail.modelMeta.recommendation].variant}>
                        {REC_BADGE[detail.modelMeta.recommendation].label(t)}
                      </StatusBadge>
                    )}
                  </div>

                  {/* Phase 2: Usage trend chart */}
                  {detail.usageTrend.length >= 1 && (
                    <article>
                      <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: 8 }}>
                        {t('thinkingModels.usageTrend') || 'Usage Trend'}
                      </h4>
                      <LineChart
                        data={detail.usageTrend.map(d => ({
                          label: d.day.slice(5),
                          value: d.hits,
                        }))}
                        width={500}
                        height={120}
                        color="var(--accent)"
                        showGrid
                        showDots
                        showArea
                      />
                    </article>
                  )}

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

                  {/* Phase 4: Event context details */}
                  <article>
                    <h4>{t('thinkingModels.recentEvents')}</h4>
                    <div className="stack">
                      {detail.recentEvents.map((event) => (
                        <div className="row-card vertical" key={event.id}>
                          <div>
                            <strong>{formatDate(event.createdAt)}</strong>
                            <span>{event.scenarios.join(', ') || 'No scenarios'}</span>
                          </div>
                          {/* Phase 4: toolContext */}
                          {(event as any).toolContext?.length > 0 && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                              🛠 {(event as any).toolContext.map((tc: any) => (
                                <span key={tc.toolName}>
                                  {tc.toolName} ({tc.outcome}{tc.errorType ? `: ${tc.errorType}` : ''})
                                </span>
                              )).join(', ')}
                            </div>
                          )}
                          {/* Phase 4: painContext */}
                          {(event as any).painContext?.length > 0 && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--error)' }}>
                              ⚡ {(event as any).painContext.map((pc: any) => `${pc.source} (${pc.score})`).join(', ')}
                            </div>
                          )}
                          {/* Phase 4: principleContext */}
                          {(event as any).principleContext?.length > 0 && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--info)' }}>
                              📋 {(event as any).principleContext.map((pr: any) => `${pr.principleId} ${pr.eventType}`).join(', ')}
                            </div>
                          )}
                          <pre style={{ fontSize: '0.7rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {event.triggerExcerpt}
                          </pre>
                          {/* Phase 4: matchedPattern */}
                          {(event as any).matchedPattern && (
                            <code style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                              /{(event as any).matchedPattern}/
                            </code>
                          )}
                        </div>
                      ))}
                    </div>
                  </article>
                </div>
              )}
            </section>
          </div>

          {/* Phase 1: Scenario Heatmap (VIZ-03) */}
          {hasScenarioMatrix && (
            <section className="panel" style={{ marginTop: 'var(--space-4)' }}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 8 }}>
                {t('thinkingModels.scenarioHeatmap')}
              </h3>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ position: 'sticky', left: 0, background: 'var(--bg-panel)', zIndex: 1, minWidth: 100, textAlign: 'left', padding: '4px 8px', fontSize: '0.7rem', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
                        Model
                      </th>
                      {allScenarios.map(sc => (
                        <th key={sc} style={{ textAlign: 'center', fontSize: '0.65rem', padding: '4px 6px', writingMode: 'vertical-lr', transform: 'rotate(180deg)', height: 80, borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                          {sc}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.topModels.map(model => (
                      <tr key={model.modelId}>
                        <td style={{ position: 'sticky', left: 0, background: 'var(--bg-panel)', fontWeight: 500, fontSize: '0.75rem', padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
                          {model.name}
                        </td>
                        {allScenarios.map(sc => {
                          const hits = hitMap.get(`${model.modelId}::${sc}`) ?? 0;
                          return (
                            <td
                              key={sc}
                              style={{
                                textAlign: 'center',
                                backgroundColor: heatmapBg(hits, maxHits),
                                padding: '4px 6px',
                                fontSize: '0.7rem',
                                fontWeight: hits > 0 ? 600 : 400,
                                color: hits > 0 ? 'var(--text-primary)' : 'var(--text-secondary)',
                                borderBottom: '1px solid var(--border)',
                              }}
                              title={`${model.name} × ${sc}: ${hits} hits`}
                            >
                              {hits}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {!hasScenarioMatrix && (
            <section className="panel" style={{ marginTop: 'var(--space-4)' }}>
              <EmptyState
                title={t('thinkingModels.emptyScenarioMatrix')}
                description={t('thinkingModels.emptyScenarioMatrixDesc')}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
