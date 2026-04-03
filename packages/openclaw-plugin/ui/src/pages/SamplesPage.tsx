import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { api } from '../api';
import type { SamplesResponse, SampleDetailResponse } from '../types';
import { EmptyState } from '../charts';
import { useI18n } from '../i18n/ui';
import { formatDate } from '../utils/format';
import { Loading, ErrorState } from '../components';

export function SamplesPage() {
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
                <button
                  className="back-button"
                  onClick={() => setSelected(null)}
                  title={t('common.back') || 'Back'}
                >
                  <ChevronLeft strokeWidth={1.75} size={18} />
                </button>
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

