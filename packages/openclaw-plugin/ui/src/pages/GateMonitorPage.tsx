import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { GateStatsResponse, GateBlockItem } from '../types';
import { EmptyState } from '../charts';
import { useI18n } from '../i18n/ui';
import { formatDate } from '../utils/format';
import { Loading, ErrorState } from '../components';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

export function GateMonitorPage() {
  const { t } = useI18n();
  const [gateStats, setGateStats] = useState<GateStatsResponse | null>(null);
  const [gateBlocks, setGateBlocks] = useState<GateBlockItem[]>([]);
  const [error, setError] = useState('');

  const loadAll = useCallback(async () => {
    try {
      const [stats, blocks] = await Promise.all([
        api.getGateStats(),
        api.getGateBlocks(50),
      ]);
      setGateStats(stats);
      setGateBlocks(blocks);
      setError('');
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const { isRefreshing } = useAutoRefresh(loadAll, {
    intervalMs: 30000,
    enabled: !!gateStats,
  });

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  if (error) return <ErrorState error={error} />;
  if (!gateStats) return <Loading />;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">{t('gate.pageTitle')}</span>
          <h2>{t('gate.pageSubtitle')}</h2>
        </div>
      </header>

      {/* Today's Block Stats */}
      <section className="panel" style={{ marginBottom: 'var(--space-5)' }}>
        <h3>{t('gate.todayStats')}</h3>
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
          <article className="panel kpi">
            <span className="label">{t('gate.gfiBlocks')}</span>
            <span className="value">{gateStats.today.gfiBlocks}</span>
          </article>
          <article className="panel kpi">
            <span className="label">{t('gate.stageBlocks')}</span>
            <span className="value">{gateStats.today.stageBlocks}</span>
          </article>
          <article className="panel kpi">
            <span className="label">{t('gate.p03Blocks')}</span>
            <span className="value">{gateStats.today.p03Blocks}</span>
          </article>
          <article className="panel kpi">
            <span className="label">{t('gate.bypassAttempts')}</span>
            <span className="value" style={{ color: 'var(--error)' }}>{gateStats.today.bypassAttempts}</span>
          </article>
          <article className="panel kpi">
            <span className="label">{t('gate.p16Exemptions')}</span>
            <span className="value">{gateStats.today.p16Exemptions}</span>
          </article>
        </div>
      </section>

      {/* Trust & EP Dual Track */}
      <div className="grid two-columns" style={{ marginBottom: 'var(--space-5)' }}>
        <section className="panel">
          <h3>🔐 {t('gate.trustEngine')}</h3>
          <div style={{ padding: 'var(--space-3) 0' }}>
            <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>Stage {gateStats.trust.stage}: {gateStats.trust.status}</div>
            <div style={{ marginTop: 'var(--space-2)', width: '100%', height: '12px', background: 'var(--bg-sunken)', borderRadius: '6px' }}>
              <div style={{ width: `${gateStats.trust.score}%`, height: '100%', background: 'var(--info)', borderRadius: '6px' }} />
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: 'var(--space-1)' }}>
              {t('gate.score')}: {gateStats.trust.score}/100
            </div>
          </div>
        </section>
        <section className="panel">
          <h3>🌱 {t('gate.evolutionEngine')}</h3>
          <div style={{ padding: 'var(--space-3) 0' }}>
            <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{gateStats.evolution.tier} ({gateStats.evolution.status})</div>
            <div style={{ marginTop: 'var(--space-2)', width: '100%', height: '12px', background: 'var(--bg-sunken)', borderRadius: '6px' }}>
              <div style={{ width: `${Math.min(100, gateStats.evolution.points / 10)}%`, height: '100%', background: 'var(--success)', borderRadius: '6px' }} />
            </div>
            <div className="text-sm" style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-1)' }}>
              {t('gate.points')}: {gateStats.evolution.points}
            </div>
          </div>
        </section>
      </div>

      {/* Block History */}
      <section className="panel">
        <h3>{t('gate.blockHistory')}</h3>
        {gateBlocks.length === 0 ? (
          <EmptyState title={t('gate.noGateBlocks')} description={t('gate.noGateBlocksDesc')} />
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
