import { createHash } from 'node:crypto';
import { escapeXml } from '../../prompt-builder/xml-escape.js';
import { trimToBudget, renderPrinciplesToDirectives, type ActivatedPrinciple } from './prompt-activation-reader-contract.js';

export interface AdaptiveInterventionInput {
  nativeText: string;
  nativePrincipleIds?: string[];
  /** Existing host render with the target excluded, used on known revocation/revision change. */
  nativeWithoutTargetText: string;
  principles: ActivatedPrinciple[];
  target: { artifactId: string; activationId: string };
  /** Adapter must supply the current admitted user message, never history or composed prompt. */
  currentUserMessage?: string;
  currentUserMessageId?: string;
  requestId?: string;
  /** Operator-controlled single-turn evidence, never presented as a native message/request ID. */
  controlledAdmission?: { admissionId: string; inputSha256: string; manifestSha256: string };
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
  /** Re-read Runtime at the return boundary; false includes revision/authority changes. */
  revalidate: (target: ActivatedPrinciple, signal: AbortSignal) => Promise<boolean>;
  now: () => number;
}

export interface AdaptiveInterventionResult {
  text: string;
  reason: string;
  addedTarget: boolean;
  displacedActivationIds: string[];
  selectedPrincipleIds?: string[];
  targetBodySha256?: string;
}

export interface ControlledAdmissionBinding {
  controlledAdmission?: { admissionId: string; inputSha256: string; manifestSha256: string };
  currentUserMessage?: string;
  currentUserMessageId?: string;
  requestId?: string;
  sessionId?: string;
}

export type ControlledAdmissionBindingResult =
  | { ok: true; controlled: boolean }
  | { ok: false; reason: 'ambiguous_admission' | 'request_identity_unavailable' | 'scene_not_matched' };

/**
 * Shared admission gate for both the shared-provider and plugin-local entries.
 * Operator admission and native host identity must never coexist; an operator
 * admission proves the exact message bytes instead of a native message identity.
 */
export function validateControlledAdmissionBinding(input: ControlledAdmissionBinding): ControlledAdmissionBindingResult {
  const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const admission = input.controlledAdmission;
  if (admission && (input.currentUserMessageId !== undefined || input.requestId !== undefined)) {
    return { ok: false, reason: 'ambiguous_admission' };
  }
  const controlled = admission && nonempty(admission.admissionId)
    && /^[a-f0-9]{64}$/.test(admission.inputSha256) && /^[a-f0-9]{64}$/.test(admission.manifestSha256)
    && typeof input.currentUserMessage === 'string'
    && createHash('sha256').update(input.currentUserMessage, 'utf8').digest('hex') === admission.inputSha256;
  // Model-request identity belongs to later delivery evidence, not input admission.
  if (!nonempty(input.sessionId) || !(controlled || (!admission && nonempty(input.currentUserMessageId)))) {
    return { ok: false, reason: 'request_identity_unavailable' };
  }
  if (input.currentUserMessage?.split(/\r?\n/, 1)[0] !== '[PD-AA:delivery-review:v1]') {
    return { ok: false, reason: 'scene_not_matched' };
  }
  return { ok: true, controlled: Boolean(controlled) };
}

export interface AdaptiveMappingIdentity {
  workspaceRealPath: string;
  artifactId: string;
  activationId: string;
  softTimeoutMs: number;
  expiresAtMs: number;
}

/**
 * Canonical hash of the one workspace-scoped mapping an operator admission
 * authorizes. Fixed key order is part of the contract; both the plugin and the
 * experiment launcher must call this function rather than re-implement it.
 */
export function canonicalAdaptiveMappingSha256(mapping: AdaptiveMappingIdentity): string {
  return createHash('sha256').update(JSON.stringify({
    workspaceRealPath: mapping.workspaceRealPath,
    artifactId: mapping.artifactId,
    activationId: mapping.activationId,
    softTimeoutMs: mapping.softTimeoutMs,
    expiresAt: new Date(mapping.expiresAtMs).toISOString(),
  }), 'utf8').digest('hex');
}

/** One bounded intervention; no governance writes, model calls, caches or delivery assertions. */
export async function prepareAdaptiveIntervention(input: AdaptiveInterventionInput, deps: AdaptiveInterventionDeps): Promise<AdaptiveInterventionResult> {
  let excludeUncertainTarget = false;
  let targetPrincipleId: string | undefined;
  const fallback = (reason: string): AdaptiveInterventionResult => ({ text: excludeUncertainTarget ? input.nativeWithoutTargetText : input.nativeText, reason, addedTarget: false, displacedActivationIds: [],
    ...(input.nativePrincipleIds ? { selectedPrincipleIds: input.nativePrincipleIds.filter(id => !excludeUncertainTarget || id !== targetPrincipleId) } : {}) });
  try {
    const binding = validateControlledAdmissionBinding(input);
    if (!binding.ok) return fallback(binding.reason);
    const ids = input.principles.map(p => p.principleId);
    if (new Set(ids).size !== ids.length) return fallback('ambiguous_identity');
    const matches = input.principles.filter(p => p.artifactId === input.target.artifactId && p.activationId === input.target.activationId);
    if (matches.length !== 1) return fallback('target_unavailable');
    const [target] = matches;
    if (!target) return fallback('target_unavailable');
    targetPrincipleId = target.principleId;
    excludeUncertainTarget = true;
    if (!Number.isFinite(input.deadlineAt) || deps.now() >= input.deadlineAt) return fallback('deadline');
    if (!Number.isSafeInteger(input.selectionBudget) || input.selectionBudget < 0
      || (input.roundKey !== undefined && !Number.isSafeInteger(input.roundKey))) return fallback('invalid_budget');
    const rendered = renderPrinciplesToDirectives([target], new Set([target.principleId]), { escapeFn: escapeXml, selfReportInstruction: input.selfReportInstruction });
    const body = rendered.slice(rendered.indexOf('<directive '), rendered.indexOf('</directive>') + '</directive>'.length);
    const unchanged = input.nativeText.includes(body);
    let text = input.nativeText;
    let displacedActivationIds: string[] = [];
    let selectedPrincipleIds = input.nativePrincipleIds;
    if (!unchanged) {
      const n = input.principles.length;
      const start = input.roundKey === undefined ? 0 : ((input.roundKey % n) + n) % n;
      const ring = input.principles.slice(start).concat(input.principles.slice(0, start));
      const selected = trimToBudget([target, ...ring.filter(p => p !== target)], input.selectionBudget, escapeXml, 0);
      selectedPrincipleIds = [...selected.injectedIds];
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
    if (!validation) return fallback('target_changed');
    if (deps.now() >= input.deadlineAt) return fallback('deadline');
    return { text, reason: unchanged ? 'native_already_contains_target' : 'target_prioritized', addedTarget: !unchanged,
      ...(selectedPrincipleIds ? { selectedPrincipleIds } : {}),
      displacedActivationIds, targetBodySha256: createHash('sha256').update(body, 'utf8').digest('hex') };
  } catch { return fallback('dependency_failed'); }
}
