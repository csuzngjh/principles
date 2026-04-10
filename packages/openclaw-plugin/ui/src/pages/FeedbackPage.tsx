import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { FeedbackGfiResponse, EmpathyEvent, FeedbackGateBlock } from '../types';
import { GroupedBarChart, EmptyState } from '../charts';
import { useI18n } from '../i18n/ui';
import { Loading, ErrorState } from '../components';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

export function FeedbackPage() {
  const { t } = useI18n();
  const [gfi, setGfi] = useState<FeedbackGfiResponse | null>(null);
  const [empathyEvents, setEmpathyEvents] = useState<EmpathyEvent[]>([]);
  const [gateBlocks, setGateBlocks] = useState<FeedbackGateBlock[]>([]);
  const [error, setError] = useState('');

  const loadAll = useCallback(async () => {
    try {
      const [gfiData, events, blocks] = await Promise.all([
        api.getFeedbackGfi(),
        api.getEmpathyEvents(20),
        api.getFeedbackGateBlocks(20),
      ]);
      setGfi(gfiData);
      setEmpathyEvents(events);
      setGateBlocks(blocks);
      setError('');
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const { isRefreshing } = useAutoRefresh(loadAll, {
    intervalMs: 15000,
    enabled: !!gfi,
  });

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  if (error) return <ErrorState error={error} />;
  if (!gfi) return <Loading />;

  const gfiPercent = Math.min(100, (gfi.current / gfi.threshold) * 100);
  const gfiColor = gfi.current >= gfi.threshold ? 'var(--error)' : gfi.current >= gfi.threshold * 0.8 ? 'var(--warning)' : 'var(--success)';

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">{t('feedback.pageTitle')}</span>
          <h2>{t('feedback.pageSubtitle')}</h2>
        </div>
      </header>

      {/* GFI Dashboard */}
      <section className="panel" style={{ marginBottom: 'var(--space-5)' }}>
        <h3>{t('feedback.gfiDashboard')}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', padding: 'var(--space-4) 0' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '48px', fontWeight: 700, color: gfiColor }}>{gfi.current}</div>
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
              {t('feedback.threshold')}: {gfi.threshold} | {t('feedback.peakToday')}: {gfi.peakToday}
            </div>
            <div style={{ marginTop: 'var(--space-2)', width: '100%', height: '8px', background: 'var(--bg-sunken)', borderRadius: '4px' }}>
              <div style={{ width: `${gfiPercent}%`, height: '100%', background: gfiColor, borderRadius: '4px', transition: 'width 0.3s' }} />
            </div>
          </div>
          <div style={{ flex: 2 }}>
            <h4 style={{ marginBottom: 'var(--space-2)' }}>{t('feedback.hourlyTrend')}</h4>
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
          <h3>{t('feedback.empathyEvents')}</h3>
          {empathyEvents.length === 0 ? (
            <EmptyState title={t('feedback.noEmpathyEvents')} description={t('feedback.noEmpathyEventsDesc')} />
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
          <h3>{t('feedback.gateBlocks')}</h3>
          {gateBlocks.length === 0 ? (
            <EmptyState title={t('feedback.noGateBlocks')} description={t('feedback.noGateBlocksDesc')} />
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
