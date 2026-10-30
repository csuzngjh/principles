import { useEffect, useRef, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export interface OwnerWorkItem { key: string; title: string; kind: string; summary: string; reference?: string; content: ReactNode }

/** Presentation only: list grouping never changes an action's identity or authority. */
export function OwnerWorkbench({ items, completed, uncertain }: { items: OwnerWorkItem[]; completed: { key: string; message: string } | null; uncertain: boolean }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const selectedKey = params.get('review') ?? '';
  const selected = items.find(item => item.key === selectedKey);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLElement>(null);
  const lastSelected = useRef('');
  const listScroll = useRef(0);
  useEffect(() => {
    if (selectedKey) {
      heading.current?.focus({ preventScroll: true });
      if (heading.current && (heading.current.getBoundingClientRect().top < 0 || heading.current.getBoundingClientRect().bottom > window.innerHeight)) heading.current.scrollIntoView({ block: 'start' });
      const current = list.current?.querySelector<HTMLElement>('[aria-current="true"]');
      if (current && list.current && list.current.scrollHeight > list.current.clientHeight) {
        list.current.scrollTop = Math.max(0, current.offsetTop - list.current.offsetTop - 24);
      }
    } else if (lastSelected.current && list.current) {
      list.current.scrollTop = listScroll.current;
      const previous = Array.from(list.current.querySelectorAll<HTMLButtonElement>('[data-item-key]')).find(button => button.dataset.itemKey === lastSelected.current);
      previous?.focus({ preventScroll: true });
      if (previous && (previous.getBoundingClientRect().top < 0 || previous.getBoundingClientRect().bottom > window.innerHeight)) previous.scrollIntoView({ block: 'nearest' });
    } else list.current?.focus({ preventScroll: true });
  }, [selectedKey]);
  function choose(key: string) {
    if (!key && selectedKey) { lastSelected.current = selectedKey; listScroll.current = list.current?.scrollTop ?? 0; }
    const next = new URLSearchParams(params);
    if (key) next.set('review', key); else next.delete('review');
    setParams(next, { preventScrollReset: true });
  }
  const completedHere = completed?.key === selectedKey ? completed : null;
  const nextItem = items.find(item => item.key !== selectedKey);
  return <section className="owner-workbench" data-testid="owner-workbench">
    <nav ref={list} tabIndex={-1} className={`owner-work-list ${selected ? 'owner-work-list-selected' : ''}`} aria-label={t('pages.focus.workbench.list')}>
      <div className="mb-3 flex items-baseline justify-between gap-3"><h2 className="text-[15px] font-medium text-ink">{t('pages.focus.workbench.list')}</h2><span className="text-[12px] text-ink-4">{t('pages.focus.workbench.count', { count: items.length })}</span></div>
      {items.length === 0 && <p className="text-sm leading-relaxed text-ink-3">{t(uncertain ? 'pages.focus.workbench.uncertain' : 'pages.focus.workbench.empty')}</p>}
      <ol className="space-y-2">{items.map(item => <li key={item.key}><button type="button" onClick={() => choose(item.key)} aria-current={selected?.key === item.key ? 'true' : undefined}
        data-testid="owner-work-item" data-item-key={item.key} className={`w-full rounded-[6px] border px-4 py-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-gov ${selected?.key === item.key ? 'border-gov bg-gov/5' : 'border-line bg-panel hover:border-gov/50'}`}>
        <span className="mb-2 block text-[11px] text-ink-4">{item.kind}</span><span className="block text-[14px] font-medium leading-relaxed text-ink break-words">{item.title}</span>
        <span className="mt-2 block text-[12.5px] leading-relaxed text-ink-3 line-clamp-2">{item.summary}</span>
        {item.reference && items.some(other => other.key !== item.key && other.title === item.title && other.summary === item.summary) && <span className="mt-2 block break-all font-mono text-[11px] text-ink-4">{item.reference}</span>}
      </button></li>)}</ol>
    </nav>
    <div className="owner-work-reading min-w-0" data-testid="owner-work-reading">
      {selected ? <>
        <button type="button" className="mb-5 text-[13px] text-gov underline underline-offset-4" onClick={() => choose('')}>{t('pages.focus.workbench.back')}</button>
        <h2 ref={heading} tabIndex={-1} className="mb-6 text-[22px] font-semibold leading-snug text-ink break-words">{selected.title}</h2>
        <div key={selected.key}>{selected.content}</div>
        <footer className="mt-7 border-t border-line pt-5"><p className="mb-3 text-[12.5px] text-ink-3">{t('pages.focus.workbench.readingEnd')}</p>
          {nextItem && <button type="button" className="text-[13px] text-gov underline underline-offset-4" onClick={() => choose(nextItem.key)}>{t('pages.focus.workbench.next')}</button>}
        </footer>
      </> : <div className="py-10 text-ink-3">
        <h2 ref={heading} tabIndex={-1} className="mb-3 text-[22px] font-medium text-ink">{t(completedHere ? 'pages.focus.workbench.completed' : selectedKey ? 'pages.focus.workbench.notCurrent' : 'pages.focus.workbench.startTitle')}</h2>
        <p role={completedHere ? 'status' : undefined} className="max-w-[440px] text-[14px] leading-relaxed">{completedHere?.message ?? t(selectedKey ? 'pages.focus.workbench.notCurrentBody' : 'pages.focus.workbench.startBody')}</p>
        {items[0] && <button type="button" className="mt-6 rounded-[4px] border border-gov bg-gov px-4 py-2.5 text-sm text-paper" onClick={() => choose(items[0]!.key)}>{t(completedHere ? 'pages.focus.workbench.next' : 'pages.focus.workbench.start')}</button>}
      </div>}
    </div>
  </section>;
}
