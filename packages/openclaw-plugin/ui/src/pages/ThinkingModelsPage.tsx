import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { ChevronLeft, Search, ArrowUpDown, X, Columns, Wrench, Zap, ClipboardList, Loader2 } from 'lucide-react';
import { api } from '../api';
import type { ThinkingOverviewResponse, ThinkingModelDetailResponse, ThinkingModelSummary } from '../types';
import { EmptyState, LineChart, StatusBadge, CollapsiblePanel, Sparkline, MiniBarChart } from '../charts';
import { useI18n } from '../i18n/ui';
import { formatPercent, formatDate } from '../utils/format';
import { Loading, ErrorState } from '../components';

// ---------------------------------------------------------------------------
// Design tokens (mirrors CSS custom properties for inline fallback)
// ---------------------------------------------------------------------------

const TEXT = {
  xs: '0.65rem',
  sm: '0.7rem',
  base: '0.75rem',
  lg: '0.8rem',
  xl: '0.85rem',
} as const;

const SPACE = {
  1: 'var(--space-1, 4px)',
  2: 'var(--space-2, 8px)',
  3: 'var(--space-3, 12px)',
  4: 'var(--space-4, 16px)',
  5: 'var(--space-5, 24px)',
  6: 'var(--space-6, 32px)',
} as const;

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
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState('');

  // Comparison mode state
  const [selectedForCompare, setSelectedForCompare] = useState<string[]>([]);
  const [comparisonDetails, setComparisonDetails] = useState<Map<string, ThinkingModelDetailResponse>>(new Map());
  const [isComparing, setIsComparing] = useState(false);
  const [comparisonLoadingModels, setComparisonLoadingModels] = useState<Set<string>>(new Set());

  // Filters
  const [recFilter, setRecFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'hits' | 'successRate' | 'name'>('hits');

  // Debounced search
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(search), 200);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, []);

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
    setIsLoadingDetail(true);
    api.getThinkingModelDetail(selectedModel)
      .then((d) => { setDetail(d); setIsLoadingDetail(false); })
      .catch((err) => { setError(String(err)); setIsLoadingDetail(false); });
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
    const pending = selectedForCompare.filter(id => !newDetails.has(id));

    // Track per-model loading state
    setComparisonLoadingModels(new Set(pending));

    const fetches = pending.map(async (id) => {
      try {
        const d = await api.getThinkingModelDetail(id);
        newDetails.set(id, d);
      } catch {
        // Skip failed fetches
      } finally {
        setComparisonLoadingModels(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    });
    await Promise.all(fetches);
    setComparisonDetails(newDetails);
  }, [selectedForCompare, comparisonDetails]);

  const exitComparison = useCallback(() => {
    setIsComparing(false);
    setSelectedForCompare([]);
    setComparisonDetails(new Map());
    setComparisonLoadingModels(new Set());
  }, []);

  // Filtered + sorted model list
  const filteredModels = useMemo(() => {
    if (!data) return [];
    let models = [...data.topModels];
    if (recFilter !== 'all') {
      models = models.filter(m => m.recommendation === recFilter);
    }
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
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
  }, [data, recFilter, debouncedSearch, sortBy]);

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
            <p style={{ fontSize: TEXT.sm, color: 'var(--text-secondary)', margin: `${SPACE[1]} 0 0` }}>
              {t('thinkingModels.thinkingOsSource')}: <code style={{ fontSize: TEXT.xs, background: 'var(--bg-sunken)', padding: '1px 4px', borderRadius: 3 }}>THINKING_OS.md</code>
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
        <section className="panel" style={{ marginBottom: SPACE[4] }}>
          <div style={{ textAlign: 'center', padding: SPACE[5], color: 'var(--text-secondary)' }}>
            <div style={{ fontSize: '2rem', marginBottom: SPACE[2] }}>🧠</div>
            <h3 style={{ marginBottom: SPACE[1] }}>{t('thinkingModels.noDataTitle')}</h3>
            <p style={{ fontSize: TEXT.lg, maxWidth: 500, margin: `0 auto ${SPACE[5]}` }}>
              {t('thinkingModels.noDataDesc')}
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: SPACE[3] }}>
            {data.topModels.map(model => (
              <div
                key={model.modelId}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedModel(model.modelId); setDetail(null); } }}
                style={{
                  padding: SPACE[3],
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--bg-sunken)',
                  cursor: 'pointer',
                }}
                onClick={() => { setSelectedModel(model.modelId); setDetail(null); }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: SPACE[2] }}>
                  <strong style={{ fontSize: TEXT.xl }}>{model.modelId}: {model.name}</strong>
                </div>
                <p style={{ fontSize: TEXT.base, color: 'var(--text-secondary)', margin: `0 0 ${SPACE[2]}`, lineHeight: 1.4 }}>
                  {model.description}
                </p>
                {model.commonScenarios.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACE[1] }}>
                    {model.commonScenarios.slice(0, 3).map(s => (
                      <span key={s} style={{ fontSize: TEXT.xs, padding: '1px 6px', background: 'rgba(91,139,160,0.1)', borderRadius: 3, color: 'var(--info)' }}>
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
            <section className="panel" style={{ marginBottom: SPACE[4] }}>
              <h3 className="section-title">
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
          <div style={{ display: 'flex', gap: SPACE[2], marginBottom: SPACE[3], alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: '1 1 200px' }}>
              <Search size={14} style={{ position: 'absolute', left: SPACE[2], top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
              <input
                type="text"
                placeholder={t('thinkingModels.searchPlaceholder')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ width: '100%', padding: `6px ${SPACE[2]} 6px 28px`, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-panel)', color: 'var(--text-primary)', fontSize: TEXT.lg }}
              />
            </div>
            <button
              onClick={() => setSortBy(prev => prev === 'hits' ? 'successRate' : prev === 'successRate' ? 'name' : 'hits')}
              className="sort-button"
            >
              <ArrowUpDown size={14} />
              {sortBy === 'hits' ? t('thinkingModels.sortByHits') : sortBy === 'successRate' ? t('thinkingModels.sortBySuccessRate') : t('thinkingModels.sortByName')}
            </button>
            <div style={{ display: 'flex', gap: SPACE[1] }}>
              {['all', 'reinforce', 'rework', 'archive'].map(key => (
                <button
                  key={key}
                  onClick={() => setRecFilter(key)}
                  className={`filter-button ${recFilter === key ? 'active' : ''}`}
                >
                  {key === 'all' ? t('thinkingModels.filterAll') : REC_BADGE[key]?.label(t)}
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
                <div className="compare-bar">
                  <span style={{ fontSize: TEXT.base, color: 'var(--text-secondary)' }}>
                    {selectedForCompare.length} {t('thinkingModels.compareSelected')}
                  </span>
                  <button
                    onClick={startComparison}
                    className="compare-button"
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
                      style={{ display: 'flex', alignItems: 'center', gap: SPACE[2], padding: `${SPACE[2]} ${SPACE[3]}`, ...(item.recommendation === 'reinforce' ? { borderLeft: '3px solid var(--success)', paddingLeft: `calc(${SPACE[2]} - 3px)` } : {}) }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleCompareSelection(item.modelId)}
                        onClick={e => e.stopPropagation()}
                        style={{ accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }}
                        aria-label={`${t('thinkingModels.compare')}: ${item.name}`}
                      />
                      <button
                        onClick={() => { setSelectedModel(item.modelId); setDetail(null); setIsComparing(false); }}
                        className="model-list-button"
                      >
                        <div>
                          <strong className="text-base">{item.name}</strong>
                          <span className="scenario-ellipsis">
                            {item.commonScenarios.join(', ') || '—'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: SPACE[2] }}>
                          <span className="hits-count">{item.hits}</span>
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
                    title={data.topModels.length > 0 ? (t('thinkingModels.noMatches') || 'No models match your filters.') : t('thinkingModels.noModelsYet')}
                    description={data.topModels.length > 0 ? '' : t('thinkingModels.noModelsYetDesc')}
                  />
                )}
              </div>
            </section>

            {/* Right: Detail Panel / Comparison View */}
            <section className="panel">
              {isComparing ? (
                /* ── Comparison View ── */
                <div className="comparison-view">
                  <div className="detail-header" style={{ marginBottom: SPACE[4] }}>
                    <button className="back-button" onClick={exitComparison} title={t('thinkingModels.exitCompare')}>
                      <X strokeWidth={1.75} size={18} />
                    </button>
                    <div>
                      <h3>{t('thinkingModels.comparisonTitle')}</h3>
                      <p style={{ fontSize: TEXT.lg, color: 'var(--text-secondary)' }}>
                        {selectedForCompare.length} {t('thinkingModels.compareSelected')}
                        {comparisonLoadingModels.size > 0 && (
                          <span style={{ marginLeft: SPACE[2], color: 'var(--info)' }}>
                            <Loader2 size={12} className="spin" /> {t('thinkingModels.loadingComparison')}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Comparison grid: side-by-side metrics */}
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${selectedForCompare.length}, 1fr)`, gap: SPACE[3], marginBottom: SPACE[4] }}>
                    {selectedForCompare.map(modelId => {
                      const summary = data.topModels.find(m => m.modelId === modelId);
                      const det = comparisonDetails.get(modelId);
                      const isLoading = comparisonLoadingModels.has(modelId);
                      if (!summary) return null;
                      return (
                        <div key={modelId} style={{ padding: SPACE[3], border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-sunken)', opacity: isLoading ? 0.6 : 1, position: 'relative' }}>
                          <strong style={{ fontSize: TEXT.xl, display: 'block', marginBottom: SPACE[2] }}>{summary.name}</strong>
                          {isLoading && (
                            <div style={{ position: 'absolute', top: SPACE[2], right: SPACE[2] }}>
                              <Loader2 size={14} className="spin" style={{ color: 'var(--info)' }} />
                            </div>
                          )}
                          <div className="pill-row" style={{ flexWrap: 'wrap', marginBottom: SPACE[2] }}>
                            <span className="badge">{t('thinkingModels.hits')}: {summary.hits}</span>
                            <span className="badge">{t('thinkingModels.successRate')}: {formatPercent(summary.successRate)}</span>
                            <span className="badge">{t('thinkingModels.failureRate')}: {formatPercent(summary.failureRate)}</span>
                            <span className="badge">{t('thinkingModels.pain')}: {formatPercent(summary.painRate)}</span>
                          </div>
                          {det && det.outcomeStats && (
                            <div style={{ fontSize: TEXT.sm, color: 'var(--text-secondary)', marginTop: SPACE[1] }}>
                              <div>{t('thinkingModels.correction')}: {formatPercent(det.outcomeStats.correctionRate)}</div>
                              <div>{t('thinkingModels.coverage')}: {formatPercent(det.modelMeta.coverageRate)}</div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Usage Trends for each model */}
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${selectedForCompare.length}, 1fr)`, gap: SPACE[3] }}>
                    {selectedForCompare.map(modelId => {
                      const summary = data.topModels.find(m => m.modelId === modelId);
                      const det = comparisonDetails.get(modelId);
                      if (!det || det.usageTrend.length < 2) return null;
                      return (
                        <article key={modelId} style={{ padding: SPACE[2], border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-sunken)' }}>
                          <h4 className="text-sm text-semibold" style={{ marginBottom: SPACE[2] }}>
                            {summary?.name} — {t('thinkingModels.usageTrend')}
                          </h4>
                          <LineChart
                            data={det.usageTrend.map(d => ({ label: d.day.slice(5), value: d.hits }))}
                            width="100%"
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
                  {isLoadingDetail && (
                    <div style={{ textAlign: 'center', padding: SPACE[6], color: 'var(--text-secondary)' }}>
                      <Loader2 size={24} className="spin" style={{ margin: `0 auto ${SPACE[2]}` }} />
                      <p style={{ fontSize: TEXT.lg }}>{t('thinkingModels.loadingDetail')}</p>
                    </div>
                  )}
                  {!isLoadingDetail && !detail && <EmptyState title={t('thinkingModels.emptyTitle')} description={t('thinkingModels.emptyDesc')} />}
                  {!isLoadingDetail && detail && (
                <div className="detail-stack">
                  <div className="detail-header">
<<<<<<< Updated upstream
                    <button className="back-button" onClick={() => { setDetail(null); setSelectedModel(''); setIsLoadingDetail(true); }} title={t('common.back')}>
                      <ChevronLeft strokeWidth={1.75} size={18} />
                    </button>
                    <div>
                      <h3>{detail.modelMeta.name}</h3>
                      <p style={{ fontSize: TEXT.lg, color: 'var(--text-secondary)' }}>{detail.modelMeta.description}</p>
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
                      <h4 className="text-base text-semibold">{t('thinkingModels.trigger')}</h4>
                      <code className="code-block code-block-trigger">
                        {detail.modelMeta.trigger}
                      </code>
                    </article>
                  )}

                  {/* Anti-Patterns */}
                  {detail.modelMeta.antiPattern && (
                    <article>
                      <h4 className="text-base text-semibold text-error">{t('thinkingModels.antiPattern')}</h4>
                      <code className="code-block code-block-antipattern">
                        {detail.modelMeta.antiPattern}
                      </code>
                    </article>
                  )}

                  {/* Usage Trend */}
                  {detail.usageTrend.length >= 1 ? (
                    <article>
                      <h4 className="text-lg text-semibold" style={{ marginBottom: SPACE[2] }}>
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
                    <h4 className="text-base text-semibold">{t('thinkingModels.outcomeStats')}</h4>
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
                      <h4 className="text-base text-semibold">{t('thinkingModels.scenarioDistribution')}</h4>
                      <div className="stack">
                        {detail.scenarioDistribution.map((item) => (
                          <div className="row-card" key={item.scenario}>
                            <strong className="text-base">{item.scenario}</strong>
                            <span>{item.hits}</span>
                          </div>
                        ))}
                      </div>
                    </article>
                  )}

                  {/* Recent Events */}
                  {detail.recentEvents.length > 0 && (
                    <article>
                      <h4 className="text-base text-semibold">{t('thinkingModels.recentEvents')}</h4>
                      <div className="stack">
                        {detail.recentEvents.map((event) => (
                          <div className="row-card vertical" key={event.id}>
                            <div>
                              <strong className="text-base">{formatDate(event.createdAt)}</strong>
                              <span className="text-sm">{event.scenarios.join(', ') || '—'}</span>
                            </div>
                            {event.toolContext?.length > 0 && (
                              <div className="event-context-tool" aria-label={t('thinkingModels.toolContext')}>
                                <Wrench size={12} aria-hidden /> {event.toolContext.map(tc => (
                                  `${tc.toolName} (${tc.outcome}${tc.errorType ? `: ${tc.errorType}` : ''})`
                                )).join(', ')}
                              </div>
                            )}
                            {event.painContext?.length > 0 && (
                              <div className="event-context-pain" aria-label={t('thinkingModels.painContext')}>
                                <Zap size={12} aria-hidden /> {event.painContext.map(pc => `${pc.source} (${pc.score})`).join(', ')}
                              </div>
                            )}
                            {event.principleContext?.length > 0 && (
                              <div className="event-context-principle" aria-label={t('thinkingModels.principleContext')}>
                                <ClipboardList size={12} aria-hidden /> {event.principleContext.map(pr => (
                                  `${pr.principleId ?? '—'} ${pr.eventType ? `(${pr.eventType})` : ''}`
                                )).join(', ')}
                              </div>
                            )}
                            {event.matchedPattern && (
                              <code className="matched-pattern">
                                /{event.matchedPattern}/
                              </code>
                            )}
                            <pre className="event-trigger-excerpt">
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: SPACE[2], padding: `${SPACE[2]} 0` }}>
                {data.dormantModels.map(model => (
                  <div
                    key={model.modelId}
                    style={{
                      padding: `${SPACE[2]} ${SPACE[3]}`,
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      background: 'var(--bg-sunken)',
                    }}
                  >
                    <strong style={{ fontSize: TEXT.lg }}>{model.name}</strong>
                    <p style={{ fontSize: TEXT.sm, color: 'var(--text-secondary)', margin: `${SPACE[1]} 0 0`, lineHeight: 1.3 }}>
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
                <table className="heatmap-table">
                  <thead>
                    <tr>
                      <th className="heatmap-header heatmap-sticky">
                        Model
                      </th>
                      {heatmapData.allScenarios.map(sc => (
                        <th key={sc} className="heatmap-header heatmap-scenario">
                          {sc}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {heatmapData.models.map(model => (
                      <tr key={model.modelId}>
                        <td className="heatmap-model heatmap-sticky">
                          {model.name}
                        </td>
                        {heatmapData.allScenarios.map(sc => {
                          const hits = heatmapData.hitMap.get(`${model.modelId}::${sc}`) ?? 0;
                          const intensity = hits / heatmapData.maxHits;
                          const bgColor = hits === 0
                            ? 'var(--bg-sunken)'
                            : `rgba(91, 139, 160, ${Math.max(0.15, intensity * 0.55).toFixed(2)})`;
                          return (
                            <td
                              key={sc}
                              className="heatmap-cell"
                              style={{ backgroundColor: bgColor }}
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
