/**
 * IngestionStatusPage — read-only three-host conversation-ingestion health
 * (PRI-1171 ticket ⑦; SPEC v0.2 §6, G6 red line: STATUS, never trajectory
 * browsing). The page renders the CLI authority's section verbatim (validated
 * client-side for the fields it shows); every degraded field carries its
 * reason + nextAction inline (rc-9), and "unable to determine" is never
 * rendered as healthy.
 */
import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { Button } from "../../components/ui/button.js";
import { RefreshCw, CircleCheck, CircleAlert, CircleDashed } from "lucide-react";
import { fetchIngestionHealth } from "../../api.js";
import type {
  IngestionHealthResultData,
  IngestionMonitoredHostData,
  IngestionNotWiredHostData,
} from "../../utils/validators.js";

type HostRow = IngestionMonitoredHostData | IngestionNotWiredHostData;
type HostKey = "codex" | "workbuddy" | "openclaw";

function StatusChip({ state }: { state: 'ENABLED' | 'DISABLED' | 'UNKNOWN' }) {
  const { t } = useTranslation();
  const cls = state === 'ENABLED' ? 'text-emerald-500' : state === 'DISABLED' ? 'text-ink-3' : 'text-amber-500';
  const Icon = state === 'ENABLED' ? CircleCheck : state === 'DISABLED' ? CircleDashed : CircleAlert;
  return (
    <span className={`inline-flex items-center gap-1 text-sm ${cls}`}>
      <Icon size={14} aria-hidden />
      {t(`pages.ingestionStatus.flag.${state}`)}
    </span>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-ink-3 min-w-40">{label}</span>
      <span className="text-ink-1 break-all">{value}</span>
    </div>
  );
}

function MonitoredHostCard({ host, row }: { host: HostKey; row: IngestionMonitoredHostData }) {
  const { t } = useTranslation();
  const checkpoints = 'reason' in row.checkpoints ? null : row.checkpoints;
  const checkpointsDegraded = 'reason' in row.checkpoints ? row.checkpoints : null;
  const liveOnly = 'reason' in row.liveOnly ? null : row.liveOnly;
  const liveOnlyDegraded = 'reason' in row.liveOnly ? row.liveOnly : null;
  return (
    <div className="rounded-lg border border-line-2 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-ink-1">{t(`pages.ingestionStatus.host.${host}`)}</h3>
        <StatusChip state={row.ingestionFlag.state} />
      </div>
      <SummaryLine label={t('pages.ingestionStatus.hostFlag')} value={t(`pages.ingestionStatus.flag.${row.hostFlag.state}`)} />
      <SummaryLine label={t('pages.ingestionStatus.consent')} value={t(`pages.ingestionStatus.consentState.${row.consent.state}`, { defaultValue: row.consent.state })} />
      {checkpoints !== null ? (
        <>
          <SummaryLine
            label={t('pages.ingestionStatus.checkpoints')}
            value={t('pages.ingestionStatus.checkpointSummary', {
              defaultValue: '{{total}} sessions · offset {{offset}} · lag {{lag}}',
              total: String(checkpoints.total),
              offset: checkpoints.checkpointOffset === null ? '—' : String(checkpoints.checkpointOffset),
              lag: checkpoints.lagBytes === null ? '—' : String(checkpoints.lagBytes),
            })}
          />
          {checkpoints.lastDegradation !== null && (
            <SummaryLine label={t('pages.ingestionStatus.lastDegradation')} value={checkpoints.lastDegradation.reason} />
          )}
          {checkpoints.incompleteTailCount > 0 && (
            <SummaryLine label={t('pages.ingestionStatus.incompleteTail')} value={String(checkpoints.incompleteTailCount)} />
          )}
        </>
      ) : (
        checkpointsDegraded !== null && (
          <SummaryLine label={t('pages.ingestionStatus.checkpoints')} value={`${t('pages.ingestionStatus.degraded')} — ${checkpointsDegraded.reason}`} />
        )
      )}
      {liveOnly !== null ? (
        <SummaryLine
          label={t('pages.ingestionStatus.liveOnly')}
          value={t('pages.ingestionStatus.liveOnlySummary', {
            defaultValue: '{{count}} sessions{{suffix}}',
            count: String(liveOnly.sessions.length),
            suffix: liveOnly.truncated ? '+' : '',
          })}
        />
      ) : (
        liveOnlyDegraded !== null && (
          <SummaryLine label={t('pages.ingestionStatus.liveOnly')} value={`${t('pages.ingestionStatus.degraded')} — ${liveOnlyDegraded.reason}`} />
        )
      )}
      {row.consent.nextAction !== undefined && (
        <p className="text-sm text-amber-500">{t('pages.ingestionStatus.nextAction')}: {row.consent.nextAction}</p>
      )}
      {checkpointsDegraded !== null && <p className="text-sm text-amber-500">{t('pages.ingestionStatus.nextAction')}: {checkpointsDegraded.nextAction}</p>}
      {liveOnlyDegraded !== null && <p className="text-sm text-amber-500">{t('pages.ingestionStatus.nextAction')}: {liveOnlyDegraded.nextAction}</p>}
    </div>
  );
}

function NotWiredHostCard({ host, row }: { host: HostKey; row: IngestionNotWiredHostData }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-dashed border-line-2 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-ink-1">{t(`pages.ingestionStatus.host.${host}`)}</h3>
        <span className="inline-flex items-center gap-1 text-sm text-ink-3">
          <CircleDashed size={14} aria-hidden />
          {t('pages.ingestionStatus.notWired')}
        </span>
      </div>
      <p className="text-sm text-ink-3">{row.reason}</p>
      <p className="text-sm text-ink-2">{t('pages.ingestionStatus.nextAction')}: {row.nextAction}</p>
    </div>
  );
}

export function IngestionStatusPage() {
  const { t } = useTranslation();
  const [result, setResult] = useState<IngestionHealthResultData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetchIngestionHealth();
    setResult(response.success ? response.data : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hosts: HostKey[] = ['codex', 'workbuddy', 'openclaw'];

  return (
    <PageShell>
      <div className="flex items-center justify-between">
        <div>
          <SectionTitle id="section-ingestion-status">{t('pages.ingestionStatus.title')}</SectionTitle>
          <p className="text-sm text-ink-3 mt-1">{t('pages.ingestionStatus.description')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} aria-label={t('pages.ingestionStatus.refresh')}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden />
        </Button>
      </div>
      {loading && result === null ? (
        <PageLoading cardCount={3} label={t('common.loading')} />
      ) : result === null ? (
        <p className="text-sm text-ink-3">{t('pages.ingestionStatus.unreachable')}</p>
      ) : result.status === 'unknown' ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-2">
          <p className="text-sm text-amber-500">{result.reason}</p>
          <p className="text-sm text-ink-2">{t('pages.ingestionStatus.nextAction')}: {result.nextAction}</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {hosts.map((host) => {
            const row = result.ingestion?.[host];
            if (row === undefined) return null;
            return row.status === 'monitored'
              ? <MonitoredHostCard key={host} host={host} row={row} />
              : <NotWiredHostCard key={host} host={host} row={row} />;
          })}
        </div>
      )}
    </PageShell>
  );
}
