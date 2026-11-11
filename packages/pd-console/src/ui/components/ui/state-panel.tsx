import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CircleHelp, Inbox, Loader2, ShieldQuestion, WifiOff } from 'lucide-react';

/**
 * StatePanel — the single presentation for "nothing here / cannot reach / not
 * signed in / partially degraded / still working".
 *
 * SPEC-PD-UIUX-002 §7 (1D 三态统一). Before this component each page invented
 * its own empty and failure copy: one printed an English sentence, another
 * silently redirected to the login page, a third showed a skeleton for five
 * seconds with no explanation.
 *
 * The rule set the variants encode:
 * - empty / first-run are NOT alarms — neutral colour, one next step.
 * - auth is actionable, not an error — navy, links to settings/login.
 * - unreachable is the only blocking state — red, with retry.
 * - degraded says what still works, amber, never red.
 * - slow appears only after 2s and says what is being checked.
 */

export type StateKind = 'empty' | 'first-run' | 'auth' | 'unreachable' | 'degraded' | 'slow';

export interface StateAction {
  label: string;
  to?: string;
  onClick?: () => void;
}

export interface StatePanelProps {
  kind: StateKind;
  title: string;
  body?: ReactNode;
  action?: StateAction;
  secondaryAction?: StateAction;
  /** Machine text (error code, command) kept in a disclosure, never in the reading path. */
  technical?: string;
  technicalLabel?: string;
  testId?: string;
}

const PRESENTATION: Record<StateKind, { icon: typeof Inbox; className: string; iconClassName: string }> = {
  empty: { icon: Inbox, className: 'border-line bg-panel text-ink-2', iconClassName: 'text-ink-4' },
  'first-run': { icon: CircleHelp, className: 'border-line bg-panel text-ink-2', iconClassName: 'text-gov' },
  auth: { icon: ShieldQuestion, className: 'border-gov/30 bg-gov/5 text-ink-2', iconClassName: 'text-gov' },
  unreachable: { icon: WifiOff, className: 'border-danger/30 bg-danger/5 text-ink', iconClassName: 'text-danger' },
  degraded: { icon: AlertTriangle, className: 'border-amber/30 bg-amber/5 text-ink-2', iconClassName: 'text-amber' },
  slow: { icon: Loader2, className: 'border-line bg-panel text-ink-2', iconClassName: 'text-ink-3' },
};

function ActionButton({ action, primary }: { action: StateAction; primary: boolean }) {
  const className = primary
    ? 'inline-flex min-h-8 items-center rounded-[4px] border border-gov bg-gov px-3 py-1.5 text-[13px] text-paper hover:bg-gov-2'
    : 'inline-flex min-h-8 items-center text-[13px] text-gov underline underline-offset-4';
  if (action.to) {
    return <Link to={action.to} className={className}>{action.label}</Link>;
  }
  return <button type="button" onClick={action.onClick} className={className}>{action.label}</button>;
}

export function StatePanel({ kind, title, body, action, secondaryAction, technical, technicalLabel, testId }: StatePanelProps) {
  const { t } = useTranslation();
  const { icon: Icon, className, iconClassName } = PRESENTATION[kind];
  return (
    <div
      role={kind === 'unreachable' ? 'alert' : 'status'}
      data-state-panel={kind}
      data-testid={testId}
      className={`flex gap-3 rounded-[8px] border px-4 py-4 ${className}`}
    >
      <Icon aria-hidden="true" strokeWidth={1.75} className={`mt-0.5 h-4 w-4 shrink-0 ${iconClassName} ${kind === 'slow' ? 'animate-spin' : ''}`} />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium leading-relaxed text-ink">{title}</p>
        {body !== undefined && <div className="mt-1 text-[13px] leading-relaxed text-ink-3">{body}</div>}
        {(action || secondaryAction) && (
          <div className="mt-3 flex flex-wrap items-center gap-4">
            {action && <ActionButton action={action} primary />}
            {secondaryAction && <ActionButton action={secondaryAction} primary={false} />}
          </div>
        )}
        {technical && (
          <details className="mt-3 text-[12px] text-ink-4">
            <summary className="cursor-pointer">{technicalLabel ?? t('components.statePanel.technical')}</summary>
            <p className="mt-2 break-all font-mono">{technical}</p>
          </details>
        )}
      </div>
    </div>
  );
}
