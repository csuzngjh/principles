import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { api } from '../api';
import type {
  OverviewResponse,
  SampleDetailResponse,
  SamplesResponse,
  ThinkingModelDetailResponse,
  ThinkingOverviewResponse,
  EvolutionTasksResponse,
  EvolutionTraceResponse,
  EvolutionStatsResponse,
  OverviewHealthResponse,
  EvolutionPrinciplesResponse,
  FeedbackGfiResponse,
  GateStatsResponse,
  GateBlockItem,
  EmpathyEvent,
  FeedbackGateBlock,
} from '../types';
import { Sparkline, DonutChart, GroupedBarChart, TimeRangeSelector, CollapsiblePanel, StatusBadge, EmptyState } from '../charts';
import { useI18n } from '../i18n/ui';
import { formatPercent, formatDate, formatDuration } from '../utils/format';
import { Loading, ErrorState } from '../components';

const STAGE_COLORS: Record<string, string> = {
  pain_detected: '#ef4444',
  queued: '#f59e0b',
  started: '#3b82f6',
  analyzing: '#8b5cf6',
  principle_generated: '#22c55e',
  completed: '#22c55e',
};

const STAGE_LABELS: Record<string, string> = {
  pain_detected: '痛点检测',
  queued: '已入队',
  started: '开始处理',
  analyzing: '分析中',
  principle_generated: '原则生成',
  completed: '已完成',
};

export function EvolutionPage() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<EvolutionTasksResponse | null>(null);
  const [stats, setStats] = useState<EvolutionStatsResponse | null>(null);
  const [trace, setTrace] = useState<EvolutionTraceResponse | null>(null);
  const [evoPrinciples, setEvoPrinciples] = useState<EvolutionPrinciplesResponse | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [error, setError] = useState('');
  const [days, setDays] = useState(30);

  const search = useMemo(() => {
    const next = new URLSearchParams();
    if (statusFilter !== 'all') next.set('status', statusFilter);
    next.set('page', '1');
    next.set('pageSize', '20');
    return next;
  }, [statusFilter]);

  useEffect(() => {
    Promise.all([
      api.getEvolutionTasks(search),
      api.getEvolutionStats(days),
      api.getEvolutionPrinciples(),
    ]).then(([tasksData, statsData, principlesData]) => {
      setTasks(tasksData);
      setStats(statsData);
      setEvoPrinciples(principlesData);
      setError('');
    }).catch((err) => setError(String(err)));
  }, [search, days]);

  useEffect(() => {
    if (!selectedId) {
      setTrace(null);
      return;
    }
    api.getEvolutionTrace(selectedId).then(setTrace).catch((err) => setError(String(err)));
  }, [selectedId]);

  if (error) return <ErrorState error={error} />;
  if (!tasks || !stats) return <Loading />;

  // Prepare donut chart data
  const statusSegments = [
    { label: t('evolution.pending'), value: stats.pending, color: '#f59e0b' },
    { label: t('evolution.inProgress'), value: stats.inProgress, color: '#3b82f6' },
    { label: t('evolution.completed'), value: stats.completed, color: '#22c55e' },
    { label: t('evolution.failed'), value: stats.failed, color: '#ef4444' },
  ].filter(s => s.value > 0);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>{t('evolution.pageTitle')}</h2>
        </div>
        <div className="meta">
          <TimeRangeSelector value={days} onChange={setDays} />
          <div className="pill-row">
            <StatusBadge variant="warning">{t('evolution.pending')} {stats.pending}</StatusBadge>
            <StatusBadge variant="info">{t('evolution.inProgress')} {stats.inProgress}</StatusBadge>
            <StatusBadge variant="success">{t('evolution.completed')} {stats.completed}</StatusBadge>
            <StatusBadge variant="error">{t('evolution.failed')} {stats.failed}</StatusBadge>
          </div>
        </div>
      </header>

      {/* Current Stage Indicator */}
      {evoPrinciples && (
        <section className="panel" style={{ marginBottom: 'var(--space-5)' }}>
          <h3>当前阶段</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3) 0' }}>
            <span style={{
              padding: 'var(--space-2) var(--space-4)',
              borderRadius: 'var(--radius-lg)',
              fontSize: '15px',
              fontWeight: 600,
              background: 'var(--accent)',
              color: '#fff',
              border: '2px solid var(--accent)',
            }}>
              {evoPrinciples.activeStage === 'pending' ? <><Clock size={16} style={{marginRight: 6, verticalAlign: 'middle'}}/>{t('evolution.activeStage.pending')}</> :
               evoPrinciples.activeStage === 'in_progress' ? <><Activity size={16} style={{marginRight: 6, verticalAlign: 'middle'}}/>{t('evolution.activeStage.in_progress')}</> :
               evoPrinciples.activeStage === 'completed' ? <><Shield size={16} style={{marginRight: 6, verticalAlign: 'middle'}}/>{t('evolution.activeStage.completed')}</> :
               evoPrinciples.activeStage === 'idle' ? <><Zap size={16} style={{marginRight: 6, verticalAlign: 'middle'}}/>{t('evolution.activeStage.idle')}</> : evoPrinciples.activeStage}
            </span>
            <span style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
              {t('evolution.enhancementLoopStatus')}
            </span>
          </div>
        </section>
      )}

      {/* Principle Lifecycle & Nocturnal Training (Phase 5) */}
      {evoPrinciples && (
        <div className="grid two-columns" style={{ marginBottom: 'var(--space-5)' }}>
          <section className="panel">
            <h3><BookOpen size={16} style={{marginRight: 6, verticalAlign: 'middle'}}/>原则生命周期</h3>
            <div className="pill-row" style={{ marginBottom: 'var(--space-3)' }}>
              <StatusBadge variant="warning">候选: {evoPrinciples.principles.summary.candidate}</StatusBadge>
              <StatusBadge variant="info">试用: {evoPrinciples.principles.summary.probation}</StatusBadge>
              <StatusBadge variant="success">活跃: {evoPrinciples.principles.summary.active}</StatusBadge>
              <StatusBadge variant="error">废弃: {evoPrinciples.principles.summary.deprecated}</StatusBadge>
            </div>
            {evoPrinciples.principles.recent.length > 0 && (
              <div className="stack">
                {evoPrinciples.principles.recent.slice(0, 5).map((item, i) => (
                  <div className="row-card" key={`${item.principleId}-${i}`}>
                    <div>
                      <strong>{item.principleId}</strong>
                      <span>{item.fromStatus} → {item.toStatus}</span>
                    </div>
                    <span className="badge">{new Date(item.timestamp).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="panel">
            <h3>💤 夜间训练状态</h3>
            <div className="stack">
              <div className="row-card">
                <strong>训练队列</strong>
                <span>待: {evoPrinciples.nocturnalTraining.queue.pending} | 中: {evoPrinciples.nocturnalTraining.queue.inProgress} | 完: {evoPrinciples.nocturnalTraining.queue.completed}</span>
              </div>
              <div className="row-card">
                <strong>Arbiter 通过率</strong>
                <span>{(evoPrinciples.nocturnalTraining.arbiterPassRate * 100).toFixed(1)}%</span>
              </div>
              <div className="row-card">
                <strong>ORPO 样本数</strong>
                <span>{evoPrinciples.nocturnalTraining.orpoSampleCount}</span>
              </div>
              <div className="row-card">
                <strong>模型部署</strong>
                <span>{evoPrinciples.nocturnalTraining.deployments.length} 个</span>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* Status Distribution & Recent Activity */}
      <div className="grid two-columns" style={{ marginBottom: 'var(--space-5)' }}>
        <section className="panel">
          <h3>{t('evolution.statusDistribution')}</h3>
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-4) 0' }}>
            <DonutChart segments={statusSegments} size={100} strokeWidth={10} />
          </div>
        </section>
        <section className="panel">
          <h3>{t('evolution.recentActivity')}</h3>
          {stats.recentActivity && stats.recentActivity.length > 0 && (
            <>
              <div style={{ marginBottom: 'var(--space-3)' }}>
                <GroupedBarChart
                  data={stats.recentActivity.slice(-14).map((item) => ({
                    label: item.day.slice(5),
                    values: [item.created, item.completed],
                  }))}
                  colors={['var(--accent)', 'var(--success)']}
                  width={280}
                  height={60}
                />
                <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-4)', marginTop: 'var(--space-2)', fontSize: '11px', color: 'var(--text-tertiary)' }}>
                  <span><span style={{ display: 'inline-block', width: '10px', height: '10px', background: 'var(--accent)', borderRadius: '2px', marginRight: '4px' }}></span>{t('evolution.created')}</span>
                  <span><span style={{ display: 'inline-block', width: '10px', height: '10px', background: 'var(--success)', borderRadius: '2px', marginRight: '4px' }}></span>{t('evolution.finished')}</span>
                </div>
              </div>
              <div className="stack">
                {stats.recentActivity.slice(-7).reverse().map((item) => (
                  <div className="row-card" key={item.day}>
                    <strong>{item.day}</strong>
                    <span>+{item.created} {t('evolution.created')} {item.completed} {t('evolution.finished')}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {/* Stage Distribution */}
      {stats.stageDistribution && stats.stageDistribution.length > 0 && (
        <section className="panel" style={{ marginBottom: 'var(--space-5)' }}>
          <h3>{t('evolution.stageDistribution')}</h3>
          <div className="stack" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            {stats.stageDistribution.map((stage) => (
              <StatusBadge key={stage.stage} variant="neutral">
                {stage.stageLabel}: {stage.count}
              </StatusBadge>
            ))}
          </div>
        </section>
      )}

      <div className="grid two-columns wide-right">
        <section className="panel">
          <div className="filters">
            <label>
              {t('evolution.statusFilter')}
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">{t('evolution.filterAll')}</option>
                <option value="pending">{t('evolution.pending')}</option>
                <option value="in_progress">{t('evolution.inProgress')}</option>
                <option value="completed">{t('evolution.completed')}</option>
              </select>
            </label>
          </div>

          <div className="list-table">
            {tasks.items.map((task) => (
              <button
                className={`table-row ${selectedId === task.traceId ? 'active' : ''}`}
                key={task.taskId}
                onClick={() => setSelectedId(task.traceId)}
              >
                <div>
                  <strong style={{ color: STAGE_COLORS[task.status] || '#6b7280' }}>{task.taskId}</strong>
                  <span>{task.source}</span>
                </div>
                <div>
                  <StatusBadge variant="neutral">{task.status}</StatusBadge>
                  <span>{t('evolution.score')}: {task.score}</span>
                </div>
                <div className="align-right">
                  <strong>{formatDuration(task.duration)}</strong>
                  <span>{task.eventCount} {t('evolution.events')}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="pagination">
            {t('common.total')} {tasks.pagination.total} {t('common.items')}
          </div>
        </section>

        <section className="panel">
          {!selectedId && (
            <EmptyState title={t('evolution.emptyTitle')} description={t('evolution.emptyDesc')} />
          )}
          {trace && (
            <div className="detail-stack">
              <div className="detail-header">
                <button
                  className="back-button"
                  onClick={() => setSelectedId('')}
                  title={t('common.back') || 'Back'}
                >
                  <ChevronLeft strokeWidth={1.75} size={18} />
                </button>
                <div>
                  <h3>{t('evolution.taskLabel')} {trace.task.taskId}</h3>
                  <p>{t('evolution.source')}: {trace.task.source} | {t('evolution.score')}: {trace.task.score}</p>
                  <p style={{ fontSize: '0.85em', color: '#6b7280' }}>{trace.task.reason}</p>
                </div>
                <StatusBadge variant="neutral">{trace.task.status}</StatusBadge>
              </div>

              <article>
                <h4>{t('evolution.evolutionTimeline')}</h4>
                <div className="timeline">
                  {trace.timeline.map((item, index) => (
                    <div className="timeline-item" key={`${item.stage}-${index}`}>
                      <div
                        className="timeline-marker"
                        style={{ background: item.stageColor }}
                      />
                      <div className="timeline-content">
                        <div className="timeline-time">{formatDate(item.timestamp)}</div>
                        <div className="timeline-stage" style={{ color: item.stageColor }}>
                          {item.stageLabel}
                        </div>
                        <div className="timeline-summary">{item.summary || item.message}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </article>

              {trace.events.length > 0 && (
                <article>
                  <h4>{t('evolution.detailedEvents')} ({trace.events.length})</h4>
                  <div className="stack">
                    {trace.events.slice(0, 10).map((event) => (
                      <div className="row-card vertical" key={event.id}>
                        <div>
                          <strong style={{ color: event.stageColor }}>{event.stageLabel}</strong>
                          <span>{formatDate(event.createdAt)}</span>
                        </div>
                        <div style={{ fontSize: '0.9em', color: '#374151' }}>
                          {event.summary || event.message}
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ===== Phase 6: Feedback Loop Page =====
