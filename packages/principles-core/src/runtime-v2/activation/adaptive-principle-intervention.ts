import { createHash } from 'node:crypto';
import { escapeXml } from '../../prompt-builder/xml-escape.js';
import { trimToBudget, renderPrinciplesToDirectives, type ActivatedPrinciple } from './prompt-activation-reader-contract.js';

export interface AdaptiveInterventionInput {
  nativeText: string;
  /** Existing host render with the target excluded, used on known revocation/revision change. */
  nativeWithoutTargetText: string;
  principles: ActivatedPrinciple[];
  target: { artifactId: string; activationId: string };
  /** Adapter must supply the current admitted user message, never history or composed prompt. */
  currentUserMessage?: string;
  currentUserMessageId?: string;
  requestId?: string;
  sessionId?: string;
  selectionBudget: number;
  roundKey?: number;
  mandatoryPrincipleIds: string[];
  selfReportInstruction: boolean;
  deadlineAt: number;
}

export interface AdaptiveInterventionDeps {
  /** Existing Native renderer and final size guard, including background/mandatory constraints. */
  renderAndGuard: (ids: Set<string>) => string;
  /** Re-read Runtime V2 at the return boundary; false includes revision/authority changes. */
  revalidate: (target: ActivatedPrinciple, signal: AbortSignal) => Promise<boolean>;
  now: () => number;
}

export interface AdaptiveInterventionResult {
  text: string;
  reason: string;
  addedTarget: boolean;
  displacedActivationIds: string[];
  targetBodySha256?: string;
}

/** One bounded intervention; no governance writes, model calls, caches or delivery assertions. */
export async function prepareAdaptiveIntervention(input: AdaptiveInterventionInput, deps: AdaptiveInterventionDeps): Promise<AdaptiveInterventionResult> {
  const fallback = (reason: string): AdaptiveInterventionResult => ({ text: input.nativeText, reason, addedTarget: false, displacedActivationIds: [] });
  try {
    if (![input.currentUserMessageId, input.requestId, input.sessionId].every(v => typeof v === 'string' && v.trim())) return fallback('request_identity_unavailable');
    if (input.currentUserMessage?.split(/\r?\n/, 1)[0] !== '[PD-AA:delivery-review:v1]') return fallback('scene_not_matched');
    if (!Number.isFinite(input.deadlineAt) || deps.now() >= input.deadlineAt) return fallback('deadline');
    if (!Number.isSafeInteger(input.selectionBudget) || input.selectionBudget < 0
      || (input.roundKey !== undefined && !Number.isSafeInteger(input.roundKey))) return fallback('invalid_budget');
    const ids = input.principles.map(p => p.principleId);
    if (new Set(ids).size !== ids.length) return fallback('ambiguous_identity');
    const matches = input.principles.filter(p => p.artifactId === input.target.artifactId && p.activationId === input.target.activationId);
    if (matches.length !== 1) return fallback('target_unavailable');
    const [target] = matches;
    if (!target) return fallback('target_unavailable');
    const rendered = renderPrinciplesToDirectives([target], new Set([target.principleId]), { escapeFn: escapeXml, selfReportInstruction: input.selfReportInstruction });
    const body = rendered.slice(rendered.indexOf('<directive '), rendered.indexOf('</directive>') + '</directive>'.length);
    const unchanged = input.nativeText.includes(body);
    let text = input.nativeText;
    let displacedActivationIds: string[] = [];
    if (!unchanged) {
      const n = input.principles.length;
      const start = input.roundKey === undefined ? 0 : ((input.roundKey % n) + n) % n;
      const ring = input.principles.slice(start).concat(input.principles.slice(0, start));
      const selected = trimToBudget([target, ...ring.filter(p => p !== target)], input.selectionBudget, escapeXml, 0);
      if (!selected.injectedIds.has(target.principleId)) return fallback('target_does_not_fit');
      if (input.mandatoryPrincipleIds.some(id => !selected.injectedIds.has(id))) return fallback('mandatory_constraint_displaced');
      text = deps.renderAndGuard(selected.injectedIds);
      if (!text.includes(body)) return fallback('final_target_incomplete');
      const native = trimToBudget(input.principles, input.selectionBudget, escapeXml, input.roundKey);
      displacedActivationIds = input.principles.filter(p => native.injectedIds.has(p.principleId) && !selected.injectedIds.has(p.principleId)).map(p => p.activationId);
    }
    if (deps.now() >= input.deadlineAt) return fallback('deadline');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let validation: boolean | 'deadline';
    try {
      validation = await Promise.race([
        deps.revalidate(target, controller.signal),
        new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), Math.min(input.deadlineAt - deps.now(), 2147483647)); }),
      ]);
    } finally { clearTimeout(timer); controller.abort(); }
    if (validation === 'deadline') return fallback('deadline');
    if (!validation) return { ...fallback('target_changed'), text: unchanged ? input.nativeWithoutTargetText : input.nativeText };
    if (deps.now() >= input.deadlineAt) return fallback('deadline');
    return { text, reason: unchanged ? 'native_already_contains_target' : 'target_prioritized', addedTarget: !unchanged,
      displacedActivationIds, targetBodySha256: createHash('sha256').update(body, 'utf8').digest('hex') };
  } catch { return fallback('dependency_failed'); }
}
