import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n/ui';
import { Settings, ChevronDown, ChevronUp } from 'lucide-react';

export function WorkspaceConfig() {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
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
    if (visible) loadConfigs();
  }, [loadConfigs, visible]);

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

  const enabledCount = (wsData?.configs ?? []).filter(c => c.enabled && c.syncEnabled).length;
  const totalCount = wsData?.workspaces?.length ?? 0;

  // Toggle bar (always visible)
  if (!visible) {
    return (
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <button
          className="button-secondary"
          onClick={() => setVisible(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: '0.8rem' }}
        >
          <Settings size={14} />
          <span>{t('workspace.title')}</span>
          {wsData && (
            <span className="badge" style={{ fontSize: '0.7rem' }}>{enabledCount} / {totalCount}</span>
          )}
        </button>
      </div>
    );
  }

  if (error) return <div className="panel error">{error}</div>;
  if (!wsData) return <div className="panel" style={{ padding: 'var(--space-3)' }}>Loading...</div>;

  return (
    <section className="panel" style={{ marginBottom: 'var(--space-4)' }}>
      <div
        className="panel-header"
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        onClick={() => setVisible(false)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Settings size={16} />
          <h3 style={{ fontSize: '0.9rem', margin: 0 }}>{t('workspace.title')}</h3>
          <span className="badge" style={{ fontSize: '0.7rem' }}>{enabledCount} / {totalCount} enabled</span>
        </div>
        <ChevronUp size={18} style={{ color: 'var(--text-secondary)' }} />
      </div>
      <div className="panel-content">
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
                {adding ? t('workspace.adding') : t('workspace.addWorkspace')}
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
      </div>
    </section>
  );
}

