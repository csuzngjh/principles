import React, { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import type {
  OverviewResponse,
  SampleDetailResponse,
  SamplesResponse,
  ThinkingModelDetailResponse,
  ThinkingOverviewResponse,
  EvolutionTasksResponse,
  EvolutionTraceResponse,
  EvolutionStatsResponse,
} from './types';

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDate(value: string | null): string {
  if (!value) return 'N/A';
  return new Date(value).toLocaleString();
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="eyebrow">Principles Console</span>
          <h1>P2</h1>
          <p>Plugin-owned control UI running inside OpenClaw Gateway.</p>
        </div>
        <nav className="nav">
          <NavLink to="/overview">Overview</NavLink>
          <NavLink to="/evolution">Evolution</NavLink>
          <NavLink to="/samples">Samples</NavLink>
          <NavLink to="/thinking-models">Thinking Models</NavLink>
        </nav>
        <a className="export-link" href={api.exportCorrections('redacted')}>
          Export Approved Corrections
        </a>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

function Loading() {
  return <div className="panel muted">Loading...</div>;
}

function ErrorState({ error }: { error: string }) {
  return <div className="panel error">{error}</div>;
}

function OverviewPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getOverview().then(setData).catch((err) => setError(String(err)));
  }, []);

  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Overview</span>
          <h2>Workspace health and queue pressure</h2>
        </div>
        <div className="meta">
          <div>Workspace: {data.workspaceDir}</div>
          <div>Freshness: {formatDate(data.dataFreshness)}</div>
        </div>
      </header>

      <section className="kpi-grid">
        <article className="panel"><span>Repeat Error Rate</span><strong>{formatPercent(data.summary.repeatErrorRate)}</strong></article>
        <article className="panel"><span>User Correction Rate</span><strong>{formatPercent(data.summary.userCorrectionRate)}</strong></article>
        <article className="panel"><span>Pending Samples</span><strong>{data.summary.pendingSamples}</strong></article>
        <article className="panel"><span>Approved Samples</span><strong>{data.summary.approvedSamples}</strong></article>
        <article className="panel"><span>Thinking Coverage</span><strong>{formatPercent(data.summary.thinkingCoverageRate)}</strong></article>
        <article className="panel"><span>Pain Events</span><strong>{data.summary.painEvents}</strong></article>
      </section>

      <div className="grid two-columns">
        <section className="panel">
          <h3>Recent Trend</h3>
          <div className="trend-list">
            {data.dailyTrend.map((item) => (
              <div className="trend-row" key={item.day}>
                <div>
                  <strong>{item.day}</strong>
                  <span>{item.toolCalls} calls / {item.failures} failures / {item.userCorrections} corrections</span>
                </div>
                <span className="badge">{item.thinkingTurns} thinking turns</span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <h3>Top Regressions</h3>
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
          <h3>Sample Queue</h3>
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
          <h3>Thinking Summary</h3>
          <div className="stack">
            <div className="row-card"><strong>Active Models</strong><span>{data.thinkingSummary.activeModels}</span></div>
            <div className="row-card"><strong>Dormant Models</strong><span>{data.thinkingSummary.dormantModels}</span></div>
            <div className="row-card"><strong>Effective Models</strong><span>{data.thinkingSummary.effectiveModels}</span></div>
            <div className="row-card"><strong>Coverage</strong><span>{formatPercent(data.thinkingSummary.coverageRate)}</span></div>
            <div className="row-card"><strong>Principle Events</strong><span>{data.summary.principleEventCount}</span></div>
          </div>
        </section>
      </div>
    </div>
  );
}

function SamplesPage() {
  const [status, setStatus] = useState('all');
  const [data, setData] = useState<SamplesResponse | null>(null);
  const [selected, setSelected] = useState<SampleDetailResponse | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');

  const search = useMemo(() => {
    const next = new URLSearchParams();
    next.set('status', status);
    next.set('page', '1');
    next.set('pageSize', '20');
    return next;
  }, [status]);

  useEffect(() => {
    api.listSamples(search).then((value) => {
      setData(value);
      setError('');
    }).catch((err) => setError(String(err)));
  }, [search]);

  useEffect(() => {
    if (!selectedId) return;
    api.getSampleDetail(selectedId).then(setSelected).catch((err) => setError(String(err)));
  }, [selectedId]);

  async function review(decision: 'approved' | 'rejected') {
    if (!selected) return;
    try {
      await api.reviewSample(selected.sampleId, decision);
      const [samples, detail] = await Promise.all([
        api.listSamples(search),
        api.getSampleDetail(selected.sampleId),
      ]);
      setData(samples);
      setSelected(detail);
    } catch (err) {
      console.error('[App] Review failed:', err);
      setError(err instanceof Error ? err.message : 'Review operation failed');
    }
  }

  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Samples</span>
          <h2>Review correction samples and export-ready training candidates</h2>
        </div>
        <div className="filters">
          <label>
            Status
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
        </div>
      </header>

      <div className="grid two-columns wide-right">
        <section className="panel">
          <div className="pill-row">
            {Object.entries(data.counters).map(([key, value]) => (
              <span className="badge" key={key}>{key}: {value}</span>
            ))}
          </div>
          <div className="list-table">
            {data.items.map((item) => (
              <button className={`table-row ${selectedId === item.sampleId ? 'active' : ''}`} key={item.sampleId} onClick={() => setSelectedId(item.sampleId)}>
                <div>
                  <strong>{item.sampleId}</strong>
                  <span>{item.failureMode}</span>
                </div>
                <div>
                  <span>{item.reviewStatus}</span>
                  <span>{item.relatedThinkingCount} thinking hits</span>
                </div>
                <div className="align-right">
                  <strong>{item.qualityScore}</strong>
                  <span>{formatDate(item.createdAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          {!selected && <div className="muted">Select a sample to inspect the bad attempt, correction, related thinking hits, and review history.</div>}
          {selected && (
            <div className="detail-stack">
              <div className="detail-header">
                <div>
                  <h3>{selected.sampleId}</h3>
                  <p>{selected.sessionId} | {selected.reviewStatus} | score {selected.qualityScore}</p>
                </div>
                <div className="button-row">
                  <button onClick={() => review('approved')}>Approve</button>
                  <button className="ghost" onClick={() => review('rejected')}>Reject</button>
                </div>
              </div>
              <article>
                <h4>Bad Attempt</h4>
                <pre>{selected.badAttempt.rawText || selected.badAttempt.sanitizedText}</pre>
              </article>
              <article>
                <h4>User Correction</h4>
                <pre>{selected.userCorrection.rawText}</pre>
              </article>
              <article>
                <h4>Recovery Tool Span</h4>
                <div className="pill-row">
                  {selected.recoveryToolSpan.map((item) => (
                    <span className="badge" key={item.id}>{item.toolName} #{item.id}</span>
                  ))}
                </div>
              </article>
              <article>
                <h4>Related Thinking Hits</h4>
                <div className="stack">
                  {selected.relatedThinkingHits.map((item) => (
                    <div className="row-card" key={item.id}>
                      <div>
                        <strong>{item.modelName}</strong>
                        <span>{item.scenarios.join(', ') || 'No scenarios'}</span>
                      </div>
                      <span className="badge">{formatDate(item.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </article>
              <article>
                <h4>Review History</h4>
                <div className="stack">
                  {selected.reviewHistory.map((item, index) => (
                    <div className="row-card" key={`${item.createdAt}-${index}`}>
                      <div>
                        <strong>{item.reviewStatus}</strong>
                        <span>{item.note || 'No note'}</span>
                      </div>
                      <span className="badge">{formatDate(item.createdAt)}</span>
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

function ThinkingModelsPage() {
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
          <span className="eyebrow">Thinking Models</span>
          <h2>Event-level usage, scenario coverage, and downstream outcomes</h2>
        </div>
        <div className="pill-row">
          <span className="badge">Coverage {formatPercent(data.summary.coverageRate)}</span>
          <span className="badge">Active {data.summary.activeModels}</span>
          <span className="badge">Dormant {data.summary.dormantModels}</span>
          <span className="badge">Effective {data.summary.effectiveModels}</span>
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
          {!detail && <div className="muted">Select a thinking model to inspect scenarios and recent events.</div>}
          {detail && (
            <div className="detail-stack">
              <div className="detail-header">
                <div>
                  <h3>{detail.modelMeta.name}</h3>
                  <p>{detail.modelMeta.description}</p>
                </div>
                <span className="badge">{detail.modelMeta.recommendation}</span>
              </div>
              <article>
                <h4>Outcome Stats</h4>
                <div className="pill-row">
                  <span className="badge">Success {formatPercent(detail.outcomeStats.successRate)}</span>
                  <span className="badge">Failure {formatPercent(detail.outcomeStats.failureRate)}</span>
                  <span className="badge">Pain {formatPercent(detail.outcomeStats.painRate)}</span>
                  <span className="badge">Correction {formatPercent(detail.outcomeStats.correctionRate)}</span>
                </div>
              </article>
              <article>
                <h4>Scenario Distribution</h4>
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
                <h4>Recent Events</h4>
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

function formatDuration(ms: number | null): string {
  if (ms === null) return 'N/A';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

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

function EvolutionPage() {
  const [tasks, setTasks] = useState<EvolutionTasksResponse | null>(null);
  const [stats, setStats] = useState<EvolutionStatsResponse | null>(null);
  const [trace, setTrace] = useState<EvolutionTraceResponse | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [error, setError] = useState('');

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
      api.getEvolutionStats(),
    ]).then(([tasksData, statsData]) => {
      setTasks(tasksData);
      setStats(statsData);
      setError('');
    }).catch((err) => setError(String(err)));
  }, [search]);

  useEffect(() => {
    if (!selectedId) {
      setTrace(null);
      return;
    }
    api.getEvolutionTrace(selectedId).then(setTrace).catch((err) => setError(String(err)));
  }, [selectedId]);

  if (error) return <ErrorState error={error} />;
  if (!tasks || !stats) return <Loading />;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Evolution</span>
          <h2>进化流程追踪 - 从痛点到原则生成</h2>
        </div>
        <div className="pill-row">
          <span className="badge" style={{ background: '#f59e0b' }}>待处理 {stats.pending}</span>
          <span className="badge" style={{ background: '#3b82f6' }}>处理中 {stats.inProgress}</span>
          <span className="badge" style={{ background: '#22c55e' }}>已完成 {stats.completed}</span>
          <span className="badge" style={{ background: '#ef4444' }}>失败 {stats.failed}</span>
        </div>
      </header>

      <div className="grid two-columns wide-right">
        <section className="panel">
          <div className="filters">
            <label>
              状态筛选
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">全部</option>
                <option value="pending">待处理</option>
                <option value="in_progress">处理中</option>
                <option value="completed">已完成</option>
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
                  <span className="badge" style={{ background: STAGE_COLORS[task.status] || '#6b7280' }}>
                    {task.status}
                  </span>
                  <span>分数: {task.score}</span>
                </div>
                <div className="align-right">
                  <strong>{formatDuration(task.duration)}</strong>
                  <span>{task.eventCount} 事件</span>
                </div>
              </button>
            ))}
          </div>

          <div className="pagination">
            共 {tasks.pagination.total} 条
          </div>
        </section>

        <section className="panel">
          {!selectedId && (
            <div className="muted">选择一个任务查看进化时间线详情</div>
          )}
          {trace && (
            <div className="detail-stack">
              <div className="detail-header">
                <div>
                  <h3>任务 {trace.task.taskId}</h3>
                  <p>来源: {trace.task.source} | 分数: {trace.task.score}</p>
                  <p style={{ fontSize: '0.85em', color: '#6b7280' }}>{trace.task.reason}</p>
                </div>
                <span className="badge" style={{ background: STAGE_COLORS[trace.task.status] || '#6b7280' }}>
                  {trace.task.status}
                </span>
              </div>

              <article>
                <h4>进化时间线</h4>
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
                  <h4>详细事件 ({trace.events.length})</h4>
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

export function App() {
  return (
    <BrowserRouter basename="/plugins/principles">
      <Shell>
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/evolution" element={<EvolutionPage />} />
          <Route path="/samples" element={<SamplesPage />} />
          <Route path="/thinking-models" element={<ThinkingModelsPage />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}
