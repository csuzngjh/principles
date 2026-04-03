import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { OverviewResponse, OverviewHealthResponse } from '../types';
import { Sparkline, GroupedBarChart, TimeRangeSelector, StatusBadge } from '../charts';
import { useI18n } from '../i18n/ui';
import { formatPercent, formatDate } from '../utils/format';
import { WorkspaceConfig } from '../components/WorkspaceConfig';
import { Loading, ErrorState } from '../components';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

export function OverviewPage() {
  const { t } = useI18n();
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [health, setHealth] = useState<OverviewHealthResponse | null>(null);
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
    api.getOverviewHealth().then(setHealth).catch(() => {});
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
  const toolCallsTrend = dailyTrend.map(d => d.toolCalls);
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

      {/* System Health Cards (Phase 5) */}
      {health && (
        <section className="kpi-grid" style={{ marginBottom: 'var(--space-5)' }}>
          <article className="panel kpi" style={{ borderLeft: `3px solid ${health.gfi.current >= health.gfi.threshold ? 'var(--error)' : 'var(--success)'}` }}>
            <span className="label"><svg width="10" height="10" viewBox="0 0 10 10" style={{marginRight: '6px', verticalAlign: 'middle'}}><circle cx="5" cy="5" r="5" fill={health.gfi.current >= health.gfi.threshold ? 'var(--error)' : 'var(--success)'}/></svg>{t('overview.health.gfi')}</span>
            <span className="value">{health.gfi.current}</span>
            <span>{t('overview.health.threshold')}: {health.gfi.threshold} | {t('overview.health.peakToday')}: {health.gfi.peakToday}</span>
          </article>
          <article className="panel kpi" style={{ borderLeft: `3px solid ${health.painFlag.active ? 'var(--warning)' : 'var(--success)'}` }}>
            <span className="label"><svg width="10" height="10" viewBox="0 0 10 10" style={{marginRight: '6px', verticalAlign: 'middle'}}><circle cx="5" cy="5" r="5" fill={health.painFlag.active ? 'var(--warning)' : 'var(--success)'}/></svg>{t('overview.health.painFlag')}</span>
            <span className="value">{health.painFlag.active ? t('overview.health.active') : t('overview.health.normal')}</span>
            <span>{health.painFlag.source ? `${t('overview.health.source')}: ${health.painFlag.source}` : t('overview.health.noActivePain')}</span>
          </article>
          <article className="panel kpi" style={{ borderLeft: '3px solid var(--info)' }}>
            <span className="label"><svg width="10" height="10" viewBox="0 0 10 10" style={{marginRight: '6px', verticalAlign: 'middle'}}><circle cx="5" cy="5" r="5" fill="var(--info)"/></svg>{t('overview.health.trustStage')}</span>
            <span className="value">{health.trust.stageLabel}</span>
            <span>{t('overview.health.stage')} {health.trust.stage} | {t('overview.health.score')}: {health.trust.score}</span>
          </article>
          <article className="panel kpi" style={{ borderLeft: '3px solid var(--accent)' }}>
            <span className="label"><svg width="10" height="10" viewBox="0 0 10 10" style={{marginRight: '6px', verticalAlign: 'middle'}}><circle cx="5" cy="5" r="5" fill="var(--accent)"/></svg>{t('overview.health.epTier')}</span>
            <span className="value">{health.evolution.tier}</span>
            <span>{t('overview.health.points')}: {health.evolution.points}</span>
          </article>
          <article className="panel kpi" style={{ borderLeft: '3px solid var(--success)' }}>
            <span className="label"><svg width="10" height="10" viewBox="0 0 10 10" style={{marginRight: '6px', verticalAlign: 'middle'}}><circle cx="5" cy="5" r="5" fill="var(--success)"/></svg>{t('overview.health.principlesTotal')}</span>
            <span className="value">{health.principles.candidate + health.principles.probation + health.principles.active + health.principles.deprecated}</span>
            <span>{t('overview.health.candidate')}: {health.principles.candidate} | {t('overview.health.probation')}: {health.principles.probation} | {t('overview.health.active2')}: {health.principles.active} | {t('overview.health.deprecated')}: {health.principles.deprecated}</span>
          </article>
          <article className="panel kpi" style={{ borderLeft: `3px solid ${health.queue.pending > 5 ? 'var(--warning)' : 'var(--success)'}` }}>
            <span className="label"><svg width="10" height="10" viewBox="0 0 10 10" style={{marginRight: '6px', verticalAlign: 'middle'}}><circle cx="5" cy="5" r="5" fill={health.queue.pending > 5 ? 'var(--warning)' : 'var(--success)'}/></svg>{t('overview.health.queueBacklog')}</span>
            <span className="value">{health.queue.pending}</span>
            <span>{t('overview.health.pending')}: {health.queue.pending} | {t('overview.health.inProgress')}: {health.queue.inProgress} | {t('overview.health.completed')}: {health.queue.completed}</span>
          </article>
        </section>
      )}

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

