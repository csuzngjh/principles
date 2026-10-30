import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchOwnerDecisionView } from '../../api.js';
import type { OwnerDecisionViewCore, NarrativeField } from '@principles/core/runtime-v2';

export function ApprovalSubjectReading({ principleId, approvalId, artifactId, channel }: { principleId: string; approvalId: string; artifactId: string; channel: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<OwnerDecisionViewCore | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    setView(null); setError(''); setLoading(true);
    void fetchOwnerDecisionView(principleId).then(result => {
      if (!current) return;
      if (result.success) setView(result.data); else setError(result.error);
      setLoading(false);
    }).catch(() => { if (current) { setError(t('pages.focus.workbench.materialUnavailable')); setLoading(false); } });
    return () => { current = false; };
  }, [principleId, approvalId, artifactId, channel, t]);
  const subject = view?.decisionSubjects.find(item => item.revisionArtifactId.status === 'known' && item.revisionArtifactId.value === artifactId && item.channel === channel
    && item.targetRefs.some(ref => ref.id === approvalId && ref.kind === 'approval'));
  const narrative = (field: NarrativeField) => field.status === 'known' ? field.value.map(item => item.text).join('\n\n') : field.reason.ownerText;
  if (loading) return <p role="status" className="text-sm text-ink-3">{t('pages.focus.workbench.loading')}</p>;
  return <div className="space-y-7">
    <section><h3 className="mb-3 text-[15px] font-medium text-ink">{t('pages.focus.workbench.why')}</h3>
      <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{view ? narrative(view.incidentSummary) : t('pages.focus.workbench.materialUnavailable')}</p>
      {error && <p role="alert" className="mt-2 text-[12.5px] text-amber">{error}</p>}
    </section>
    <section><h3 className="mb-3 text-[15px] font-medium text-ink">{t('pages.focus.workbench.proposal')}</h3>
      <div className="whitespace-pre-wrap text-[15px] leading-[1.85] text-ink">{subject ? narrative(subject.decisionMaterial.learnedPrinciple) : t('pages.focus.workbench.exactMaterialMissing')}</div>
      {subject && <details className="mt-4 text-[13px] leading-relaxed text-ink-3"><summary className="cursor-pointer text-gov">{t('pages.focus.workbench.reasonAndScope')}</summary>
        <p className="mt-3 whitespace-pre-wrap">{narrative(subject.decisionMaterial.rationale)}</p>
        <p className="mt-3 whitespace-pre-wrap">{narrative(subject.decisionMaterial.consequence)}</p>
      </details>}
    </section>
    <section className="border-t border-line pt-5"><h3 className="mb-3 text-[15px] font-medium text-ink">{t('pages.focus.workbench.decision')}</h3>
      <p className="text-[13px] leading-relaxed text-amber" data-testid="approval-version-lock">{t('pages.focus.workbench.versionLock')}</p>
      <Link className="mt-4 inline-block text-[13px] text-gov underline underline-offset-4" to={`/principles/${encodeURIComponent(principleId)}?from=focus`}>{t('pages.focus.workbench.openPrinciple')}</Link>
      <details className="mt-4 text-[12px] text-ink-4"><summary className="cursor-pointer">{t('pages.focus.workbench.subjectDetails')}</summary>
        <dl className="mt-2 break-all font-mono"><div>approval: {approvalId}</div><div>artifact: {artifactId}</div><div>channel: {channel}</div></dl>
      </details>
    </section>
  </div>;
}
