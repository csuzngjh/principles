import type { ActivationStatusRecord } from './activation-types.js';

export const RUNTIME_V2_PRINCIPLE_BUDGET = 2000;

export interface ActivatedPrinciple {
  principleId: string;
  text: string;
  artifactId: string;
  activationId: string;
}

export interface PromptActivationReaderResult {
  principles: ActivatedPrinciple[];
  warnings: string[];
  source: 'runtime_v2';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonParse(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function filterPromptActivations(
  activations: ActivationStatusRecord[],
): ActivationStatusRecord[] {
  return activations.filter(
    (a) => a.channel === 'prompt' && a.action === 'prompt_activate',
  );
}

export function resolvePrincipleFromArtifact(
  artifactRow: unknown,
  activation: ActivationStatusRecord,
): { ok: true; principle: ActivatedPrinciple } | { ok: false; warning: string } {
  if (!isRecord(artifactRow)) {
    return { ok: false, warning: `artifact_query_unexpected: artifactId=${activation.artifactId}; nextAction=check_pi_artifacts_table` };
  }

  const artifact_id = Object.hasOwn(artifactRow, 'artifact_id') && typeof artifactRow.artifact_id === 'string' && artifactRow.artifact_id.length > 0 ? artifactRow.artifact_id : null;
  const artifact_kind = Object.hasOwn(artifactRow, 'artifact_kind') && typeof artifactRow.artifact_kind === 'string' ? artifactRow.artifact_kind : null;
  const raw_content_json = Object.hasOwn(artifactRow, 'content_json') && typeof artifactRow.content_json === 'string' ? artifactRow.content_json : null;
  const validation_status = Object.hasOwn(artifactRow, 'validation_status') && typeof artifactRow.validation_status === 'string' ? artifactRow.validation_status : null;

  if (!artifact_id) {
    return { ok: false, warning: `artifact_not_found: artifactId=${activation.artifactId} activationId=${activation.activationId}; nextAction=verify_artifact_exists_or_remove_stale_activation` };
  }

  if (artifact_kind !== 'principle') {
    return { ok: false, warning: `artifact_not_principle: artifactId=${artifact_id} kind=${artifact_kind ?? 'missing'}; nextAction=skip_non_principle_activations` };
  }

  if (validation_status !== 'validated') {
    return { ok: false, warning: `artifact_not_validated: artifactId=${artifact_id} status=${validation_status ?? 'missing'}; nextAction=skip_unvalidated_artifacts` };
  }

  if (raw_content_json === null) {
    return { ok: false, warning: `artifact_missing_content_json: artifactId=${artifact_id}; nextAction=ensure_artifact_has_content_json` };
  }

  const parsed = safeJsonParse(raw_content_json);
  if (parsed === null) {
    return { ok: false, warning: `artifact_content_json_parse_error: artifactId=${activation.artifactId} reason=invalid_json; nextAction=fix_artifact_content_json` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, warning: `artifact_content_malformed: artifactId=${activation.artifactId} reason=parsed_to_non_object; nextAction=fix_artifact_content_json` };
  }

  const principleId = Object.hasOwn(parsed, 'principleId') && typeof parsed.principleId === 'string' ? parsed.principleId : undefined;
  const text = Object.hasOwn(parsed, 'text') && typeof parsed.text === 'string' ? parsed.text : undefined;

  const draftObj = Object.hasOwn(parsed, 'principleDraft') && isRecord(parsed.principleDraft) ? parsed.principleDraft : null;
  const draftTitle = draftObj && Object.hasOwn(draftObj, 'title') && typeof draftObj.title === 'string' ? draftObj.title : undefined;
  const draftStatement = draftObj && Object.hasOwn(draftObj, 'statement') && typeof draftObj.statement === 'string' ? draftObj.statement : undefined;

  const resolvedPrincipleId = principleId && principleId.length > 0 ? principleId : draftTitle;
  const resolvedText = text && text.length > 0 ? text : draftStatement;

  if (!resolvedPrincipleId || resolvedPrincipleId.length === 0) {
    return { ok: false, warning: `artifact_missing_principle_id: artifactId=${activation.artifactId}; nextAction=ensure_artifact_has_principleId_or_principleDraft_title` };
  }

  if (!resolvedText || resolvedText.length === 0) {
    return { ok: false, warning: `artifact_missing_text: artifactId=${activation.artifactId} principleId=${resolvedPrincipleId}; nextAction=ensure_artifact_has_text_or_principleDraft_statement` };
  }

  return {
    ok: true,
    principle: {
      principleId: resolvedPrincipleId,
      text: resolvedText,
      artifactId: activation.artifactId,
      activationId: activation.activationId,
    },
  };
}

export function trimToBudget(
  principles: ActivatedPrinciple[],
  budget: number,
  escapeFn: (s: string) => string = (s) => s,
): { lines: string[]; injectedIds: Set<string>; truncated: boolean } {
  const lines: string[] = [];
  const injectedIds = new Set<string>();
  let remaining = budget;
  let truncated = false;

  const header = 'Runtime V2 activated principles (owner-approved):';
  lines.push(header);
  remaining -= header.length;

  for (const p of principles) {
    const entry = `- [${escapeFn(p.principleId)}] ${escapeFn(p.text)}`;
    if (remaining < entry.length + 1) {
      truncated = true;
      break;
    }
    lines.push(entry);
    remaining -= entry.length + 1;
    injectedIds.add(p.principleId);
  }

  return { lines, injectedIds, truncated };
}

export function renderPrinciplesToDirectives(
  principles: { principleId: string; text: string; artifactId: string; activationId: string }[],
  injectedIds: Set<string>,
  escapeFn: (s: string) => string = (s) => s,
): string {
  if (injectedIds.size === 0) return '';

  const directiveLines: string[] = [];
  directiveLines.push('');
  directiveLines.push('## 【OWNER-APPROVED BEHAVIOR DIRECTIVES】');
  directiveLines.push('');
  directiveLines.push('Owner-approved behavior directives are active operating constraints learned from prior owner corrections.');
  directiveLines.push('These directives are mandatory for this session unless they conflict with safety, security, or higher-priority system policy.');
  directiveLines.push('For ambiguous coding or file-changing tasks, follow these directives before using mutating tools.');
  directiveLines.push('');
  for (const p of principles) {
    if (!injectedIds.has(p.principleId)) continue;
    directiveLines.push(`<directive id="${escapeFn(p.principleId)}" source="runtime_v2_activation">`);
    directiveLines.push(`MANDATORY: ${escapeFn(p.text)}`);
    directiveLines.push('Apply this as an active behavior constraint. Do not treat this as background context.');
    directiveLines.push('</directive>');
    directiveLines.push('');
  }
  directiveLines.push('Note: These directives do not override safety, security, or core system policy.');
  return directiveLines.join('\n');
}
