import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { OverviewResponse, CentralHealthResponse, WorkspaceHealthEntry } from '../types';
import { Sparkline, GroupedBarChart, TimeRangeSelector, DonutChart, BulletChart, GaugeChart, PrincipleStack, QueueBar, StatusBadge } from '../charts';
import { useI18n } from '../i18n/ui';
import { formatPercent, formatDate } from '../utils/format';
import { WorkspaceConfig } from '../components/WorkspaceConfig';
import { Loading, ErrorState } from '../components';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

/**
 * WorkspaceHealthPanel - Full health dashboard for a single workspace
 * Uses real chart components (Bullet, Gauge, Stacked Bar, Donut) instead of text-only cards.
 */

function WorkspaceHealthPanel({ entry }: { entry: WorkspaceHealthEntry }) {
  const { t } = useI18n();
  const h = entry.health;
  const totalPrinciples = h.principles.candidate + h.principles.probation + h.principles.active + h.principles.deprecated;
  const totalQueue = h.queue.pending + h.queue.inProgress + h.queue.completed;

  const gfiStatus: 'success' | 'warning' | 'error' =
    h.gfi.current >= h.gfi.threshold ? 'error' : h.gfi.current >= h.gfi.threshold * 0.7 ? 'warning' : 'success';

  return (
    <section className="panel" style={{ marginBottom: 'var(--space-5)' }}>
      <div className="panel-header">
        <div className="panel-header-left">
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600 }}>{entry.workspaceName}</h3>
          <StatusBadge variant={h.painFlag.active ? 'warning' : 'success'}>
            {h.painFlag.active ? `${h.painFlag.source}` : 'Healthy'}
          </StatusBadge>
        </div>
      </div>
      <div className="panel-content">
        {/* Row 1: GFI (wide) | Trust Gauge | Evolution */}
        <div className="grid" style={{ gridTemplateColumns: '2fr 1fr 1fr', gap: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
          {/* GFI Bullet Chart */}
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('overview.health.gfi')}
            </div>
            <BulletChart
              value={h.gfi.current}
              target={h.gfi.threshold}
              peak={h.gfi.peakToday}
              max={Math.max(h.gfi.threshold * 2, 150)}
              width={280}
            />
            <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 4, fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              <span>当前: <strong style={{ color: `var(--${gfiStatus})` }}>{h.gfi.current}</strong></span>
              <span>阈值: {h.gfi.threshold}</span>
              <span>峰值: {h.gfi.peakToday}</span>
            </div>
          </div>

          {/* Trust Gauge */}
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('overview.health.trustStage')}
            </div>
            <GaugeChart
              value={h.trust.score}
              label={h.trust.stageLabel}
              sublabel={`${t('overview.health.stage')} ${h.trust.stage}`}
              size={90}
            />
          </div>

          {/* Evolution */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('overview.health.epTier')}
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent)' }}>{h.evolution.tier}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{h.evolution.points} pts</div>
          </div>
        </div>

        {/* Row 2: Principles | Queue | PainFlag */}
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-4)' }}>
          {/* Principles Distribution */}
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('overview.health.principlesTotal')}: {totalPrinciples}
            </div>
            <PrincipleStack
              candidate={h.principles.candidate}
              probation={h.principles.probation}
              active={h.principles.active}
              deprecated={h.principles.deprecated}
            />
          </div>

          {/* Queue Status */}
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('overview.health.queueBacklog')}: {h.queue.pending}
            </div>
            <QueueBar
              pending={h.queue.pending}
              inProgress={h.queue.inProgress}
              completed={h.queue.completed}
            />
          </div>

          {/* PainFlag Detail */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Pain Flag
            </div>
            {h.painFlag.active ? (
              <div style={{ padding: 'var(--space-2)', backgroundColor: 'rgba(184, 134, 11, 0.08)', borderRadius: 6, borderLeft: '3px solid var(--warning)' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--warning)' }}>⚠ Active</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                  Source: {h.painFlag.source ?? 'unknown'}
                </div>
                {h.painFlag.score !== null && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Score: {h.painFlag.score}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ padding: 'var(--space-2)', backgroundColor: 'rgba(74, 124, 111, 0.08)', borderRadius: 6, borderLeft: '3px solid var(--success)' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--success)' }}>✓ Normal</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                  {t('overview.health.noActivePain')}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function OverviewPage() {
  const { t } = useI18n();
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [centralHealth, setCentralHealth] = useState<CentralHealthResponse | null>(null);
  const [healthError, setHealthError] = useState('');
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [days, setDays] = useState(30);

  const loadCentralOverview = useCallback(async () => {
    try {
      const result = await api.getCentralOverview(days);
      setData(result);
      setError('');
    } catch (err) {
      setError(String(err));
    }
  }, [days]);

  const loadAll = useCallback(async () => {
    await loadCentralOverview();
    try {
      const health = await api.getCentralHealth();
      setCentralHealth(health);
      setHealthError('');
    } catch (err) {
      console.error('[OverviewPage] Failed to load central health:', err);
      setHealthError(String(err));
    }
  }, [loadCentralOverview]);

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh(loadAll, {
    intervalMs: 30000,
    enabled: !!data,
  });

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.syncCentral();
      await loadCentralOverview();
    } catch (err) {
      setError(String(err));
    } finally {
      setSyncing(false);
    }
  };

  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;

  const centralInfo = (data as OverviewResponse & { centralInfo?: { workspaceCount: number; enabledWorkspaceCount: number; workspaces: string[]; enabledWorkspaces: string[] } }).centralInfo;
  const dailyTrend = data.dailyTrend ?? [];

  // Prepare sparkline data
  const failuresTrend = dailyTrend.map(d => d.failures);
  const correctionsTrend = dailyTrend.map(d => d.userCorrections);
  const thinkingTrend = dailyTrend.map(d => d.thinkingTurns);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>{t('overview.pageTitle')}</h2>
        </div>
        <div className="meta">
          <TimeRangeSelector value={days} onChange={setDays} />
          {isRefreshing && <span className="refresh-indicator">⟳ {t('common.refreshing') || '刷新中...'}</span>}
          {centralInfo && (
            <div>{centralInfo.enabledWorkspaceCount} / {centralInfo.workspaceCount} {t('overview.workspacesEnabled')}</div>
          )}
          <div>{t('overview.freshness')}: {formatDate(data.dataFreshness)}</div>
          <button className="button-secondary" onClick={handleSync} disabled={syncing}>
            {syncing ? t('overview.syncing') : t('overview.syncAll')}
          </button>
        </div>
      </header>

      <WorkspaceConfig />

      {/* Per-Workspace Health Panels with Real Charts */}
      {centralHealth && centralHealth.workspaces.length > 0 ? (
        centralHealth.workspaces.map((entry) => (
          <WorkspaceHealthPanel key={entry.workspaceName} entry={entry} />
        ))
      ) : healthError ? (
        <section className="panel" style={{ marginBottom: 'var(--space-4)', borderColor: 'var(--error)' }}>
          <div style={{ textAlign: 'center', padding: 'var(--space-4)', color: 'var(--error)' }}>
            Failed to load health data: {healthError}
          </div>
        </section>
      ) : (
        <section className="panel" style={{ marginBottom: 'var(--space-4)' }}>
          <div style={{ textAlign: 'center', padding: 'var(--space-4)', color: 'var(--text-secondary)' }}>
            {t('overview.health.noWorkspaces') || 'No enabled workspaces found'}
          </div>
        </section>
      )}

      {/* Aggregate KPI Grid */}
      <section className="kpi-grid">
        <article className="panel kpi">
          <span className="label">{t('overview.repeatErrorRate')}</span>
          <span className="value">{formatPercent(data.summary.repeatErrorRate)}</span>
          {failuresTrend.length >= 2 && (
            <div className="stat-sparkline"><Sparkline data={failuresTrend} width={50} height={16} color="var(--error)" /></div>
          )}
        </article>
        <article className="panel kpi">
          <span className="label">{t('overview.userCorrectionRate')}</span>
          <span className="value">{formatPercent(data.summary.userCorrectionRate)}</span>
          {correctionsTrend.length >= 2 && (
            <div className="stat-sparkline"><Sparkline data={correctionsTrend} width={50} height={16} color="var(--warning)" /></div>
          )}
        </article>
        <article className="panel kpi">
          <span className="label">{t('overview.pendingSamples')}</span>
          <span className="value">{data.summary.pendingSamples}</span>
        </article>
        <article className="panel kpi">
          <span className="label">{t('overview.approvedSamples')}</span>
          <span className="value">{data.summary.approvedSamples}</span>
        </article>
        <article className="panel kpi">
          <span className="label">{t('overview.thinkingCoverage')}</span>
          <span className="value">{formatPercent(data.summary.thinkingCoverageRate)}</span>
          {thinkingTrend.length >= 2 && (
            <div className="stat-sparkline"><Sparkline data={thinkingTrend} width={50} height={16} color="var(--info)" /></div>
          )}
        </article>
        <article className="panel kpi">
          <span className="label">{t('overview.painEvents')}</span>
          <span className="value">{data.summary.painEvents}</span>
        </article>
      </section>

      <div className="grid two-columns">
        <section className="panel">
          <h3>{t('overview.recentTrend')}</h3>
          {dailyTrend.length > 0 && (
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <GroupedBarChart
                data={dailyTrend.slice(-14).map((item) => ({
                  label: item.day.slice(5),
                  values: [item.toolCalls, item.failures],
                }))}
                colors={['var(--accent)', 'var(--error)']}
                width={280}
                height={80}
              />
            </div>
          )}
          <div className="trend-list">
            {dailyTrend.slice(-7).reverse().map((item) => (
              <div className="trend-row" key={item.day}>
                <div>
                  <strong>{item.day}</strong>
                  <span>{item.toolCalls} {t('overview.calls')} / {item.failures} {t('overview.failures')} / {item.userCorrections} {t('overview.corrections')}</span>
                </div>
                <span className="badge">{item.thinkingTurns} {t('overview.thinkingTurns')}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <h3>{t('overview.topRegressions')}</h3>
          <div className="stack">
            {data.topRegressions.map((row) => (
              <div className="row-card" key={`${row.toolName}-${row.errorType}`}>
                <div>
                  <strong>{row.toolName}</strong>
                  <span>{row.errorType}</span>
                </div>
                <span className="badge">{row.occurrences}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid two-columns">
        <section className="panel">
          <h3>{t('overview.sampleQueue')}</h3>
          <div className="pill-row">
            {Object.entries(data.sampleQueue.counters).map(([status, count]) => (
              <span className="badge" key={status}>{status}: {count}</span>
            ))}
          </div>
          <div className="stack">
            {data.sampleQueue.preview.map((item) => (
              <div className="row-card" key={item.sampleId}>
                <div>
                  <strong>{item.sampleId}</strong>
                  <span>{item.sessionId}</span>
                </div>
                <span className="badge">{item.qualityScore}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <h3>{t('overview.thinkingSummary')}</h3>
          <div className="stack">
            <div className="row-card"><strong>{t('overview.activeModels')}</strong><span>{data.thinkingSummary.activeModels}</span></div>
            <div className="row-card"><strong>{t('overview.dormantModels')}</strong><span>{data.thinkingSummary.dormantModels}</span></div>
            <div className="row-card"><strong>{t('overview.effectiveModels')}</strong><span>{data.thinkingSummary.effectiveModels}</span></div>
            <div className="row-card"><strong>{t('overview.coverage')}</strong><span>{formatPercent(data.thinkingSummary.coverageRate)}</span></div>
            <div className="row-card"><strong>{t('overview.principleEvents')}</strong><span>{data.summary.principleEventCount}</span></div>
          </div>
        </section>
      </div>
    </div>
  );
}
