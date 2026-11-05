// Offline preparation only. The caller supplies Reader-qualified candidates.
// This neither authorizes principles nor changes the production prompt path.
import { trimToBudget, renderPrinciplesToDirectives } from '@principles/core/runtime-v2';
import { escapeXml } from '@principles/core/prompt-builder';

export function compareAdaptivePacking({ principles, target, selectionBudget, directiveBudget, roundKey }) {
  if (!Array.isArray(principles) || !Number.isSafeInteger(selectionBudget) || selectionBudget < 0
    || !Number.isSafeInteger(directiveBudget) || directiveBudget < 0
    || (roundKey !== undefined && !Number.isSafeInteger(roundKey))) throw new Error('invalid_packing_input');
  const ids = new Set();
  for (const p of principles) {
    if (!p || ['principleId', 'activationId', 'artifactId', 'text'].some(k => typeof p[k] !== 'string' || !p[k])
      || ids.has(p.principleId)) throw new Error('ambiguous_candidate_identity');
    ids.add(p.principleId);
  }
  const render = selected => renderPrinciplesToDirectives(principles, selected, { escapeFn: escapeXml, selfReportInstruction: false });
  const native = trimToBudget(principles, selectionBudget, escapeXml, roundKey);
  const baseline = render(native.injectedIds);
  const result = { preparationOnly: true, baseline, proposed: baseline, reason: 'target_unavailable',
    baselineRenderedChars: baseline.length, attemptedRenderedChars: null,
    addedTarget: false, displacedActivationIds: [], delivery: 'not_tested' };
  const matches = principles.filter(p => p.artifactId === target?.artifactId && p.activationId === target?.activationId);
  if (matches.length !== 1) return result;
  const candidate = matches[0];
  // Selection alone is insufficient: compare the complete rendered directive.
  const single = render(new Set([candidate.principleId]));
  const body = single.slice(single.indexOf('<directive '), single.indexOf('</directive>') + '</directive>'.length);
  if (baseline.includes(body)) return { ...result, reason: 'native_already_contains_target' };
  const start = roundKey === undefined || principles.length === 0 ? 0 : ((roundKey % principles.length) + principles.length) % principles.length;
  const ring = principles.slice(start).concat(principles.slice(0, start));
  const prioritized = [candidate, ...ring.filter(p => p !== candidate)];
  const selected = trimToBudget(prioritized, selectionBudget, escapeXml, 0);
  const proposed = render(selected.injectedIds);
  result.attemptedRenderedChars = proposed.length;
  if (!proposed.includes(body)) return { ...result, reason: 'target_does_not_fit' };
  if (proposed.length > directiveBudget) return { ...result, reason: 'rendered_budget_exceeded' };
  return { ...result, proposed, reason: 'target_prioritized', addedTarget: true,
    displacedActivationIds: principles.filter(p => native.injectedIds.has(p.principleId)
      && !selected.injectedIds.has(p.principleId)).map(p => p.activationId) };
}
