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
ChevronLeft,
  Activity,
  Shield,
  Zap,
  AlertTriangle,
  BookOpen,
  ListTodo,
  Radio,
  Lock,
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
  OverviewHealthResponse,
  EvolutionPrinciplesResponse,
} from './types';
import { Sparkline, DonutChart, GroupedBarChart, TimeRangeSelector, CollapsiblePanel, StatusBadge, EmptyState } from './charts';
import { useI18n } from './i18n/ui';

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
          <span>{t('auth.checking')}</span>
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
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('t('auth.errorEmpty')');
      return;
    }
    setLoading(true);
    setError('');
    const success = await login(token.trim());
    setLoading(false);
    if (success) {
      navigate('/overview');
    } else {
      setError('t('auth.errorInvalid')');
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
            <h1>{t('brand.title')}</h1>
          </div>
          <p className="login-subtitle">{t('auth.loginSubtitle')}</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="token">Gateway Token</label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('auth.tokenPlaceholder')}
              autoComplete="off"
            />
            <span className="form-hint">
              {t('auth.tokenHint')}
            </span>
          </div>

          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="login-button" disabled={loading}>
            {loading ? (
              <>
                <span className="spinner-small"></span>
                {t('auth.validatingButton')}
              </>
            ) : (
              '{t('auth.loginButton')}'
            )}
          </button>
        </form>

        <div className="login-footer">
          <h4>{t('auth.howToGetToken')}</h4>
          <ol>
            <li>{t('auth.step1')}</li>
            <li>{t('auth.step2')}</li>
            <li>{t('auth.step3')}</li>
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
      <a href="#main-content" className="skip-link">跳过导航，直接访问内容</a>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <span className="logo-icon">
              <Hexagon strokeWidth={1.5} />
            </span>
          </div>
          <span className="eyebrow">{t('brand.title')}</span>
          <h1>{t('brand.title')}</h1>
          <p>{t('brand.subtitle')}</p>
        </div>
        <nav className="nav">
          <NavLink to="/overview" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <BarChart3 strokeWidth={1.75} />
            </span>
            <span>{t('nav.overview')}</span>
          </NavLink>
          <NavLink to="/evolution" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <GitBranch strokeWidth={1.75} />
            </span>
            <span>{t('nav.evolution')}</span>
          </NavLink>
          <NavLink to="/samples" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <FileCheck strokeWidth={1.75} />
            </span>
            <span>{t('nav.samples')}</span>
          </NavLink>
          <NavLink to="/thinking-models" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <Brain strokeWidth={1.75} />
            </span>
            <span>{t('nav.thinkingModels')}</span>
          </NavLink>
          <NavLink to="/feedback" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <Radio strokeWidth={1.75} />
            </span>
            <span>反馈回路</span>
          </NavLink>
          <NavLink to="/gate" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            <span className="nav-icon">
              <Lock strokeWidth={1.75} />
            </span>
            <span>Gate 监控</span>
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <a className="export-link" href={api.exportCorrections('redacted')}>
            <span className="nav-icon">
              <Download strokeWidth={1.75} />
            </span>
            <span>{t('nav.exportSamples')}</span>
          </a>
          <button className="logout-button" onClick={logout}>
            <span className="nav-icon">
              <LogOut strokeWidth={1.75} />
            </span>
            <span>{t('nav.logout')}</span>
          </button>
        </div>
      </aside>
      <main className="content" id="main-content">{children}</main>
    </div>
  );
}

function Loading() {
  return (
    <div className="loading-state">
      <div className="spinner"></div>
      <span>{t('common.loading')}</span>
    </div>
  );
}

function ErrorState({ error }: { error: string }) {
  return <div className="panel error">{error}</div>;
}

function WorkspaceConfig() {
  const { t } = useI18n();
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
          {showAddForm ? t('workspace.cancel') : '+ ' + t('workspace.addWorkspace')}
        </button>
      </div>

      {showAddForm && (
        <form className="add-workspace-form" onSubmit={handleAddWorkspace} style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-3)', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', color: 'var(--text-secondary)' }}>{t('workspace.workspaceName')}</label>
              <input
                type="text"
                value={newWsName}
                onChange={(e) => setNewWsName(e.target.value)}
                placeholder={t('workspace.placeholder.name')}
                style={{ width: '100%', padding: 'var(--space-2)', fontSize: '13px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
              />
            </div>
            <div style={{ flex: 2 }}>
              <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', color: 'var(--text-secondary)' }}>{t('workspace.path')}</label>
              <input
                type="text"
                value={newWsPath}
                onChange={(e) => setNewWsPath(e.target.value)}
                placeholder={t('workspace.placeholder.path')}
                style={{ width: '100%', padding: 'var(--space-2)', fontSize: '13px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
              />
            </div>
            <button type="submit" className="button-primary" disabled={adding || !newWsName.trim() || !newWsPath.trim()}>
              {adding ? 't('workspace.adding')' : 't('workspace.addWorkspace')'}
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
                  <span style={{ fontSize: '13px' }}>{t('workspace.include')}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={config.syncEnabled}
                    onChange={() => handleToggle(ws.name, 'syncEnabled', config.syncEnabled)}
                    disabled={isSaving || !config.enabled}
                  />
                  <span style={{ fontSize: '13px' }}>{t('workspace.sync')}</span>
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

  useEffect(() => {
    loadCentralOverview();
    api.getOverviewHealth().then(setHealth).catch(() => {});
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
          <h2>{t('overview.pageTitle')}</h2>
        </div>
        <div className="meta">
          <TimeRangeSelector value={days} onChange={setDays} />
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
            <span className="label">🟢 GFI 疲劳指数</span>
            <span className="value">{health.gfi.current}</span>
            <span>阈值: {health.gfi.threshold} | 今日峰值: {health.gfi.peakToday}</span>
          </article>
          <article className="panel kpi" style={{ borderLeft: `3px solid ${health.painFlag.active ? 'var(--warning)' : 'var(--success)'}` }}>
            <span className="label">🟡 PainFlag</span>
            <span className="value">{health.painFlag.active ? '活跃' : '正常'}</span>
            <span>{health.painFlag.source ? `来源: ${health.painFlag.source}` : '无活跃痛点'}</span>
          </article>
          <article className="panel kpi" style={{ borderLeft: '3px solid var(--info)' }}>
            <span className="label">🔵 Trust Stage</span>
            <span className="value">{health.trust.stageLabel}</span>
            <span>Stage {health.trust.stage} | 分数: {health.trust.score}</span>
          </article>
          <article className="panel kpi" style={{ borderLeft: '3px solid var(--accent)' }}>
            <span className="label">🟣 EP Tier</span>
            <span className="value">{health.evolution.tier}</span>
            <span>积分: {health.evolution.points}</span>
          </article>
          <article className="panel kpi" style={{ borderLeft: '3px solid var(--success)' }}>
            <span className="label">📊 原则总数</span>
            <span className="value">{health.principles.candidate + health.principles.probation + health.principles.active + health.principles.deprecated}</span>
            <span>候: {health.principles.candidate} | 试: {health.principles.probation} | 活: {health.principles.active} | 废: {health.principles.deprecated}</span>
          </article>
          <article className="panel kpi" style={{ borderLeft: `3px solid ${health.queue.pending > 5 ? 'var(--warning)' : 'var(--success)'}` }}>
            <span className="label">⏱️ 队列积压</span>
            <span className="value">{health.queue.pending}</span>
            <span>待处理: {health.queue.pending} | 处理中: {health.queue.inProgress} | 已完成: {health.queue.completed}</span>
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

function SamplesPage() {
  const { t } = useI18n();
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
          <h2>{t('samples.pageTitle')}</h2>
        </div>
        <div className="filters">
          <label>
            {t('samples.statusFilter')}
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">{t('samples.statusAll')}</option>
              <option value="pending">{t('samples.statusPending')}</option>
              <option value="approved">{t('samples.statusApproved')}</option>
              <option value="rejected">{t('samples.statusRejected')}</option>
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
          {!selected && <EmptyState title={t('samples.emptyTitle')} description={t('samples.emptyDesc')} />}
          {selected && (
            <div className="detail-stack">
              <div className="detail-header">
                <div>
                  <h3>{selected.sampleId}</h3>
                  <p>{selected.sessionId} | {selected.reviewStatus} | score {selected.qualityScore}</p>
                </div>
                <div className="button-row">
                  <button className="button-primary" onClick={() => review('approved')}>{t('samples.approve')}</button>
                  <button className="button-ghost" onClick={() => review('rejected')}>{t('samples.reject')}</button>
                </div>
              </div>
              <article>
                <h4>{t('samples.badAttempt')}</h4>
                <pre>{selected.badAttempt.rawText || selected.badAttempt.sanitizedText}</pre>
              </article>
              <article>
                <h4>{t('samples.userCorrection')}</h4>
                <pre>{selected.userCorrection.rawText}</pre>
              </article>
              <article>
                <h4>{t('samples.recoveryToolSpan')}</h4>
                <div className="pill-row">
                  {selected.recoveryToolSpan.map((item) => (
                    <span className="badge" key={item.id}>{item.toolName} #{item.id}</span>
                  ))}
                </div>
              </article>
              <article>
                <h4>{t('samples.relatedThinkingHits')}</h4>
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
                <h4>{t('samples.reviewHistory')}</h4>
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
  const { t } = useI18n();
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
          <h2>{t('thinkingModels.pageTitle')}</h2>
        </div>
        <div className="pill-row">
          <span className="badge">{t('thinkingModels.coverage')} {formatPercent(data.summary.coverageRate)}</span>
          <span className="badge">{t('thinkingModels.active')} {data.summary.activeModels}</span>
          <span className="badge">{t('thinkingModels.dormant')} {data.summary.dormantModels}</span>
          <span className="badge">{t('thinkingModels.effective')} {data.summary.effectiveModels}</span>
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
          {!detail && <EmptyState title={t('thinkingModels.emptyTitle')} description={t('thinkingModels.emptyDesc')} />}
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
              <article>
                <h4>{t('thinkingModels.recentEvents')}</h4>
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

      {/* Circuit Flow Indicator (Phase 5) */}
      {evoPrinciples && (
        <section className="panel" style={{ marginBottom: 'var(--space-5)' }}>
          <h3>🔄 增强回路流程</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', padding: 'var(--space-3) 0', flexWrap: 'wrap' }}>
            {['痛点检测', '诊断', '原则生成', '晋升', '活跃', '夜间反思', '训练', '内化'].map((step, i) => {
              // Backend returns 'pending'/'in_progress'/'completed'/'idle' — map to circuit step names
              const currentStep = (() => {
                switch (evoPrinciples.activeStage) {
                  case 'pending': return '痛点检测';
                  case 'in_progress': return '诊断';
                  case 'completed': return '内化';
                  case 'idle': return '痛点检测';
                  default: return '痛点检测';
                }
              })();
              const isActive = currentStep === step;
              return (
                <React.Fragment key={step}>
                  <span style={{
                    padding: 'var(--space-1) var(--space-2)',
                    borderRadius: 'var(--radius-md)',
                    fontSize: '13px',
                    fontWeight: isActive ? 700 : 400,
                    background: isActive ? 'var(--accent)' : 'var(--bg-sunken)',
                    color: isActive ? '#fff' : 'var(--text-secondary)',
                    border: isActive ? '2px solid var(--accent)' : '1px solid var(--border)',
                  }}>
                    {step}
                  </span>
                  {i < 7 && <span style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>→</span>}
                </React.Fragment>
              );
            })}
          </div>
        </section>
      )}

      {/* Principle Lifecycle & Nocturnal Training (Phase 5) */}
      {evoPrinciples && (
        <div className="grid two-columns" style={{ marginBottom: 'var(--space-5)' }}>
          <section className="panel">
            <h3>📝 原则生命周期</h3>
            <div className="pill-row" style={{ marginBottom: 'var(--space-3)' }}>
              <span className="badge" style={{ background: '#f59e0b' }}>候选: {evoPrinciples.principles.summary.candidate}</span>
              <span className="badge" style={{ background: '#3b82f6' }}>试用: {evoPrinciples.principles.summary.probation}</span>
              <span className="badge" style={{ background: '#22c55e' }}>活跃: {evoPrinciples.principles.summary.active}</span>
              <span className="badge" style={{ background: '#ef4444' }}>废弃: {evoPrinciples.principles.summary.deprecated}</span>
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
function FeedbackPage() {
  const [gfi, setGfi] = useState<FeedbackGfiResponse | null>(null);
  const [empathyEvents, setEmpathyEvents] = useState<EmpathyEvent[]>([]);
  const [gateBlocks, setGateBlocks] = useState<FeedbackGateBlock[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.getFeedbackGfi(),
      api.getEmpathyEvents(20),
      api.getFeedbackGateBlocks(20),
    ]).then(([gfiData, events, blocks]) => {
      setGfi(gfiData);
      setEmpathyEvents(events);
      setGateBlocks(blocks);
      setError('');
    }).catch((err) => setError(String(err)));
  }, []);

  if (error) return <ErrorState error={error} />;
  if (!gfi) return <Loading />;

  const gfiPercent = Math.min(100, (gfi.current / gfi.threshold) * 100);
  const gfiColor = gfi.current >= gfi.threshold ? 'var(--error)' : gfi.current >= gfi.threshold * 0.8 ? 'var(--warning)' : 'var(--success)';

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Feedback Loop</span>
          <h2>反馈回路 — GFI 监控与同理心检测</h2>
        </div>
      </header>

      {/* GFI Dashboard */}
      <section className="panel" style={{ marginBottom: 'var(--space-5)' }}>
        <h3>GFI 实时仪表盘</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', padding: 'var(--space-4) 0' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '48px', fontWeight: 700, color: gfiColor }}>{gfi.current}</div>
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
              阈值: {gfi.threshold} | 今日峰值: {gfi.peakToday}
            </div>
            <div style={{ marginTop: 'var(--space-2)', width: '100%', height: '8px', background: 'var(--bg-sunken)', borderRadius: '4px' }}>
              <div style={{ width: `${gfiPercent}%`, height: '100%', background: gfiColor, borderRadius: '4px', transition: 'width 0.3s' }} />
            </div>
          </div>
          <div style={{ flex: 2 }}>
            <h4 style={{ marginBottom: 'var(--space-2)' }}>小时趋势</h4>
            {gfi.trend.length > 0 && (
              <GroupedBarChart
                data={gfi.trend.slice(-12).map((item) => ({
                  label: item.hour.slice(-5),
                  values: [item.value],
                }))}
                colors={['var(--warning)']}
                width={400}
                height={80}
              />
            )}
          </div>
        </div>
      </section>

      <div className="grid two-columns">
        {/* Empathy Events */}
        <section className="panel">
          <h3>同理心检测事件</h3>
          {empathyEvents.length === 0 ? (
            <div className="muted">暂无同理心事件</div>
          ) : (
            <div className="stack">
              {empathyEvents.map((event, i) => (
                <div className="row-card vertical" key={i}>
                  <div>
                    <strong style={{ color: event.severity === 'high' || event.severity === 'severe' || event.severity === 'critical' ? 'var(--error)' : 'var(--warning)' }}>
                      [{event.severity}] {new Date(event.timestamp).toLocaleTimeString()}
                    </strong>
                    <span>{event.origin}</span>
                  </div>
                  <div style={{ fontSize: '0.9em', color: 'var(--text-secondary)' }}>{event.reason}</div>
                  <div className="pill-row">
                    <span className="badge">+{event.score}</span>
                    <span className="badge">GFI: {event.gfiAfter}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* GFI → Gate Blocks */}
        <section className="panel">
          <h3>GFI → Gate 拦截关联</h3>
          {gateBlocks.length === 0 ? (
            <div className="muted">暂无拦截记录</div>
          ) : (
            <div className="stack">
              {gateBlocks.map((block, i) => (
                <div className="row-card" key={i}>
                  <div>
                    <strong>{block.toolName}</strong>
                    <span>{new Date(block.timestamp).toLocaleString()}</span>
                  </div>
                  <div className="pill-row">
                    <span className="badge">GFI: {block.gfi}</span>
                    <span className="badge">Stage: {block.trustStage}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ===== Phase 6: Gate Monitor Page =====
function GateMonitorPage() {
  const [gateStats, setGateStats] = useState<GateStatsResponse | null>(null);
  const [gateBlocks, setGateBlocks] = useState<GateBlockItem[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.getGateStats(),
      api.getGateBlocks(50),
    ]).then(([stats, blocks]) => {
      setGateStats(stats);
      setGateBlocks(blocks);
      setError('');
    }).catch((err) => setError(String(err)));
  }, []);

  if (error) return <ErrorState error={error} />;
  if (!gateStats) return <Loading />;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Gate Monitor</span>
          <h2>Gate 监控 — 拦截统计与 Trust/EP 双轨</h2>
        </div>
      </header>

      {/* Today's Block Stats */}
      <section className="panel" style={{ marginBottom: 'var(--space-5)' }}>
        <h3>今日拦截统计</h3>
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
          <article className="panel kpi">
            <span className="label">GFI 拦截</span>
            <span className="value">{gateStats.today.gfiBlocks}</span>
          </article>
          <article className="panel kpi">
            <span className="label">Stage 限制</span>
            <span className="value">{gateStats.today.stageBlocks}</span>
          </article>
          <article className="panel kpi">
            <span className="label">P-03 不匹配</span>
            <span className="value">{gateStats.today.p03Blocks}</span>
          </article>
          <article className="panel kpi">
            <span className="label">绕过尝试</span>
            <span className="value" style={{ color: 'var(--error)' }}>{gateStats.today.bypassAttempts}</span>
          </article>
          <article className="panel kpi">
            <span className="label">P-16 豁免</span>
            <span className="value">{gateStats.today.p16Exemptions}</span>
          </article>
        </div>
      </section>

      {/* Trust & EP Dual Track */}
      <div className="grid two-columns" style={{ marginBottom: 'var(--space-5)' }}>
        <section className="panel">
          <h3>🔐 Trust Engine</h3>
          <div style={{ padding: 'var(--space-3) 0' }}>
            <div style={{ fontSize: '24px', fontWeight: 700 }}>Stage {gateStats.trust.stage}: {gateStats.trust.status}</div>
            <div style={{ marginTop: 'var(--space-2)', width: '100%', height: '12px', background: 'var(--bg-sunken)', borderRadius: '6px' }}>
              <div style={{ width: `${gateStats.trust.score}%`, height: '100%', background: 'var(--info)', borderRadius: '6px' }} />
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: 'var(--space-1)' }}>
              分数: {gateStats.trust.score}/100
            </div>
          </div>
        </section>
        <section className="panel">
          <h3>🌱 Evolution Engine</h3>
          <div style={{ padding: 'var(--space-3) 0' }}>
            <div style={{ fontSize: '24px', fontWeight: 700 }}>{gateStats.evolution.tier} ({gateStats.evolution.status})</div>
            <div style={{ marginTop: 'var(--space-2)', width: '100%', height: '12px', background: 'var(--bg-sunken)', borderRadius: '6px' }}>
              <div style={{ width: `${Math.min(100, gateStats.evolution.points / 10)}%`, height: '100%', background: 'var(--success)', borderRadius: '6px' }} />
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: 'var(--space-1)' }}>
              积分: {gateStats.evolution.points}
            </div>
          </div>
        </section>
      </div>

      {/* Block History */}
      <section className="panel">
        <h3>拦截历史</h3>
        {gateBlocks.length === 0 ? (
          <div className="muted">暂无拦截记录</div>
        ) : (
          <div className="list-table">
            {gateBlocks.map((block, i) => (
              <div className="table-row" key={i}>
                <div>
                  <strong>{block.toolName}</strong>
                  <span>{block.filePath || '—'}</span>
                </div>
                <div>
                  <span className="badge">{block.gateType}</span>
                  <span>{block.reason}</span>
                </div>
                <div className="align-right">
                  <span className="badge">GFI: {block.gfi}</span>
                  <span>{new Date(block.timestamp).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
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
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route path="/gate" element={<GateMonitorPage />} />
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
