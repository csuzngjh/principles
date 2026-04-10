import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { ChevronLeft, Search, ArrowUpDown, X, Columns } from 'lucide-react';
import { api } from '../api';
import type { ThinkingOverviewResponse, ThinkingModelDetailResponse, ThinkingModelSummary } from '../types';
import { EmptyState, LineChart, StatusBadge, CollapsiblePanel, Sparkline, MiniBarChart } from '../charts';
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

  // Comparison mode state
  const [selectedForCompare, setSelectedForCompare] = useState<string[]>([]);
  const [comparisonDetails, setComparisonDetails] = useState<Map<string, ThinkingModelDetailResponse>>(new Map());
  const [isComparing, setIsComparing] = useState(false);

  // Filters
  const [recFilter, setRecFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'hits' | 'successRate' | 'name'>('hits');

  // Cache for detail lookups during comparison
  const detailCache = useMemo(() => {
    const cache = new Map<string, ThinkingModelDetailResponse>();
    if (detail) cache.set(selectedModel, detail);
    comparisonDetails.forEach((d, id) => cache.set(id, d));
    return cache;
  }, [detail, selectedModel, comparisonDetails]);

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

  // Comparison mode handlers
  const toggleCompareSelection = useCallback((modelId: string) => {
    setSelectedForCompare(prev => {
      if (prev.includes(modelId)) {
        return prev.filter(id => id !== modelId);
      }
      if (prev.length >= 4) return prev; // Max 4 for layout
      return [...prev, modelId];
    });
  }, []);

  const startComparison = useCallback(async () => {
    if (selectedForCompare.length < 2) return;
    setIsComparing(true);
    const newDetails = new Map(comparisonDetails);
    const fetches = selectedForCompare
      .filter(id => !newDetails.has(id))
      .map(async (id) => {
        try {
          const d = await api.getThinkingModelDetail(id);
          newDetails.set(id, d);
        } catch {
          // Skip failed fetches
        }
      });
    await Promise.all(fetches);
    setComparisonDetails(newDetails);
  }, [selectedForCompare, comparisonDetails]);

  const exitComparison = useCallback(() => {
    setIsComparing(false);
    setSelectedForCompare([]);
    setComparisonDetails(new Map());
  }, []);

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
        (m.commonScenarios ?? []).some(s => s.toLowerCase().includes(q))
      );
    }
    models.sort((a, b) => {
      if (sortBy === 'hits') return b.hits - a.hits;
      if (sortBy === 'successRate') return b.successRate - a.successRate;
      return a.name.localeCompare(b.name);
    });
    return models;
  }, [data, recFilter, search, sortBy]);

  // Scenario heatmap data
  const heatmapData = useMemo(() => {
    if (!data || data.scenarioMatrix.length === 0) return null;
    const allScenarios = [...new Set(data.scenarioMatrix.map(m => m.scenario))].sort();
    const models = [...data.topModels].sort((a, b) => b.hits - a.hits);
    const hitMap = new Map<string, number>();
    for (const entry of data.scenarioMatrix) {
      hitMap.set(`${entry.modelId}::${entry.scenario}`, entry.hits);
    }
    const maxHits = Math.max(...data.scenarioMatrix.map(m => m.hits), 1);
    return { allScenarios, models, hitMap, maxHits };
  }, [data]);

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
          {data.thinkingSummary?.modelDefinitions && data.thinkingSummary.modelDefinitions.length > 0 && (
            <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
              {t('thinkingModels.thinkingOsSource')}: <code style={{ fontSize: '0.65rem', background: 'var(--bg-sunken)', padding: '1px 4px', borderRadius: 3 }}>THINKING_OS.md</code>
            </p>
          )}
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
                placeholder={t('thinkingModels.searchPlaceholder')}
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
              {sortBy === 'hits' ? t('thinkingModels.sortByHits') : sortBy === 'successRate' ? t('thinkingModels.sortBySuccessRate') : t('thinkingModels.sortByName')}
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
              {/* Compare button bar */}
              {selectedForCompare.length >= 2 && !isComparing && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', marginBottom: 8, background: 'rgba(91, 139, 160, 0.08)', borderRadius: 6, border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {selectedForCompare.length} {t('thinkingModels.compareSelected') || 'selected'}
                  </span>
                  <button
                    onClick={startComparison}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px', border: 'none', borderRadius: 4, background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}
                  >
                    <Columns size={14} />
                    {t('thinkingModels.compare')}
                  </button>
                </div>
              )}
              <div className="list-table">
                {filteredModels.map((item) => {
                  const isChecked = selectedForCompare.includes(item.modelId);
                  return (
                    <div
                      key={item.modelId}
                      className={`table-row ${selectedModel === item.modelId && !isComparing ? 'active' : ''}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', ...(item.recommendation === 'reinforce' ? { borderLeft: '3px solid var(--success)', paddingLeft: 'calc(var(--space-2) - 3px)' } : {}) }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleCompareSelection(item.modelId)}
                        onClick={e => e.stopPropagation()}
                        style={{ accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }}
                        title={t('thinkingModels.compare') || 'Compare'}
                      />
                      <button
                        onClick={() => { setSelectedModel(item.modelId); setDetail(null); setIsComparing(false); }}
                        style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', textAlign: 'left' }}
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
                    </div>
                  );
                })}
                {filteredModels.length === 0 && (
                  <EmptyState
                    title={t('thinkingModels.noModelsYet')}
                    description={t('thinkingModels.noModelsYetDesc')}
                  />
                )}
              </div>
            </section>

            {/* Right: Detail Panel / Comparison View */}
            <section className="panel">
              {isComparing ? (
                /* ── Comparison View ── */
                <div className="comparison-view">
                  <div className="detail-header" style={{ marginBottom: 16 }}>
                    <button className="back-button" onClick={exitComparison} title={t('thinkingModels.exitCompare') || 'Exit Compare'}>
                      <X strokeWidth={1.75} size={18} />
                    </button>
                    <div>
                      <h3>{t('thinkingModels.comparisonTitle')}</h3>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {selectedForCompare.length} {t('thinkingModels.compareSelected') || 'models'}
                      </p>
                    </div>
                  </div>

                  {/* Comparison grid: side-by-side metrics */}
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${selectedForCompare.length}, 1fr)`, gap: 12, marginBottom: 16 }}>
                    {selectedForCompare.map(modelId => {
                      const summary = data.topModels.find(m => m.modelId === modelId);
                      const det = comparisonDetails.get(modelId);
                      if (!summary) return null;
                      return (
                        <div key={modelId} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-sunken)' }}>
                          <strong style={{ fontSize: '0.85rem', display: 'block', marginBottom: 8 }}>{summary.name}</strong>
                          <div className="pill-row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
                            <span className="badge">{t('thinkingModels.hits')}: {summary.hits}</span>
                            <span className="badge">{t('thinkingModels.successRate')}: {formatPercent(summary.successRate)}</span>
                            <span className="badge">{t('thinkingModels.failureRate')}: {formatPercent(summary.failureRate)}</span>
                            <span className="badge">{t('thinkingModels.pain')}: {formatPercent(summary.painRate)}</span>
                          </div>
                          {det && det.outcomeStats && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                              <div>{t('thinkingModels.correction')}: {formatPercent(det.outcomeStats.correctionRate)}</div>
                              <div>{t('thinkingModels.coverage')}: {formatPercent(det.modelMeta.coverageRate)}</div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Usage Trends for each model */}
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${selectedForCompare.length}, 1fr)`, gap: 12 }}>
                    {selectedForCompare.map(modelId => {
                      const summary = data.topModels.find(m => m.modelId === modelId);
                      const det = comparisonDetails.get(modelId);
                      if (!det || det.usageTrend.length < 2) return null;
                      return (
                        <article key={modelId} style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-sunken)' }}>
                          <h4 style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: 6 }}>
                            {summary?.name} — {t('thinkingModels.usageTrend')}
                          </h4>
                          <LineChart
                            data={det.usageTrend.map(d => ({ label: d.day.slice(5), value: d.hits }))}
                            width={260}
                            height={80}
                            color="var(--accent)"
                            showGrid={false}
                            showDots
                            showArea
                          />
                        </article>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <>
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

                  {/* Trigger Conditions */}
                  {detail.modelMeta.trigger && (
                    <article>
                      <h4>{t('thinkingModels.trigger')}</h4>
                      <code style={{ fontSize: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-sunken)', padding: '8px 10px', borderRadius: 6, display: 'block', lineHeight: 1.5 }}>
                        {detail.modelMeta.trigger}
                      </code>
                    </article>
                  )}

                  {/* Anti-Patterns */}
                  {detail.modelMeta.antiPattern && (
                    <article>
                      <h4 style={{ color: 'var(--error)' }}>{t('thinkingModels.antiPattern')}</h4>
                      <code style={{ fontSize: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'rgba(220,53,69,0.08)', padding: '8px 10px', borderRadius: 6, display: 'block', lineHeight: 1.5, color: 'var(--error)' }}>
                        {detail.modelMeta.antiPattern}
                      </code>
                    </article>
                  )}

                  {/* Usage Trend */}
                  {detail.usageTrend.length >= 1 ? (
                    <article>
                      <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: 8 }}>
                        {t('thinkingModels.usageTrend')}
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
                  ) : (
                    <EmptyState
                      title={t('thinkingModels.emptyUsageTrend')}
                      description={t('thinkingModels.emptyUsageTrendDesc')}
                    />
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
                            {event.toolContext?.length > 0 && (
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                                {'\u{1F6E0}'} {event.toolContext.map(tc => (
                                  `${tc.toolName} (${tc.outcome}${tc.errorType ? `: ${tc.errorType}` : ''})`
                                )).join(', ')}
                              </div>
                            )}
                            {event.painContext?.length > 0 && (
                              <div style={{ fontSize: '0.7rem', color: 'var(--error)' }}>
                                {'\u26A1'} {event.painContext.map(pc => `${pc.source} (${pc.score})`).join(', ')}
                              </div>
                            )}
                            {event.principleContext?.length > 0 && (
                              <div style={{ fontSize: '0.7rem', color: 'var(--info)' }}>
                                {'\u{1F4CB}'} {event.principleContext.map(pr => (
                                  `${pr.principleId ?? '—'} ${pr.eventType ? `(${pr.eventType})` : ''}`
                                )).join(', ')}
                              </div>
                            )}
                            {event.matchedPattern && (
                              <code style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', background: 'var(--bg-sunken)', padding: '2px 6px', borderRadius: 3 }}>
                                /{event.matchedPattern}/
                              </code>
                            )}
                            <pre style={{ fontSize: '0.7rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                              {event.triggerExcerpt}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </article>
                  )}
                </div>
              )}
                </>
              )}
            </section>
          </div>

          {/* Dormant Models Section */}
          {data.dormantModels.length > 0 ? (
            <CollapsiblePanel
              title={t('thinkingModels.dormantModels')}
              badge={`${data.dormantModels.length}`}
              defaultCollapsed
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, padding: '8px 0' }}>
                {data.dormantModels.map(model => (
                  <div
                    key={model.modelId}
                    style={{
                      padding: '8px 10px',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      background: 'var(--bg-sunken)',
                    }}
                  >
                    <strong style={{ fontSize: '0.8rem' }}>{model.name}</strong>
                    <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: 1.3 }}>
                      {model.description}
                    </p>
                  </div>
                ))}
              </div>
            </CollapsiblePanel>
          ) : (
            <CollapsiblePanel
              title={t('thinkingModels.dormantModels')}
              defaultCollapsed
            >
              <EmptyState
                title={t('thinkingModels.emptyAllActive')}
                description={t('thinkingModels.emptyAllActiveDesc')}
              />
            </CollapsiblePanel>
          )}

          {/* Scenario Heatmap */}
          {heatmapData ? (
            <CollapsiblePanel title={t('thinkingModels.scenarioHeatmap')}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ position: 'sticky', left: 0, background: 'var(--bg-panel)', zIndex: 1, minWidth: 100, textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: '0.75rem', fontWeight: 600 }}>
                        Model
                      </th>
                      {heatmapData.allScenarios.map(sc => (
                        <th key={sc} style={{ textAlign: 'center', fontSize: '0.65rem', padding: '4px 6px', writingMode: 'vertical-lr', transform: 'rotate(180deg)', height: 80, borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                          {sc}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {heatmapData.models.map(model => (
                      <tr key={model.modelId}>
                        <td style={{ position: 'sticky', left: 0, background: 'var(--bg-panel)', fontWeight: 500, fontSize: '0.75rem', padding: '4px 8px', borderTop: '1px solid var(--border)' }}>
                          {model.name}
                        </td>
                        {heatmapData.allScenarios.map(sc => {
                          const hits = heatmapData.hitMap.get(`${model.modelId}::${sc}`) ?? 0;
                          const bgColor = hits === 0
                            ? 'var(--bg-sunken)'
                            : `rgba(91, 139, 160, ${Math.max(0.15, (hits / heatmapData.maxHits) * 0.55).toFixed(2)})`;
                          return (
                            <td
                              key={sc}
                              style={{
                                textAlign: 'center',
                                backgroundColor: bgColor,
                                padding: '4px 6px',
                                fontSize: '0.7rem',
                                fontWeight: hits > 0 ? 600 : 400,
                                borderTop: '1px solid var(--border)',
                                color: hits > 0 ? 'var(--text-primary)' : 'var(--text-secondary)',
                              }}
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
            </CollapsiblePanel>
          ) : (
            <CollapsiblePanel title={t('thinkingModels.scenarioHeatmap')}>
              <EmptyState
                title={t('thinkingModels.emptyScenarioMatrix')}
                description={t('thinkingModels.emptyScenarioMatrixDesc')}
              />
            </CollapsiblePanel>
          )}
        </>
      )}
    </div>
  );
}
