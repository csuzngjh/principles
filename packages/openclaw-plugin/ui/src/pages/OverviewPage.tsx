import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { OverviewResponse, CentralHealthResponse, WorkspaceHealthEntry } from '../types';
import { Sparkline, GroupedBarChart, TimeRangeSelector, DonutChart, BulletChart, GaugeChart, PrincipleStack, QueueBar, StatusBadge, LineChart } from '../charts';
import { useI18n } from '../i18n/ui';
import { formatPercent, formatDate } from '../utils/format';
import { WorkspaceConfig } from '../components/WorkspaceConfig';
import { Loading, ErrorState } from '../components';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

// ---------------------------------------------------------------------------
// Tooltip component for metric explanations
// ---------------------------------------------------------------------------

function MetricTooltip({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={() => setOpen(!open)}
    >
      {children}
      {open && (
        <span
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 10px',
            fontSize: '0.75rem',
            color: 'var(--text-secondary)',
            whiteSpace: 'normal',
            maxWidth: 260,
            zIndex: 100,
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}
        >
          {children}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helper: get health status
// ---------------------------------------------------------------------------

function getHealthStatus(current: number, threshold: number): 'excellent' | 'good' | 'warning' | 'danger' {
  if (current === 0) return 'excellent';
  if (current < threshold * 0.5) return 'good';
  if (current < threshold) return 'warning';
  return 'danger';
}

const HEALTH_LABELS: Record<string, { zh: string; en: string; emoji: string }> = {
  excellent: { zh: '优秀', en: 'Excellent', emoji: '🟢' },
  good: { zh: '良好', en: 'Good', emoji: '🟡' },
  warning: { zh: '警告', en: 'Warning', emoji: '🟠' },
  danger: { zh: '危险', en: 'Critical', emoji: '🔴' },
};

const TRUST_DESC_KEYS = ['observer', 'editor', 'developer', 'architect'];
const TIER_DESC_KEYS = ['seed', 'sprout', 'sapling', 'tree', 'forest'];

// ---------------------------------------------------------------------------
// WorkspaceHealthPanel — redesigned for clarity
// ---------------------------------------------------------------------------

function WorkspaceHealthPanel({ entry }: { entry: WorkspaceHealthEntry }) {
  const { t } = useI18n();
  const h = entry.health;
  const totalPrinciples = h.principles.candidate + h.principles.probation + h.principles.active + h.principles.deprecated;
  const status = getHealthStatus(h.gfi.current, h.gfi.threshold);
  const statusLabel = HEALTH_LABELS[status];
  const trustIdx = Math.max(0, Math.min(3, h.trust.stage - 1));
  const trustDescKey = TRUST_DESC_KEYS[trustIdx] ?? 'observer';
  const tierIdx = Math.max(0, Math.min(4, parseInt(h.evolution.tier.replace(/\D/g, ''), 10) - 1));
  const tierDescKey = TIER_DESC_KEYS[tierIdx] ?? 'seed';

  return (
    <section className="panel" style={{ marginBottom: 'var(--space-5)' }}>
      <div className="panel-header">
        <div className="panel-header-left">
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600 }}>{entry.workspaceName}</h3>
          <StatusBadge variant={h.painFlag.active ? 'warning' : 'success'}>
            {h.painFlag.active ? `${t('overview.health.source')}: ${h.painFlag.source}` : t('overview.health.normal')}
          </StatusBadge>
        </div>
      </div>
      <div className="panel-content">

        {/* Row 1: Health Status (wide) | Trust | Evolution */}
        <div className="grid" style={{ gridTemplateColumns: '2fr 1fr 1fr', gap: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>

          {/* 今日健康度 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('overview.health.gfi')}
              </span>
              <StatusBadge variant={status === 'danger' ? 'error' : status === 'warning' ? 'warning' : 'success'}>
                {statusLabel.emoji} {statusLabel.zh}
              </StatusBadge>
            </div>
            {/* Big number */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
              <span style={{ fontSize: '2.5rem', fontWeight: 700, color: `var(--${status === 'danger' ? 'error' : status === 'warning' ? 'warning' : 'success'})`, lineHeight: 1 }}>
                {h.gfi.current}
              </span>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                / {h.gfi.threshold} {t('overview.health.threshold')}
              </span>
            </div>
            {/* Bullet Chart */}
            <BulletChart
              value={h.gfi.current}
              target={h.gfi.threshold}
              peak={h.gfi.peakToday}
              max={Math.max(h.gfi.threshold * 2, 150)}
              width={280}
            />
            {/* Mini sparkline for quick glance */}
            {h.gfi.trend.length >= 2 && (
              <div style={{ marginTop: 4 }}>
                <Sparkline
                  data={h.gfi.trend.map(d => d.value)}
                  width={280}
                  height={20}
                  color={status === 'danger' ? 'var(--error)' : status === 'warning' ? 'var(--warning)' : 'var(--success)'}
                  fillOpacity={0.1}
                />
              </div>
            )}
          </div>

          {/* 权限等级 */}
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('overview.health.trustStage')}
            </div>
            <GaugeChart
              value={h.trust.score}
              label={h.trust.stageLabel}
              sublabel={t(`overview.health.trustDesc.${trustDescKey}`)}
              size={90}
              segments={[
                { label: 'Observer', color: 'var(--text-secondary)', max: 30 },
                { label: 'Editor', color: 'var(--info)', max: 60 },
                { label: 'Developer', color: 'var(--accent)', max: 80 },
                { label: 'Architect', color: 'var(--success)', max: 100 },
              ]}
            />
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 4 }}>
              {t('overview.health.stage')} {h.trust.stage} · {t('overview.health.score')} {h.trust.score}
            </div>
          </div>

          {/* 进化等级 */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('overview.health.epTier')}
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent)' }}>{h.evolution.tier}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              {h.evolution.points} {t('overview.health.points')}
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: 4, textAlign: 'center', maxWidth: 100 }}>
              {t(`overview.health.tierDesc.${tierDescKey}`)}
            </div>
          </div>
        </div>

        {/* Row 2: Principles | Queue | PainFlag */}
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-4)' }}>

          {/* 原则分布 */}
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

          {/* 任务队列 */}
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

          {/* 问题检测 */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('overview.health.painFlag')}
            </div>
            {h.painFlag.active ? (
              <div style={{ padding: 'var(--space-2)', backgroundColor: 'rgba(184, 134, 11, 0.08)', borderRadius: 6, borderLeft: '3px solid var(--warning)' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--warning)' }}>⚠ {t('overview.health.active')}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                  {t('overview.health.source')}: {h.painFlag.source}
                </div>
                {h.painFlag.score !== null && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {t('overview.health.score')}: {h.painFlag.score}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ padding: 'var(--space-2)', backgroundColor: 'rgba(74, 124, 111, 0.08)', borderRadius: 6, borderLeft: '3px solid var(--success)' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--success)' }}>✓ {t('overview.health.normal')}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                  {t('overview.health.noActivePain')}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Full-width GFI trend chart */}
        <section style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-4)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              📈 {t('overview.health.gfi')} · 今日趋势
            </span>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              今日峰值: {h.gfi.peakToday}
            </span>
          </div>
          {h.gfi.trend.length >= 2 ? (
            <LineChart
              data={h.gfi.trend.map(d => ({
                label: d.hour.slice(11, 16),
                value: d.value,
              }))}
              width={560}
              height={160}
              color={status === 'danger' ? 'var(--error)' : status === 'warning' ? 'var(--warning)' : 'var(--success)'}
            />
          ) : (
            <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              今日暂无 GFI 记录
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// KPI Card with explanation
// ---------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  value: string | number;
  explain: { zh: string; en: string };
  trend?: number[];
  trendColor?: string;
}

function ExplainKpiCard({ label, value, explain, trend, trendColor }: KpiCardProps) {
  const { t } = useI18n();
  const [showExplain, setShowExplain] = useState(false);

  return (
    <article className="panel kpi" style={{ position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              className="label"
              onClick={() => setShowExplain(!showExplain)}
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              {label}
            </span>
            <button
              onClick={() => setShowExplain(!showExplain)}
              style={{
                background: 'none',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                width: 22,
                height: 22,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.75rem',
                lineHeight: 1,
                padding: 0,
                flexShrink: 0,
              }}
              title="查看说明"
            >
              ?
            </button>
          </div>
          <span className="value">{value}</span>
        </div>
        {trend && trend.length >= 2 && (
          <div className="stat-sparkline" style={{ flexShrink: 0, alignSelf: 'center' }}>
            <Sparkline data={trend} width={50} height={16} color={trendColor} />
          </div>
        )}
      </div>
      {showExplain && (
        <div
          style={{
            marginTop: 6,
            padding: '8px 10px',
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.78rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.5,
          }}
        >
          💡 {t(explain.zh) || explain.zh}
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// OverviewPage
// ---------------------------------------------------------------------------

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

      {/* Per-Workspace Health Panels */}
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

      {/* Aggregate KPI Grid with explanations */}
      <section className="kpi-grid">
        <ExplainKpiCard
          label={t('overview.repeatErrorRate')}
          value={formatPercent(data.summary.repeatErrorRate)}
          explain={{ zh: 'AI 重复犯同样错误的比例。如果这个值高，说明 AI 没有从之前的错误中学习。', en: 'Percentage of times AI repeats the same mistake.' }}
          trend={failuresTrend}
          trendColor="var(--error)"
        />
        <ExplainKpiCard
          label={t('overview.userCorrectionRate')}
          value={formatPercent(data.summary.userCorrectionRate)}
          explain={{ zh: '用户手动纠正 AI 操作的比例。如果这个值高，说明 AI 经常做错了需要你介入。', en: 'How often you had to manually correct AI actions.' }}
          trend={correctionsTrend}
          trendColor="var(--warning)"
        />
        <ExplainKpiCard
          label={t('overview.pendingSamples')}
          value={data.summary.pendingSamples}
          explain={{ zh: '等待你审核的纠正样本。审核后 AI 会从中学习。', en: 'Correction samples waiting for your review. Reviewing them helps AI learn.' }}
        />
        <ExplainKpiCard
          label={t('overview.approvedSamples')}
          value={data.summary.approvedSamples}
          explain={{ zh: '你已批准的高质量纠正样本。这些是 AI 的学习素材。', en: 'High-quality corrections you approved. These become AI training data.' }}
        />
        <ExplainKpiCard
          label={t('overview.thinkingCoverage')}
          value={formatPercent(data.summary.thinkingCoverageRate)}
          explain={{ zh: 'AI 使用"深度思考"模式的任务比例。这个值太低可能说明 AI 在跳过思考直接执行。', en: 'Percentage of tasks where AI used deep thinking mode instead of acting immediately.' }}
          trend={thinkingTrend}
          trendColor="var(--info)"
        />
        <ExplainKpiCard
          label={t('overview.painEvents')}
          value={data.summary.painEvents}
          explain={{ zh: '系统检测到的"痛苦信号"总数。包括工具失败、用户抱怨、AI 行为异常等。', en: 'Total pain signals detected: tool failures, user complaints, AI anomalies.' }}
        />
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
