/**
 * PD_PROMPT_CAPACITY_V1 R-B3: prompt-channel version replacement support.
 *
 * Two focused capabilities over EXISTING authorities (no new store, no new
 * lifecycle states):
 * 1. `detectPromptReplacementTarget` — given the artifact an Owner just
 *    approved, find the live prompt activation of a PRIOR artifact version of
 *    the same principle (revision lineage via the existing
 *    `isArtifactRevisionOf` predicate). Ambiguity fails closed: more than one
 *    live match is an error the Owner resolves manually, never a guess and
 *    never a batch migration over history.
 * 2. `buildOwnerRevisionArtifact` — assemble the new artifact version for an
 *    Owner-submitted replacement statement: a clone of the approved scribe
 *    artifact with ONLY principleDraft.statement replaced, new lineage, new
 *    task identity (the (source_task_id, artifact_kind) unique index forbids
 *    same-task upsert — that would overwrite the old approved artifact), and
 *    validation through the REAL `DefaultScribeValidator` content contract —
 *    never a direct `validated` stamp.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ActivationStatusRecord, PIArtifactSnapshot } from './activation-types.js';
import { isArtifactRevisionOf } from './activation-types.js';
import { DefaultScribeValidator } from '../internalization/scribe-output.js';

export interface PromptReplacementTarget {
  supersededActivationId: string;
  supersededArtifactId: string;
}

export type PromptReplacementDetection =
  | { ok: true; target: PromptReplacementTarget | null }
  | { ok: false; error: string; nextAction: string };

/**
 * Find the single live prompt activation whose artifact is a prior version of
 * `approvalArtifactId`'s principle. Returns target=null when the approval is
 * not a revision of anything live (plain activation), and ok=false when more
 * than one live activation matches (manual resolution required).
 */
export async function detectPromptReplacementTarget(input: {
  approvalArtifactId: string;
  getArtifactById: (artifactId: string) => Promise<PIArtifactSnapshot | null>;
  listPromptActivations: () => Promise<ActivationStatusRecord[]>;
  includeHistoricalTargets?: boolean;
}): Promise<PromptReplacementDetection> {
  const approvalArtifact = await input.getArtifactById(input.approvalArtifactId);
  if (approvalArtifact === null) {
    return {
      ok: false,
      error: `approval_artifact_unreadable: ${input.approvalArtifactId}`,
      nextAction: 'check_pi_artifacts_table',
    };
  }
  const matches: PromptReplacementTarget[] = [];
  const activations = await input.listPromptActivations();
  for (const activation of activations) {
    if (activation.deactivatedAt !== null) continue;
    if (activation.artifactId === input.approvalArtifactId) continue;
    const artifact = await input.getArtifactById(activation.artifactId);
    if (artifact === null) continue;
    if (isArtifactRevisionOf(approvalArtifact, artifact)) {
      if (approvalArtifact.sourcePrincipleId && artifact.sourcePrincipleId
        && approvalArtifact.sourcePrincipleId !== artifact.sourcePrincipleId) {
        return { ok: false, error: 'prompt_replacement_source_principle_mismatch', nextAction: 'review the artifact lineage and source principle before approval' };
      }
      matches.push({ supersededActivationId: activation.activationId, supersededArtifactId: activation.artifactId });
    }
  }
  if (matches.length === 0 && input.includeHistoricalTargets === true) {
    // Recovery of an already live revision must bind the nearest explicit
    // lineage artifact, even when its old activation is now inactive.
    for (const artifactId of [...approvalArtifact.lineageArtifactIds].reverse()) {
      const historical = activations.filter((activation) => activation.artifactId === artifactId);
      if (historical.length === 0) continue;
      if (historical.length !== 1) return { ok: false, error: 'ambiguous_prompt_replacement_history', nextAction: 'inspect the bound historical artifact and activation before retrying' };
      const [target] = historical;
      if (target !== undefined) matches.push({ supersededActivationId: target.activationId, supersededArtifactId: target.artifactId });
      break;
    }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `ambiguous_prompt_replacement: ${matches.length} live prompt activations match this revision (${matches.map((m) => m.supersededActivationId).join(', ')})`,
      nextAction: 'deactivate the stale versions manually, then retry the approval — replacement never migrates history in bulk',
    };
  }
  return { ok: true, target: matches[0] ?? null };
}

export interface OwnerRevisionArtifactDraft {
  artifactId: string;
  sourceTaskId: string;
  sourcePrincipleId?: string;
  lineageArtifactIds: string[];
  contentJson: string;
}

export type OwnerRevisionBuildResult =
  | { ok: true; draft: OwnerRevisionArtifactDraft; oldStatement: string; title: string; intentContract?: unknown }
  | { ok: false; error: string; nextAction: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build the new artifact version for an Owner-submitted statement. The old
 * approved artifact stays immutable (untouched); the new version carries
 * lineage back to it and keeps every non-statement field — the intent fields
 * are preserved verbatim and returned for the reviewable diff (the Owner is
 * the semantic judge of intent consistency; the validator enforces the
 * structural content contract).
 */
export async function buildOwnerRevisionArtifact(input: {
  oldArtifact: PIArtifactSnapshot;
  newStatement: string;
  editedBy: string;
  now: string;
}): Promise<OwnerRevisionBuildResult> {
  const { oldArtifact, newStatement, editedBy, now } = input;
  const trimmed = newStatement.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'statement_empty', nextAction: 'provide a non-empty replacement statement' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(oldArtifact.contentJson);
  } catch {
    return { ok: false, error: 'old_artifact_content_unparseable', nextAction: 'repair the old artifact content before creating a revision' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: 'old_artifact_content_malformed', nextAction: 'repair the old artifact content before creating a revision' };
  }
  const oldDraft = isRecord(parsed.principleDraft) ? parsed.principleDraft : null;
  const oldStatement = typeof oldDraft?.statement === 'string' ? oldDraft.statement : '';
  if (oldStatement === '') {
    return { ok: false, error: 'old_artifact_missing_statement', nextAction: 'the old artifact has no principleDraft.statement to replace' };
  }
  if (typeof parsed.text === 'string' && parsed.text.length > 0 && parsed.text !== oldStatement) {
    return { ok: false, error: 'old_artifact_ambiguous_statement', nextAction: 'review the conflicting text and principleDraft.statement; the old artifact remains unchanged' };
  }
  if (trimmed === oldStatement.trim()) {
    return { ok: false, error: 'statement_unchanged', nextAction: 'the replacement statement must differ from the current one' };
  }

  // New task identity: the (source_task_id, artifact_kind) UNIQUE index makes
  // same-task upsert an OVERWRITE of the old approved artifact — forbidden.
  // The suffix must stay URL-safe: artifact ids flow into approval ids
  // (`apr_prompt_<artifactId>`) and from there into Console route paths.
  const revisionSuffix = `ownerrev-${randomUUID()}`;
  const sourceTaskId = `${oldArtifact.sourceTaskId}-${revisionSuffix}`;
  const artifactId = `pi-art-${sourceTaskId}`;

  const revisedContent: Record<string, unknown> = { ...parsed };
  // The production reader prefers top-level text. Remove an identical legacy
  // alias only in the new version so statement remains the execution authority.
  delete revisedContent.text;
  revisedContent.principleDraft = {
    ...(oldDraft ?? {}),
    statement: trimmed,
  };
  revisedContent.taskId = sourceTaskId;
  revisedContent.generatedAt = now;
  // Trace the Owner edit inside the artifact's own risk notes (append-only
  // style — never rewrite existing fields other than the statement/task bookkeeping).
  const risks = Array.isArray(parsed.risks) && parsed.risks.every((r) => typeof r === 'string')
    ? [...(parsed.risks)]
    : [];
  risks.push(`owner-edited statement (${editedBy}, ${now}): revision of ${oldArtifact.artifactId} for prompt capacity`);
  revisedContent.risks = risks;

  // Reuse the REAL content validation contract — taskId must match the new
  // draft's task identity; every structural requirement applies as for a
  // scribe run. A failure means NO artifact is persisted by the caller.
  const validation = await new DefaultScribeValidator().validate(revisedContent, sourceTaskId);
  if (!validation.valid) {
    return {
      ok: false,
      error: `revision_validation_failed: ${validation.errors.slice(0, 5).join('; ')}`,
      nextAction: 'fix the revision content so it satisfies the scribe output contract (title/rationale/applicability/intentContract must stay intact)',
    };
  }

  return {
    ok: true,
    draft: {
      artifactId,
      sourceTaskId,
      ...(oldArtifact.sourcePrincipleId !== undefined ? { sourcePrincipleId: oldArtifact.sourcePrincipleId } : {}),
      lineageArtifactIds: [...oldArtifact.lineageArtifactIds, oldArtifact.artifactId],
      contentJson: JSON.stringify(revisedContent),
    },
    oldStatement,
    title: typeof oldDraft?.title === 'string' ? oldDraft.title : '',
    intentContract: revisedContent.intentContract,
  };
}

/** Stable digest helper for revision payloads (audit/lineage display). */
export function revisionDigest(contentJson: string): string {
  return `sha256:${createHash('sha256').update(contentJson, 'utf8').digest('hex')}`;
}
