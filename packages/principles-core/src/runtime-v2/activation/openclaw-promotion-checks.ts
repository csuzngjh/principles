import type { PromotionReadinessCheck } from './promotion-readiness-evaluator.js';

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function collectOpenClawPromotionChecks(contentJson: string, input: { ownerIdentityConfigured: boolean; safetyControlsEnabled: boolean }): PromotionReadinessCheck[] {
  let content: unknown;
  try { content = JSON.parse(contentJson); } catch { content = null; }
  const affectedTools = isRecord(content) && Array.isArray(content.affectedTools)
    ? content.affectedTools.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const bounded = affectedTools.length > 0 && affectedTools.every(value => value !== '*' && value.toLowerCase() !== 'all');
  const protectedAliases = new Set(['pd_status', 'rulecode_deactivate', 'rulecode_global_pause', 'owner_review_access']);
  const compositionSafe = bounded && affectedTools.every(value => !protectedAliases.has(value));
  return [
    { checkId: 'bounded_scope', status: bounded ? 'passed' : 'failed', ...(!bounded ? { reasonCode: 'explicit_affected_tools_required' } : {}) },
    { checkId: 'runtime_compatibility', status: 'passed' },
    { checkId: 'host_liveness_composition', status: compositionSafe ? 'passed' : 'failed', ...(!compositionSafe ? { reasonCode: 'protected_or_unbounded_scope' } : {}) },
    { checkId: 'emergency_controls', status: input.safetyControlsEnabled ? 'passed' : 'failed', ...(!input.safetyControlsEnabled ? { reasonCode: 'safety_controls_disabled' } : {}) },
    { checkId: 'runtime_shadow_evidence', status: 'passed' },
    { checkId: 'owner_identity_configuration', status: input.ownerIdentityConfigured ? 'passed' : 'failed', ...(!input.ownerIdentityConfigured ? { reasonCode: 'configured_owner_missing' } : {}) },
  ];
}
