import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import {
  BarChart3,
  GitBranch,
  FileCheck,
  Brain,
  Download,
  LogOut,
  Hexagon,
} from 'lucide-react';
import { api, getGatewayToken, setGatewayToken, clearGatewayToken } from './api';
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
import { Sparkline, DonutChart, GroupedBarChart, TimeRangeSelector, CollapsiblePanel, StatusBadge, EmptyState } from './charts';

// Auth Context
interface AuthContextType {
  isAuthenticated: boolean;
  token: string | null;
  login: (token: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getGatewayToken());
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    // Check if token is valid
    const checkAuth = async () => {
      const savedToken = getGatewayToken();
      if (savedToken) {
        try {
          // Try to fetch overview to validate token
          await api.getOverview();
          setIsAuthenticated(true);
        } catch {
          setIsAuthenticated(false);
        }
      }
      setIsChecking(false);
    };
    checkAuth();
  }, []);

  const login = useCallback(async (newToken: string): Promise<boolean> => {
    setGatewayToken(newToken);
    setTokenState(newToken);
    try {
      await api.getOverview();
      setIsAuthenticated(true);
      return true;
    } catch {
      clearGatewayToken();
      setTokenState(null);
      setIsAuthenticated(false);
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    clearGatewayToken();
    setTokenState(null);
    setIsAuthenticated(false);
  }, []);

  if (isChecking) {
    return (
      <div className="auth-checking">
        <div className="auth-checking-content">
          <div className="spinner"></div>
          <span>正在验证身份...</span>
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// Login Page
function LoginPage() {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('请输入 Gateway Token');
      return;
    }
    setLoading(true);
    setError('');
    const success = await login(token.trim());
    setLoading(false);
    if (success) {
      navigate('/overview');
    } else {
      setError('Token 无效或已过期，请检查后重试');
    }
  };

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-header">
          <div className="login-logo">
            <span className="logo-icon">
              <Hexagon strokeWidth={1.5} />
            </span>
            <h1>Principles Console</h1>
          </div>
          <p className="login-subtitle">AI Agent 进化流程监控平台</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="token">Gateway Token</label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="请输入您的 Gateway Token"
              autoComplete="off"
            />
            <span className="form-hint">
              在服务器上运行 <code>openclaw config get gateway.auth.token</code> 获取 Token
            </span>
          </div>

          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="login-button" disabled={loading}>
            {loading ? (
              <>
                <span className="spinner-small"></span>
                正在验证...
              </>
            ) : (
              '登 录'
            )}
          </button>
        </form>

        <div className="login-footer">
          <h4>如何获取 Token？</h4>
          <ol>
            <li>SSH 登录到运行 OpenClaw Gateway 的服务器</li>
            <li>运行命令查看配置：<code>cat ~/.openclaw/openclaw.json</code></li>
            <li>复制 <code>gateway.auth.token</code> 的值</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

// Protected Route
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDate(value: string | null): string {
  if (!value) return 'N/A';
  return new Date(value).toLocaleString();
}

function Shell({ children }: { children: React.ReactNode }) {
  const { logout, token } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <span className="logo-icon">
              <Hexagon strokeWidth={1.5} />
            </span>
          </div>
          <span className="eyebrow">Principles Console</span>
          <h1>进化控制台</h1>
          <p>AI Agent 自主进化监控平台</p>
        </div>
        <nav className="nav">
          <NavLink to="/overview" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <BarChart3 strokeWidth={1.75} />
            </span>
            <span>概览</span>
          </NavLink>
          <NavLink to="/evolution" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <GitBranch strokeWidth={1.75} />
            </span>
            <span>进化追踪</span>
          </NavLink>
          <NavLink to="/samples" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <FileCheck strokeWidth={1.75} />
            </span>
            <span>样本审核</span>
          </NavLink>
          <NavLink to="/thinking-models" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <Brain strokeWidth={1.75} />
            </span>
            <span>思维模型</span>
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <a className="export-link" href={api.exportCorrections('redacted')}>
            <span className="nav-icon">
              <Download strokeWidth={1.75} />
            </span>
            <span>导出样本</span>
          </a>
          <button className="logout-button" onClick={logout}>
            <span className="nav-icon">
              <LogOut strokeWidth={1.75} />
            </span>
            <span>退出登录</span>
          </button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

function Loading() {
  return (
    <div className="loading-state">
      <div className="spinner"></div>
      <span>加载中...</span>
    </div>
  );
}

function ErrorState({ error }: { error: string }) {
  return <div className="panel error">{error}</div>;
}

function WorkspaceConfig() {
  const [wsData, setWsData] = useState<{
    configs: Array<{ workspaceName: string; enabled: boolean; displayName: string | null; syncEnabled: boolean }>;
    workspaces: Array<{ name: string; path: string; lastSync: string | null; config: null | { workspaceName: string; enabled: boolean; displayName: string | null; syncEnabled: boolean } }>;
  } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const [newWsPath, setNewWsPath] = useState('');
  const [adding, setAdding] = useState(false);

  const loadConfigs = useCallback(async () => {
    try {
      const result = await api.getWorkspaceConfigs();
      setWsData(result);
      setError('');
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  const handleToggle = async (workspaceName: string, field: 'enabled' | 'syncEnabled', currentValue: boolean) => {
    setSaving(workspaceName);
    try {
      await api.updateWorkspaceConfig(workspaceName, { [field]: !currentValue });
      await loadConfigs();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(null);
    }
  };

  const handleAddWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWsName.trim() || !newWsPath.trim()) return;
    setAdding(true);
    setError('');
    try {
      await api.addCustomWorkspace(newWsName.trim(), newWsPath.trim());
      setNewWsName('');
      setNewWsPath('');
      setShowAddForm(false);
      await loadConfigs();
    } catch (err) {
      setError(String(err));
    } finally {
      setAdding(false);
    }
  };

  if (error) return <div className="panel error">{error}</div>;
  if (!wsData) return <div className="panel muted">Loading workspaces...</div>;

  return (
    <CollapsiblePanel
      title="Workspace Configuration"
      badge={<span className="badge">{(wsData.configs ?? []).filter(c => c.enabled && c.syncEnabled).length} / {wsData.workspaces?.length ?? 0} enabled</span>}
      defaultCollapsed={true}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-4)' }}>
        <button className="button-secondary" onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? '取消' : '+ 添加'}
        </button>
      </div>

      {showAddForm && (
        <form className="add-workspace-form" onSubmit={handleAddWorkspace} style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-3)', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', color: 'var(--text-secondary)' }}>Workspace Name</label>
              <input
                type="text"
                value={newWsName}
                onChange={(e) => setNewWsName(e.target.value)}
                placeholder="workspace-custom"
                style={{ width: '100%', padding: 'var(--space-2)', fontSize: '13px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
              />
            </div>
            <div style={{ flex: 2 }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', color: 'var(--text-secondary)' }}>Path</label>
              <input
                type="text"
                value={newWsPath}
                onChange={(e) => setNewWsPath(e.target.value)}
                placeholder="/home/user/.openclaw/workspace-custom"
                style={{ width: '100%', padding: 'var(--space-2)', fontSize: '13px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
              />
            </div>
            <button type="submit" className="button-primary" disabled={adding || !newWsName.trim() || !newWsPath.trim()}>
              {adding ? '添加中...' : '添加'}
            </button>
          </div>
        </form>
      )}

      <div className="stack">
        {(wsData.workspaces ?? []).map((ws) => {
          const config = ws.config ?? { workspaceName: ws.name, enabled: true, displayName: ws.name, syncEnabled: true };
          const isSaving = saving === ws.name;
          return (
            <div className="row-card" key={ws.name}>
              <div>
                <strong>{ws.name}</strong>
                <span>{ws.path}</span>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={config.enabled}
                    onChange={() => handleToggle(ws.name, 'enabled', config.enabled)}
                    disabled={isSaving}
                  />
                  <span style={{ fontSize: '13px' }}>Include</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={config.syncEnabled}
                    onChange={() => handleToggle(ws.name, 'syncEnabled', config.syncEnabled)}
                    disabled={isSaving || !config.enabled}
                  />
                  <span style={{ fontSize: '13px' }}>Sync</span>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </CollapsiblePanel>
  );
}

function OverviewPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
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

  useEffect(() => {
    loadCentralOverview();
  }, [loadCentralOverview]);

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
          <span className="eyebrow">Overview</span>
          <h2>Workspace health and queue pressure</h2>
        </div>
        <div className="meta">
          <TimeRangeSelector value={days} onChange={setDays} />
          {centralInfo && (
            <div>{centralInfo.enabledWorkspaceCount} / {centralInfo.workspaceCount} workspaces enabled</div>
          )}
          <div>Freshness: {formatDate(data.dataFreshness)}</div>
          <button className="button-secondary" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync All'}
          </button>
        </div>
      </header>

      <WorkspaceConfig />

      <section className="kpi-grid">
        <article className="panel kpi">
          <span className="label">Repeat Error Rate</span>
          <span className="value">{formatPercent(data.summary.repeatErrorRate)}</span>
          {failuresTrend.length >= 2 && (
            <div className="stat-sparkline"><Sparkline data={failuresTrend} width={50} height={16} color="var(--error)" /></div>
          )}
        </article>
        <article className="panel kpi">
          <span className="label">User Correction Rate</span>
          <span className="value">{formatPercent(data.summary.userCorrectionRate)}</span>
          {correctionsTrend.length >= 2 && (
            <div className="stat-sparkline"><Sparkline data={correctionsTrend} width={50} height={16} color="var(--warning)" /></div>
          )}
        </article>
        <article className="panel kpi">
          <span className="label">Pending Samples</span>
          <span className="value">{data.summary.pendingSamples}</span>
        </article>
        <article className="panel kpi">
          <span className="label">Approved Samples</span>
          <span className="value">{data.summary.approvedSamples}</span>
        </article>
        <article className="panel kpi">
          <span className="label">Thinking Coverage</span>
          <span className="value">{formatPercent(data.summary.thinkingCoverageRate)}</span>
          {thinkingTrend.length >= 2 && (
            <div className="stat-sparkline"><Sparkline data={thinkingTrend} width={50} height={16} color="var(--info)" /></div>
          )}
        </article>
        <article className="panel kpi">
          <span className="label">Pain Events</span>
          <span className="value">{data.summary.painEvents}</span>
        </article>
      </section>

      <div className="grid two-columns">
        <section className="panel">
          <h3>Recent Trend</h3>
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
                  <button className="button-primary" onClick={() => review('approved')}>Approve</button>
                  <button className="button-ghost" onClick={() => review('rejected')}>Reject</button>
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
    ]).then(([tasksData, statsData]) => {
      setTasks(tasksData);
      setStats(statsData);
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
    { label: '待处理', value: stats.pending, color: '#f59e0b' },
    { label: '处理中', value: stats.inProgress, color: '#3b82f6' },
    { label: '已完成', value: stats.completed, color: '#22c55e' },
    { label: '失败', value: stats.failed, color: '#ef4444' },
  ].filter(s => s.value > 0);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Evolution</span>
          <h2>进化流程追踪 - 从痛点到原则生成</h2>
        </div>
        <div className="meta">
          <TimeRangeSelector value={days} onChange={setDays} />
          <div className="pill-row">
            <StatusBadge variant="warning">待处理 {stats.pending}</StatusBadge>
            <StatusBadge variant="info">处理中 {stats.inProgress}</StatusBadge>
            <StatusBadge variant="success">已完成 {stats.completed}</StatusBadge>
            <StatusBadge variant="error">失败 {stats.failed}</StatusBadge>
          </div>
        </div>
      </header>

      {/* Status Distribution & Recent Activity */}
      <div className="grid two-columns" style={{ marginBottom: 'var(--space-5)' }}>
        <section className="panel">
          <h3>状态分布</h3>
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-4) 0' }}>
            <DonutChart segments={statusSegments} size={100} strokeWidth={10} />
          </div>
        </section>
        <section className="panel">
          <h3>近期活动</h3>
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
                  <span><span style={{ display: 'inline-block', width: '10px', height: '10px', background: 'var(--accent)', borderRadius: '2px', marginRight: '4px' }}></span>新增</span>
                  <span><span style={{ display: 'inline-block', width: '10px', height: '10px', background: 'var(--success)', borderRadius: '2px', marginRight: '4px' }}></span>完成</span>
                </div>
              </div>
              <div className="stack">
                {stats.recentActivity.slice(-7).reverse().map((item) => (
                  <div className="row-card" key={item.day}>
                    <strong>{item.day}</strong>
                    <span>+{item.created} 完成 {item.completed}</span>
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
          <h3>阶段分布</h3>
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
                  <StatusBadge variant="neutral">{task.status}</StatusBadge>
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
                <StatusBadge variant="neutral">{trace.task.status}</StatusBadge>
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

// Main App Component
function AppContent() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="*" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/login" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/evolution" element={<EvolutionPage />} />
        <Route path="/samples" element={<SamplesPage />} />
        <Route path="/thinking-models" element={<ThinkingModelsPage />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  return (
    <BrowserRouter basename="/plugins/principles">
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </BrowserRouter>
  );
}
