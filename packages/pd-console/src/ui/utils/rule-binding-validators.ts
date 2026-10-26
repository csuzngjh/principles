import type { RuleBindingReviewView, RuleBindingQueueView, RuleBindingQueueItem, RuleBindingBoundPrincipleView } from '../../shared/rule-candidate-binding-contract.js';
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function stringOrNull(value: unknown): value is string | null { return value === null || typeof value === 'string'; }

function validatePainSource(value: unknown): RuleBindingQueueItem['pain'] | null {
  if (!record(value) || typeof value.painId !== 'string' || !stringOrNull(value.text)
    || typeof value.source !== 'string' || !stringOrNull(value.createdAt)) return null;
  return { painId: value.painId, text: value.text, source: value.source, createdAt: value.createdAt };
}

const GENERATION_STAGES = ['not_built', 'in_progress', 'blocked', 'advanced', 'ambiguous'] as const;
type GenerationStage = (typeof GENERATION_STAGES)[number];
function isGenerationStage(value: unknown): value is GenerationStage {
  return typeof value === 'string' && (GENERATION_STAGES as readonly string[]).includes(value);
}

/** null = legitimately absent (unlinked row); 'invalid' = malformed row. */
function validateGeneration(value: unknown): RuleBindingQueueItem['generation'] | 'invalid' {
  if (value === null) return null;
  if (!record(value) || !isGenerationStage(value.stage) || !stringOrNull(value.stageKind)
    || !stringOrNull(value.reasonCode) || !stringOrNull(value.detail)) return 'invalid';
  // A blocked generation names the stage it stopped at; reasonCode may be
  // null for legacy tasks without humanReviewContext.
  return { stage: value.stage, stageKind: value.stageKind, reasonCode: value.reasonCode, detail: value.detail };
}

function validateResume(value: unknown): RuleBindingQueueItem['resume'] | 'invalid' {
  if (value === null) return null;
  if (!record(value) || (value.status !== 'ready' && value.status !== 'refused')
    || !stringOrNull(value.reason) || !stringOrNull(value.scribeTaskId)
    || !(value.taskRevisionEpoch === null || integer(value.taskRevisionEpoch))) return 'invalid';
  return { status: value.status, reason: value.reason, scribeTaskId: value.scribeTaskId, taskRevisionEpoch: value.taskRevisionEpoch };
}

function validateBinding(value: unknown): RuleBindingQueueItem['binding'] | null {
  if (!record(value)) return null;
  if (value.status === 'unlinked') return { status: 'unlinked' };
  if (value.status === 'binding_revoked') return { status: 'binding_revoked' };
  if (value.status === 'attention' && typeof value.reason === 'string') return { status: 'attention', reason: value.reason };
  if (value.status === 'bound' && record(value.principle) && typeof value.principle.principleId === 'string'
    && typeof value.principle.text === 'string' && typeof value.principle.status === 'string'
    && integer(value.principle.version) && integer(value.principle.revision) && typeof value.principle.decidedAt === 'string') {
    const principle: RuleBindingBoundPrincipleView = {
      principleId: value.principle.principleId, text: value.principle.text, status: value.principle.status,
      version: value.principle.version, revision: value.principle.revision, decidedAt: value.principle.decidedAt,
    };
    return { status: 'bound', principle };
  }
  return null;
}

export function validateBindingQueue(value: unknown): RuleBindingQueueView | null {
  if (!record(value) || !Array.isArray(value.items) || typeof value.truncated !== 'boolean'
    || !record(value.summary) || !integer(value.summary.painGroups) || !integer(value.summary.candidates)
    || !integer(value.summary.bound) || !integer(value.summary.unlinked) || !integer(value.summary.blocked)) return null;
  const items: RuleBindingQueueItem[] = [];
  const seen = new Set<string>();
  for (const item of value.items) {
    if (!record(item) || typeof item.candidateId !== 'string' || typeof item.text !== 'string'
      || typeof item.diagnosisStatus !== 'string') return null;
    // The queue contract is one entry per canonical candidate (PRI-1048);
    // a duplicated id means the response itself is malformed.
    if (seen.has(item.candidateId)) return null;
    seen.add(item.candidateId);
    const pain = validatePainSource(item.pain);
    const binding = validateBinding(item.binding);
    // Nullable projection fields must still be PRESENT keys (rc-3): an absent
    // generation/resume is a malformed row, not an unlinked row.
    const generation = validateGeneration(item.generation);
    const resume = validateResume(item.resume);
    if (!pain || !binding || generation === 'invalid' || resume === 'invalid'
      || !Object.hasOwn(item, 'generation') || !Object.hasOwn(item, 'resume')) return null;
    items.push({
      candidateId: item.candidateId, text: item.text, pain,
      diagnosisStatus: item.diagnosisStatus, binding,
      generation,
      resume,
    });
  }
  return {
    items,
    summary: {
      painGroups: value.summary.painGroups, candidates: value.summary.candidates,
      bound: value.summary.bound, unlinked: value.summary.unlinked, blocked: value.summary.blocked,
    },
    truncated: value.truncated,
  };
}

export function validateBindingReview(value: unknown): RuleBindingReviewView | null {
  if (!record(value) || typeof value.candidateId !== 'string' || typeof value.candidateText !== 'string'
    || typeof value.evidence !== 'string' || typeof value.candidateDigest !== 'string' || !integer(value.currentRevision)
    || typeof value.resumeNotice !== 'string' || !Array.isArray(value.eligibleTargets) || value.eligibleTargets.length > 20) return null;
  const sourcePain = validatePainSource(value.sourcePain);
  if (!sourcePain) return null;
  let currentBinding: RuleBindingReviewView['currentBinding'] = null;
  if (value.currentBinding !== null) {
    const b = value.currentBinding;
    if (!record(b) || (b.action !== 'bind' && b.action !== 'revoke') || typeof b.principleId !== 'string' || typeof b.reason !== 'string' || !integer(b.revision)) return null;
    currentBinding = { action: b.action, principleId: b.principleId, reason: b.reason, revision: b.revision };
  }
  let boundPrinciple: RuleBindingReviewView['boundPrinciple'] = null;
  if (value.boundPrinciple !== null) {
    if (!record(value.boundPrinciple) || typeof value.boundPrinciple.principleId !== 'string'
      || typeof value.boundPrinciple.text !== 'string' || typeof value.boundPrinciple.status !== 'string'
      || !integer(value.boundPrinciple.version) || !integer(value.boundPrinciple.revision)
      || typeof value.boundPrinciple.decidedAt !== 'string') return null;
    boundPrinciple = {
      principleId: value.boundPrinciple.principleId, text: value.boundPrinciple.text,
      status: value.boundPrinciple.status, version: value.boundPrinciple.version,
      revision: value.boundPrinciple.revision, decidedAt: value.boundPrinciple.decidedAt,
    };
  }
  const eligibleTargets: RuleBindingReviewView['eligibleTargets'] = [];
  for (const p of value.eligibleTargets) {
    if (!record(p) || typeof p.principleId !== 'string' || typeof p.text !== 'string' || typeof p.status !== 'string' || !integer(p.version) || typeof p.digest !== 'string') return null;
    eligibleTargets.push({ principleId: p.principleId, text: p.text, status: p.status, version: p.version, digest: p.digest });
  }
  if (!Object.hasOwn(value, 'generation') || !Object.hasOwn(value, 'resume')) return null;
  const generation = validateGeneration(value.generation);
  const resume = validateResume(value.resume);
  if (generation === 'invalid' || resume === 'invalid') return null;
  return {
    candidateId: value.candidateId, candidateText: value.candidateText, sourcePain,
    evidence: value.evidence, candidateDigest: value.candidateDigest, currentRevision: value.currentRevision,
    currentBinding, boundPrinciple, eligibleTargets,
    generation,
    resume,
    resumeNotice: value.resumeNotice,
  };
}
export function validateBindingMutation(value: unknown): { status: string; revisionStatus?: string; nextAction?: string } | null {
  if (!record(value) || !['bound', 'already_bound', 'revoked', 'already_revoked'].includes(String(value.status)) || typeof value.status !== 'string') return null;
  if (value.runtimeDeactivated !== false || value.inFlightOperationsMayComplete !== true) return null;
  if (value.nextAction !== undefined && typeof value.nextAction !== 'string') return null;
  if (value.revision !== undefined && (!record(value.revision) || typeof value.revision.status !== 'string')) return null;
  return { status: value.status, ...(record(value.revision) && typeof value.revision.status === 'string' ? { revisionStatus: value.revision.status } : {}),
    ...(typeof value.nextAction === 'string' ? { nextAction: value.nextAction } : {}) };
}
export function validateBindingRevise(value: unknown): { status: string; reason?: string; nextAction?: string } | null {
  if (!record(value) || typeof value.status !== 'string' || value.status.length === 0) return null;
  if (value.reason !== undefined && typeof value.reason !== 'string') return null;
  if (value.nextAction !== undefined && typeof value.nextAction !== 'string') return null;
  return { status: value.status, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}), ...(typeof value.nextAction === 'string' ? { nextAction: value.nextAction } : {}) };
}
