import { createHash } from 'node:crypto';
import { deriveArtifactSummary, type SummaryRunnerKind } from './artifact-summary.js';
import {
  collectOwnerDecisionFacts,
  computeArtifactContentHash,
  deriveOwnerDecisionCapability,
  type DecisionArtifactRecord,
  type OwnerDecisionFactStore,
} from './owner-review.js';
import type { OwnerResolutionAction } from './pitask-metadata.js';

const MAX_TEXT = 600;
const MAX_ITEMS = 3;
const MAX_LINEAGE_ARTIFACTS = 16;

export type DeterministicCheckStatus = 'passed' | 'failed' | 'not_run' | 'unavailable';
export type ReviewEvidenceCompleteness = 'complete' | 'partial' | 'insufficient';
export type EvidenceClass =
  | 'deterministic_check'
  | 'runtime_observation'
  | 'automated_review'
  | 'declared_case'
  | 'provenance';

export interface OwnerDecisionReviewStore extends OwnerDecisionFactStore {
  getArtifactById(artifactId: string): Promise<DecisionArtifactRecord | null>;
}

export interface OwnerEvidenceItem {
  readonly evidenceClass: EvidenceClass;
  readonly label: string;
  readonly value: string;
}

export interface BoundEvidenceManifestV1 {
  readonly schemaVersion: 'owner-review-evidence-v1';
  readonly digestAlgorithm: 'sha256';
  readonly sources: readonly {
    readonly role: 'decision' | 'scribe' | 'artificer' | 'evaluator' | 'rollout';
    readonly stableId: string;
    readonly contentHash: string;
  }[];
  readonly semanticFacts: {
    readonly completeness: ReviewEvidenceCompleteness;
    readonly deterministicStatuses: readonly {
      readonly check: string;
      readonly status: DeterministicCheckStatus;
    }[];
    readonly offeredActions: readonly OwnerResolutionAction[];
    readonly acceptRequirement: string;
    readonly briefSemanticHash: string;
  };
}

export interface EvaluatorDecisionBrief {
  readonly kind: 'evaluator';
  readonly principle: {
    readonly title?: string;
    readonly statement?: string;
    readonly rationale?: string;
    readonly scope: readonly string[];
  };
  readonly implementation: {
    readonly summary?: string;
    readonly affectedTools: readonly string[];
    readonly risks: readonly string[];
  };
  readonly strengths: readonly string[];
  readonly concerns: readonly string[];
  readonly requiredChanges: readonly string[];
  readonly score?: number;
}

export interface RolloutDecisionBrief {
  readonly kind: 'rollout';
  readonly summary?: string;
  readonly requiredChanges: readonly string[];
  readonly risks: readonly string[];
}

export type OwnerDecisionBrief = EvaluatorDecisionBrief | RolloutDecisionBrief;

export interface OwnerDecisionReviewSnapshot {
  readonly schemaVersion: 'owner-decision-review-v1';
  readonly reviewKey: string;
  readonly taskId: string;
  readonly kind: 'evaluator' | 'rollout';
  readonly brief: OwnerDecisionBrief;
  readonly evidence: {
    readonly completeness: ReviewEvidenceCompleteness;
    readonly deterministicChecks: readonly {
      readonly check: string;
      readonly status: DeterministicCheckStatus;
    }[];
    readonly items: readonly OwnerEvidenceItem[];
    readonly manifest: BoundEvidenceManifestV1;
    readonly digest: string;
  };
  readonly capability: {
    readonly baseAllowedActions: readonly OwnerResolutionAction[];
    readonly finalOfferedActions: readonly OwnerResolutionAction[];
    readonly acceptRequirement:
      | { readonly kind: 'none' }
      | { readonly kind: 'acknowledge_partial_evidence' }
      | { readonly kind: 'forbidden'; readonly reasonCode: string };
  };
  readonly staleBinding: {
    readonly expectedRevisionEpoch: number;
    readonly expectedSourceRunId: string;
    readonly expectedSourceArtifactId: string;
    readonly expectedSourceArtifactHash: string;
    readonly expectedEvidenceDigest: string;
  };
  readonly reasonCode: string;
  readonly legacy: boolean;
  readonly createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(contentJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(contentJson);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clamp(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= MAX_TEXT ? trimmed : `${trimmed.slice(0, MAX_TEXT - 1)}…`;
}

function readRecord(source: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  return isRecord(source[key]) ? source[key] : null;
}

function readString(source: unknown, key: string): string | undefined {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? clamp(value) : undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(source: unknown, key: string, max = MAX_ITEMS): readonly string[] {
  if (!isRecord(source) || !Object.hasOwn(source, key) || !Array.isArray(source[key])) return [];
  return source[key]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .slice(0, max)
    .map(clamp);
}

function deterministicStatus(content: Record<string, unknown> | null): DeterministicCheckStatus {
  if (content === null) return 'unavailable';
  if (!Object.hasOwn(content, 'adversarialResult')) return 'not_run';
  const result = content.adversarialResult;
  if (!isRecord(result) || !Object.hasOwn(result, 'passed')) return 'unavailable';
  if (result.passed === true) return 'passed';
  if (result.passed === false) return 'failed';
  return 'unavailable';
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
  return result;
}

function hashSemantic(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value)), 'utf8').digest('hex');
}

async function collectCanonicalArtifacts(
  store: OwnerDecisionReviewStore,
  decision: DecisionArtifactRecord,
): Promise<readonly { artifact: DecisionArtifactRecord; taskKind: string }[]> {
  const collected: { artifact: DecisionArtifactRecord; taskKind: string }[] = [];
  const seen = new Set<string>([decision.artifactId]);
  const queue = [...(decision.lineageArtifactIds ?? [])];
  while (queue.length > 0 && collected.length < MAX_LINEAGE_ARTIFACTS) {
    const artifactId = queue.shift();
    if (artifactId === undefined || seen.has(artifactId)) continue;
    seen.add(artifactId);
    const artifact = await store.getArtifactById(artifactId).catch(() => null);
    if (!artifact) continue;
    const task = artifact.sourceTaskId
      ? await store.getTask(artifact.sourceTaskId).catch(() => null)
      : null;
    collected.push({ artifact, taskKind: task?.taskKind ?? 'unknown' });
    for (const parent of artifact.lineageArtifactIds ?? []) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return collected;
}

async function legacyArtifact(
  store: OwnerDecisionReviewStore,
  content: Record<string, unknown> | null,
  key: 'artificerArtifactId' | 'scribeArtifactId',
): Promise<DecisionArtifactRecord | null> {
  const sourceTrace = readRecord(content, 'sourceTrace');
  const id = readString(sourceTrace, key);
  return id ? store.getArtifactById(id).catch(() => null) : null;
}

function summaryFor(
  taskKind: SummaryRunnerKind,
  artifact: DecisionArtifactRecord | null,
): ReturnType<typeof deriveArtifactSummary> | null {
  if (!artifact) return null;
  const content = parseRecord(artifact.contentJson);
  return content === null ? null : deriveArtifactSummary(taskKind, content);
}

function sourceEntry(
  role: BoundEvidenceManifestV1['sources'][number]['role'],
  artifact: DecisionArtifactRecord,
): BoundEvidenceManifestV1['sources'][number] {
  return {
    role,
    stableId: artifact.artifactId,
    contentHash: computeArtifactContentHash(artifact.contentJson),
  };
}

export async function buildOwnerDecisionReview(
  store: OwnerDecisionReviewStore,
  taskId: string,
): Promise<OwnerDecisionReviewSnapshot | null> {
  const facts = await collectOwnerDecisionFacts(store, taskId);
  if (!facts) return null;
  const capability = deriveOwnerDecisionCapability(facts);
  if (!capability.eligible || !capability.reviewKey || !facts.decisionArtifact) return null;

  const listed = await store.listArtifactsBySourceTask(taskId).catch(() => []);
  const decision = listed.find((entry) => entry.artifactId === facts.decisionArtifact?.artifactId)
    ?? await store.getArtifactById(facts.decisionArtifact.artifactId).catch(() => null);
  if (!decision) return null;
  const decisionContent = parseRecord(decision.contentJson);
  const canonical = await collectCanonicalArtifacts(store, decision);
  let artificer = canonical.find((entry) => entry.taskKind === 'artificer')?.artifact ?? null;
  let scribe = canonical.find((entry) => entry.taskKind === 'scribe')?.artifact ?? null;
  if (!artificer) artificer = await legacyArtifact(store, decisionContent, 'artificerArtifactId');
  if (!scribe) scribe = await legacyArtifact(store, decisionContent, 'scribeArtifactId');
  if (!scribe && artificer) {
    const lineage = await collectCanonicalArtifacts(store, artificer);
    scribe = lineage.find((entry) => entry.taskKind === 'scribe')?.artifact ?? null;
  }

  const checkStatus = deterministicStatus(decisionContent);
  const deterministicChecks = [{ check: 'adversarial_hard_gate', status: checkStatus }] as const;
  const evaluation = readRecord(decisionContent, 'evaluation');
  const sourceRunId = facts.task.humanReviewContext?.sourceRunId
    ?? facts.task.completionIntent?.sourceRunId ?? '';

  let brief: OwnerDecisionBrief;
  let completeness: ReviewEvidenceCompleteness;
  if (facts.task.taskKind === 'evaluator') {
    const scribeContent = scribe ? parseRecord(scribe.contentJson) : null;
    const draft = readRecord(scribeContent, 'principleDraft');
    const artificerContent = artificer ? parseRecord(artificer.contentJson) : null;
    const scribeSummary = summaryFor('scribe', scribe);
    const artificerSummary = summaryFor('artificer', artificer);
    const principleStatement = scribeSummary?.ok
      ? scribeSummary.value.fields.principleText
      : readString(draft, 'statement');
    const implementationSummary = artificerSummary?.ok
      ? artificerSummary.value.fields.apiSurface
      : readString(artificerContent, 'implementationSummary');
    const affectedTools = readStringArray(artificerContent, 'affectedTools', 20);
    const concerns = readStringArray(evaluation, 'concerns');
    const requiredChanges = readStringArray(evaluation, 'requiredChanges');
    brief = {
      kind: 'evaluator',
      principle: {
        ...(readString(draft, 'title') ? { title: readString(draft, 'title') } : {}),
        ...(principleStatement ? { statement: principleStatement } : {}),
        ...(readString(draft, 'rationale') ? { rationale: readString(draft, 'rationale') } : {}),
        scope: readStringArray(draft, 'applicability', 10),
      },
      implementation: {
        ...(implementationSummary ? { summary: implementationSummary } : {}),
        affectedTools,
        risks: readStringArray(artificerContent, 'risks'),
      },
      strengths: readStringArray(evaluation, 'strengths'),
      concerns,
      requiredChanges,
      ...(readNumber(evaluation, 'score') !== undefined ? { score: readNumber(evaluation, 'score') } : {}),
    };
    const identifiable = Boolean(principleStatement || implementationSummary || affectedTools.length > 0);
    completeness = principleStatement && (implementationSummary || affectedTools.length > 0)
      ? 'complete'
      : identifiable ? 'partial' : 'insufficient';
  } else {
    const review = readRecord(decisionContent, 'review');
    brief = {
      kind: 'rollout',
      ...(readString(review, 'summary') ? { summary: readString(review, 'summary') } : {}),
      requiredChanges: readStringArray(review, 'requiredChanges'),
      risks: [
        ...readStringArray(review, 'rolloutRisks'),
        ...readStringArray(decisionContent, 'risks'),
      ].slice(0, MAX_ITEMS),
    };
    completeness = brief.summary ? 'complete' : brief.requiredChanges.length > 0 ? 'partial' : 'insufficient';
  }

  const baseAllowedActions = [...capability.allowedActions];
  let finalOfferedActions = [...baseAllowedActions];
  let acceptRequirement: OwnerDecisionReviewSnapshot['capability']['acceptRequirement'] = { kind: 'none' };
  if (checkStatus === 'failed') {
    finalOfferedActions = finalOfferedActions.filter((action) => action !== 'accept_current');
    acceptRequirement = { kind: 'forbidden', reasonCode: 'adversarial_hard_gate_failed' };
  } else if (completeness === 'insufficient') {
    finalOfferedActions = finalOfferedActions.filter((action) => action !== 'accept_current');
    acceptRequirement = { kind: 'forbidden', reasonCode: 'review_evidence_insufficient' };
  } else if (completeness === 'partial' && finalOfferedActions.includes('accept_current')) {
    acceptRequirement = { kind: 'acknowledge_partial_evidence' };
  }

  const items: OwnerEvidenceItem[] = [];
  if (brief.kind === 'evaluator') {
    for (const value of brief.strengths) items.push({ evidenceClass: 'automated_review', label: 'strength', value });
    for (const value of brief.concerns) items.push({ evidenceClass: 'automated_review', label: 'concern', value });
  }
  items.push({
    evidenceClass: 'deterministic_check',
    label: 'adversarial_hard_gate',
    value: checkStatus,
  });

  const sources: BoundEvidenceManifestV1['sources'][number][] = [
    sourceEntry(facts.task.taskKind === 'evaluator' ? 'evaluator' : 'rollout', decision),
  ];
  if (artificer) sources.push(sourceEntry('artificer', artificer));
  if (scribe) sources.push(sourceEntry('scribe', scribe));
  const briefSemanticHash = hashSemantic(brief);
  const manifest: BoundEvidenceManifestV1 = {
    schemaVersion: 'owner-review-evidence-v1',
    digestAlgorithm: 'sha256',
    sources,
    semanticFacts: {
      completeness,
      deterministicStatuses: deterministicChecks,
      offeredActions: finalOfferedActions,
      acceptRequirement: acceptRequirement.kind,
      briefSemanticHash,
    },
  };
  const digest = hashSemantic(manifest);

  return {
    schemaVersion: 'owner-decision-review-v1',
    reviewKey: capability.reviewKey,
    taskId,
    kind: facts.task.taskKind === 'evaluator' ? 'evaluator' : 'rollout',
    brief,
    evidence: {
      completeness,
      deterministicChecks,
      items,
      manifest,
      digest,
    },
    capability: {
      baseAllowedActions,
      finalOfferedActions,
      acceptRequirement,
    },
    staleBinding: {
      expectedRevisionEpoch: facts.task.revisionCount ?? 0,
      expectedSourceRunId: sourceRunId,
      expectedSourceArtifactId: decision.artifactId,
      expectedSourceArtifactHash: facts.decisionArtifact.contentHash,
      expectedEvidenceDigest: digest,
    },
    reasonCode: capability.reasonCode,
    legacy: capability.legacy,
    createdAt: facts.task.updatedAt,
  };
}
