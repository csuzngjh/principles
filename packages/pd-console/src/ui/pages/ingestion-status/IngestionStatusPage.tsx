/**
 * IngestionStatusPage — read-only three-host conversation-ingestion health
 * (PRI-1171 ticket ⑦; SPEC v0.2 §6, G6 red line: STATUS, never trajectory
 * browsing). The page renders the CLI authority's section verbatim (validated
 * client-side for the fields it shows); every degraded field carries its
 * reason + nextAction inline (rc-9), and "unable to determine" is never
 * rendered as healthy.
 *
 * Presentation (UI/UX plan §4.1/§4.3): the CLI's stable reason codes and
 * operator-pitched prose are localized through ingestion-presentation.ts;
 * raw values survive only inside TechnicalDetails disclosures, never in the
 * reading path. Space: the shell uses the shared `dashboard` width tier
 * (`<PageShell width="dashboard">` — the same large-viewport step the
 * principle library takes) and the two monitored host cards reflow
 * side by side — extra room becomes more columns, never a longer line.
 */
import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { Button } from "../../components/ui/button.js";
import { TechnicalDetails, TechnicalRow } from "../../components/ui/technical-details.js";
import { RefreshCw, CircleCheck, CircleAlert, CircleDashed } from "lucide-react";
import { fetchIngestionHealth } from "../../api.js";
import { formatDate } from "../../utils/format-date.js";
import type {
  IngestionHealthResultData,
  IngestionMonitoredHostData,
  IngestionNotWiredHostData,
} from "../../utils/validators.js";
import {
  presentConsentNextAction,
  presentDegradedSection,
  presentIngestionNextAction,
  presentIngestionReason,
  presentNotWired,
  shortIdentifier,
  type PresentedText,
  type TranslateFn,
} from "./ingestion-presentation.js";

type HostRow = IngestionMonitoredHostData | IngestionNotWiredHostData;
type HostKey = "codex" | "workbuddy" | "openclaw";

function StatusChip({ state }: { state: 'ENABLED' | 'DISABLED' | 'UNKNOWN' }) {
  const { t } = useTranslation();
  // Semantic theme tokens only (EP-13): text-gov = success accent, text-amber
  // = the project warning token (same as DebtPage), text-ink-3 = muted.
  const cls = state === 'ENABLED' ? 'text-gov' : state === 'DISABLED' ? 'text-ink-3' : 'text-amber';
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
    <div className="text-sm">
      <span className="text-ink-3 block">{label}</span>
      <span className="text-ink-1 break-all">{value}</span>
    </div>
  );
}

/** One amber reading-path line: localized sentence, raw kept for the fold. */
function AttentionLine({ label, presented }: { label: string; presented: PresentedText }) {
  return (
    <p className="text-sm text-amber">
      {label}: {presented.text}
    </p>
  );
}

function MonitoredHostCard({ host, row }: { host: HostKey; row: IngestionMonitoredHostData }) {
  const { t, i18n } = useTranslation();
  const formatTime = (iso: string) => formatDate(iso, i18n.language);
  const checkpoints = 'reason' in row.checkpoints ? null : row.checkpoints;
  const checkpointsDegraded = 'reason' in row.checkpoints ? row.checkpoints : null;
  const liveOnly = 'reason' in row.liveOnly ? null : row.liveOnly;
  const liveOnlyDegraded = 'reason' in row.liveOnly ? row.liveOnly : null;
  // rc-9: an UNKNOWN flag must carry the loader's diagnostic, not be a bare state.
  const unknownFlags = [row.hostFlag, row.ingestionFlag].filter((flag) => flag.state === 'UNKNOWN');
  const shownSessions = checkpoints?.sessions.slice(0, 3) ?? [];
  const shownLiveOnly = liveOnly?.sessions.slice(0, 3) ?? [];

  // Localized reading-path facts; raw text collected for the technical fold.
  const consentReason = row.consent.reason !== undefined
    ? presentIngestionReason(row.consent.reason, t as TranslateFn)
    : null;
  const consentNextAction = presentConsentNextAction(row.consent.state, row.consent.nextAction, t as TranslateFn);
  const checkpointsPresented = checkpointsDegraded !== null
    ? presentDegradedSection(checkpointsDegraded, t as TranslateFn)
    : null;
  const liveOnlyPresented = liveOnlyDegraded !== null
    ? presentDegradedSection(liveOnlyDegraded, t as TranslateFn)
    : null;
  const lagReason = checkpoints?.lagUndetectable
    ? presentIngestionReason(checkpoints.lagUndetectableReason ?? 'lag_undeterminable', t as TranslateFn)
    : null;

  const technical: { label: string; value: string }[] = [];
  for (const flag of unknownFlags) {
    if (flag.reason !== undefined) technical.push({ label: t('pages.ingestionStatus.flagDiagnostics'), value: flag.reason });
    if (flag.nextAction !== undefined) technical.push({ label: t('pages.ingestionStatus.nextAction'), value: flag.nextAction });
  }
  if (consentReason?.technical) technical.push({ label: t('pages.ingestionStatus.reason'), value: consentReason.technical });
  if (consentNextAction?.technical) technical.push({ label: t('pages.ingestionStatus.nextAction'), value: consentNextAction.technical });
  if (lagReason?.technical) technical.push({ label: t('pages.ingestionStatus.lagUndetectableReason'), value: lagReason.technical });
  if (checkpointsPresented !== null) {
    if (checkpointsPresented.reason.technical) technical.push({ label: t('pages.ingestionStatus.checkpoints'), value: checkpointsPresented.reason.technical });
    if (checkpointsPresented.nextAction.technical) technical.push({ label: t('pages.ingestionStatus.nextAction'), value: checkpointsPresented.nextAction.technical });
  }
  if (liveOnlyPresented !== null) {
    if (liveOnlyPresented.reason.technical) technical.push({ label: t('pages.ingestionStatus.liveOnly'), value: liveOnlyPresented.reason.technical });
    if (liveOnlyPresented.nextAction.technical) technical.push({ label: t('pages.ingestionStatus.nextAction'), value: liveOnlyPresented.nextAction.technical });
  }
  if (checkpoints !== null) {
    for (const session of shownSessions) {
      technical.push({ label: t('pages.ingestionStatus.sessionDetail'), value: session.rolloutIdentity });
    }
  }

  return (
    <div className="rounded-lg border border-line-2 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-ink-1">{t(`pages.ingestionStatus.host.${host}`)}</h3>
        <StatusChip state={row.ingestionFlag.state} />
      </div>
      <SummaryLine label={t('pages.ingestionStatus.hostFlag')} value={t(`pages.ingestionStatus.flag.${row.hostFlag.state}`)} />
      <SummaryLine label={t('pages.ingestionStatus.consent')} value={t(`pages.ingestionStatus.consentState.${row.consent.state}`, { defaultValue: row.consent.state })} />
      {unknownFlags.map((flag, index) => (
        <div key={`flag-diagnostic-${index}`} className="text-sm text-amber space-y-1">
          {flag.reason !== undefined && (
            <AttentionLine label={t('pages.ingestionStatus.flagDiagnostics')} presented={presentIngestionReason(flag.reason, t as TranslateFn)} />
          )}
          {flag.nextAction !== undefined && (
            <AttentionLine label={t('pages.ingestionStatus.nextAction')} presented={presentIngestionNextAction(flag.nextAction, t as TranslateFn)} />
          )}
        </div>
      ))}
      {checkpoints !== null ? (
        <>
          <SummaryLine
            label={t('pages.ingestionStatus.checkpoints')}
            value={t('pages.ingestionStatus.checkpointSummary', {
              defaultValue: '{{total}} sessions · offset {{offset}} · lag {{lag}}',
              total: String(checkpoints.total),
              offset: checkpoints.checkpointOffset === null ? '—' : String(checkpoints.checkpointOffset),
              // "undetectable" is a DIFFERENT fact from "no lag" — never render
              // a null lag as a neutral dash (rc-9, PR #2563 review).
              lag: checkpoints.lagBytes === null
                ? (checkpoints.lagUndetectable ? t('pages.ingestionStatus.lagUndetectable') : '—')
                : String(checkpoints.lagBytes),
            })}
          />
          {checkpoints.lagUndetectable && lagReason !== null && (
            <>
              <AttentionLine label={t('pages.ingestionStatus.lagUndetectableReason')} presented={lagReason} />
              <AttentionLine
                label={t('pages.ingestionStatus.nextAction')}
                presented={{ text: t('pages.ingestionStatus.lagUndetectableHint'), technical: null }}
              />
            </>
          )}
          <SummaryLine label={t('pages.ingestionStatus.lastSuccess')} value={checkpoints.lastSuccessAt === null ? '—' : formatTime(checkpoints.lastSuccessAt)} />
          {checkpoints.lastDegradation !== null && (
            <AttentionLine
              label={t('pages.ingestionStatus.lastDegradation')}
              presented={presentIngestionReason(checkpoints.lastDegradation.reason, t as TranslateFn)}
            />
          )}
          {checkpoints.incompleteTailCount > 0 && (
            <SummaryLine label={t('pages.ingestionStatus.incompleteTail')} value={String(checkpoints.incompleteTailCount)} />
          )}
          {shownSessions.length > 0 && (
            <div className="text-sm">
              <span className="text-ink-3 block">{t('pages.ingestionStatus.sessionDetail')}</span>
              {shownSessions.map((session) => (
                <div key={session.rolloutIdentity} className="text-ink-2">
                  <span className="break-all" title={session.rolloutIdentity}>{shortIdentifier(session.rolloutIdentity)}</span>
                  <span className="block">
                    {t('pages.ingestionStatus.sessionLag', {
                      offset: String(session.byteOffset),
                      lag: session.lagBytes === null ? '—' : String(session.lagBytes),
                    })}
                    {session.incompleteTail ? ` · ${t('pages.ingestionStatus.incompleteTail')}` : ''}
                    {session.lastDegradationReason !== null
                      ? ` · ${presentIngestionReason(session.lastDegradationReason, t as TranslateFn).text}`
                      : ''}
                  </span>
                </div>
              ))}
              {checkpoints.total > shownSessions.length && (
                <span className="text-ink-3">
                  {t('pages.ingestionStatus.moreSessions', { count: String(checkpoints.total - shownSessions.length) })}
                </span>
              )}
            </div>
          )}
        </>
      ) : (
        checkpointsPresented !== null && (
          <>
            <SummaryLine
              label={t('pages.ingestionStatus.checkpoints')}
              value={`${t('pages.ingestionStatus.degraded')} — ${checkpointsPresented.reason.text}`}
            />
            <AttentionLine label={t('pages.ingestionStatus.nextAction')} presented={checkpointsPresented.nextAction} />
          </>
        )
      )}
      {liveOnly !== null ? (
        <>
          <SummaryLine
            label={t('pages.ingestionStatus.liveOnly')}
            value={t('pages.ingestionStatus.liveOnlySummary', {
              defaultValue: '{{count}} sessions{{suffix}}',
              count: String(liveOnly.sessions.length),
              suffix: liveOnly.truncated ? '+' : '',
            })}
          />
          {shownLiveOnly.length > 0 && (
            <div className="text-sm">
              {shownLiveOnly.map((session) => (
                <div key={session.rolloutIdentity} className="text-ink-2 break-all" title={session.rolloutIdentity}>
                  {shortIdentifier(session.rolloutIdentity)} · {formatTime(session.lastObservedAt)} · {session.observationCount}
                </div>
              ))}
              {liveOnly.sessions.length > shownLiveOnly.length && (
                <span className="text-ink-3">
                  {t('pages.ingestionStatus.moreSessions', { count: String(liveOnly.sessions.length - shownLiveOnly.length) })}
                </span>
              )}
              {liveOnly.truncated && (
                <span className="text-ink-3 block">{t('pages.ingestionStatus.beyondStoreLimit')}</span>
              )}
            </div>
          )}
        </>
      ) : (
        liveOnlyPresented !== null && (
          <>
            <SummaryLine
              label={t('pages.ingestionStatus.liveOnly')}
              value={`${t('pages.ingestionStatus.degraded')} — ${liveOnlyPresented.reason.text}`}
            />
            <AttentionLine label={t('pages.ingestionStatus.nextAction')} presented={liveOnlyPresented.nextAction} />
          </>
        )
      )}
      {consentReason !== null && <AttentionLine label={t('pages.ingestionStatus.reason')} presented={consentReason} />}
      {consentNextAction !== null && <AttentionLine label={t('pages.ingestionStatus.nextAction')} presented={consentNextAction} />}
      {technical.length > 0 && (
        <TechnicalDetails testId={`ingestion-technical-${host}`}>
          {technical.map((entry, index) => (
            <TechnicalRow key={`tech-${index}`} label={entry.label} value={entry.value} />
          ))}
        </TechnicalDetails>
      )}
    </div>
  );
}

function NotWiredHostCard({ host, row }: { host: HostKey; row: IngestionNotWiredHostData }) {
  const { t } = useTranslation();
  const presented = presentNotWired(t as TranslateFn, row);
  return (
    <div className="rounded-lg border border-dashed border-line-2 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-ink-1">{t(`pages.ingestionStatus.host.${host}`)}</h3>
        <span className="inline-flex items-center gap-1 text-sm text-ink-3">
          <CircleDashed size={14} aria-hidden />
          {t('pages.ingestionStatus.notWired')}
        </span>
      </div>
      <p className="text-sm text-ink-3">{presented.reason.text}</p>
      <p className="text-sm text-ink-2">{t('pages.ingestionStatus.nextAction')}: {presented.nextAction.text}</p>
      <TechnicalDetails testId={`ingestion-technical-${host}`}>
        <TechnicalRow label={t('pages.ingestionStatus.reason')} value={presented.reason.technical ?? ''} />
        <TechnicalRow label={t('pages.ingestionStatus.nextAction')} value={presented.nextAction.technical ?? ''} />
      </TechnicalDetails>
    </div>
  );
}

export function IngestionStatusPage() {
  const { t, i18n } = useTranslation();
  const [result, setResult] = useState<IngestionHealthResultData | null>(null);
  const [loading, setLoading] = useState(true);

  // Refresh is FORCED (bypasses the server's 5-minute cache); the initial
  // mount uses the cache. Without this the Refresh button only re-rendered a
  // stale snapshot (PR #2563 review).
  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    const response = await fetchIngestionHealth(forceRefresh);
    setResult(response.success ? response.data : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hosts: HostKey[] = ['codex', 'workbuddy', 'openclaw'];

  return (
    <PageShell width="dashboard">
      <div className="flex items-center justify-between">
        <div>
          <SectionTitle id="section-ingestion-status">{t('pages.ingestionStatus.title')}</SectionTitle>
          <p className="text-sm text-ink-3 mt-1">{t('pages.ingestionStatus.description')}</p>
          {result?.status === 'ok' && result.generatedAt !== undefined && (
            <p className="text-xs text-ink-3 mt-1">{t('pages.ingestionStatus.generatedAt')}: {formatDate(result.generatedAt, i18n.language)}</p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={loading} aria-label={t('pages.ingestionStatus.refresh')}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden />
        </Button>
      </div>
      {loading && result === null ? (
        <PageLoading cardCount={3} label={t('common.loading')} />
      ) : result === null ? (
        <p className="text-sm text-ink-3">{t('pages.ingestionStatus.unreachable')}</p>
      ) : result.status === 'unknown' ? (
        <div className="rounded-lg border border-amber/40 bg-amber/5 p-4 space-y-2">
          <p className="text-sm text-amber">{presentIngestionReason(result.reason ?? '', t as TranslateFn).text}</p>
          <p className="text-sm text-ink-2">
            {t('pages.ingestionStatus.nextAction')}: {result.nextAction !== undefined ? presentIngestionNextAction(result.nextAction, t as TranslateFn).text : '—'}
          </p>
          {(result.reason !== undefined || result.nextAction !== undefined) && (
            <TechnicalDetails testId="ingestion-technical-collection">
              {result.reason !== undefined && <TechnicalRow label={t('pages.ingestionStatus.reason')} value={result.reason} />}
              {result.nextAction !== undefined && <TechnicalRow label={t('pages.ingestionStatus.nextAction')} value={result.nextAction} />}
            </TechnicalDetails>
          )}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 mt-4">
          {hosts.map((host) => {
            const row = result.ingestion?.[host];
            if (row === undefined) return null;
            return row.status === 'monitored'
              ? <MonitoredHostCard key={host} host={host} row={row} />
              : <div key={host} className="lg:col-span-2"><NotWiredHostCard host={host} row={row} /></div>;
          })}
        </div>
      )}
    </PageShell>
  );
}
